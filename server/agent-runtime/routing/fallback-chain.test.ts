import { describe, it, expect } from "vitest";
import { FallbackChain } from "./fallback-chain.ts";
import { HttpStatusError } from "../../drivers/retry.ts";

describe("FallbackChain", () => {
  it("returns result from primary model on success", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      return { ok: true, model };
    });
    const result = await chain.execute("primary", ["fallback1", "fallback2"]);
    expect(result).toEqual({ ok: true, model: "primary" });
    expect(calls).toEqual(["primary"]);
  });

  it("tries fallbacks when primary returns failure", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      if (model === "primary") return { ok: false, error: "boom" };
      return { ok: true, model };
    });
    const result = await chain.execute("primary", ["fallback1", "fallback2"]);
    expect(result).toEqual({ ok: true, model: "fallback1" });
    expect(calls).toEqual(["primary", "fallback1"]);
  });

  it("tries fallbacks when primary throws", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      if (model === "primary") throw new Error("down");
      return { ok: true, model };
    });
    const result = await chain.execute({ primary: { model: "primary", estimatedCost: 0 } as any, fallbacks: ["fb1"] });
    expect(result).toEqual({ ok: true, model: "fb1" });
    expect(calls).toEqual(["primary", "fb1"]);
  });

  it("throws when all models fail", async () => {
    const chain = new FallbackChain(async () => {
      throw new Error("down");
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow("down");
  });

  it("tracks lastSucceededModel", async () => {
    const chain = new FallbackChain(async (model) => {
      if (model === "primary") return { ok: false, error: "boom" };
      return { ok: true, model };
    });
    await chain.execute("primary", ["fb1"]);
    expect(chain.lastSucceededModel).toBe("fb1");
  });

  it("stops entirely on auth-required failover without dispatching models", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      throw new HttpStatusError("unauthorized", 401);
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow();
    expect(chain.lastFailoverHold?.stopReason).toBe("auth_required");
    calls.length = 0;
    // Next turn: auth stop throws before any model is dispatched.
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow("auth required");
    expect(calls).toEqual([]);
  });

  it("stops entirely on engine-wide quota hold on the next turn", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      throw new HttpStatusError("You've hit your weekly limit", 429);
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow();
    expect(chain.lastFailoverHold?.limit).toBe("engine");
    calls.length = 0;
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow("engine-wide hold");
    expect(calls).toEqual([]);
  });

  it("skips every model while a model failover cooldown is active", async () => {
    const calls: string[] = [];
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      throw new HttpStatusError("service overloaded", 500);
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow();
    expect(chain.lastFailoverHold?.limit).toBe("model");
    calls.length = 0;
    // Next turn: cooldown active, no model is dispatched.
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow("Fallback chain exhausted");
    expect(calls).toEqual([]);
  });

  it("dispatches models again after the failover cooldown expires", async () => {
    const calls: string[] = [];
    let failAll = true;
    const chain = new FallbackChain(async (model) => {
      calls.push(model);
      if (failAll || model === "primary") throw new HttpStatusError("service overloaded", 500);
      return { ok: true, model };
    });
    await expect(chain.execute("primary", ["fb1"])).rejects.toThrow();
    expect(chain.lastFailoverHold?.limit).toBe("model");
    // Force the hold into the past so the cooldown is expired.
    chain.lastFailoverHold = { limit: "model", limitResetsAt: Date.now() - 1 };
    calls.length = 0;
    failAll = false;
    const result = await chain.execute("primary", ["fb1"]);
    expect(result).toEqual({ ok: true, model: "fb1" });
    expect(calls).toContain("fb1");
  });
});
