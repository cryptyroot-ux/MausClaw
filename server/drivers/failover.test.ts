import { describe, it, expect } from "vitest";
import { failoverKind, failoverHold, SERVER_HOLD_MS, CONTEXT_HOLD_MS, MODEL_HOLD_MS } from "./failover.ts";
import { classifyError, HttpStatusError } from "./retry.ts";

describe("failoverKind", () => {
  const state = { aborted: false, produced: false };

  it("returns null when the turn was aborted", () => {
    expect(failoverKind(new Error("down"), { aborted: true, produced: false })).toBeNull();
  });

  it("returns null when output was already produced", () => {
    expect(failoverKind(new Error("down"), { aborted: false, produced: true })).toBeNull();
  });

  it("returns context when tooLarge is set", () => {
    expect(failoverKind(new Error("overflow"), { aborted: false, produced: false, tooLarge: true })).toBe("context");
  });

  it("returns quota for quota-classified errors", () => {
    const err = new HttpStatusError("You've hit your weekly limit", 429);
    expect(classifyError(err)).toEqual({ transient: false, reason: "quota" });
    expect(failoverKind(err, state)).toBe("quota");
  });

  it("returns auth for 401/403 errors", () => {
    expect(failoverKind(new HttpStatusError("unauthorized", 401), state)).toBe("auth");
    expect(failoverKind(new HttpStatusError("forbidden", 403), state)).toBe("auth");
  });

  it("returns server for transient 5xx / rate_limited / overloaded errors", () => {
    expect(failoverKind(new HttpStatusError("internal server error", 500), state)).toBe("server");
    expect(failoverKind(new HttpStatusError("rate limited", 429), state)).toBe("server");
    expect(failoverKind(new Error("service overloaded"), state)).toBe("server");
  });

  it("returns model for unknown_model / not_found 404", () => {
    expect(failoverKind(new Error("unknown model: foo"), state)).toBe("model");
    expect(failoverKind(new HttpStatusError("thread gone", 404), state)).toBe("model");
  });

  it("returns null for client errors 400/422", () => {
    expect(failoverKind(new HttpStatusError("invalid request", 400), state)).toBeNull();
    expect(failoverKind(new HttpStatusError("unprocessable", 422), state)).toBeNull();
  });
});

describe("failoverHold", () => {
  const now = Date.now();

  it("quota holds the engine", () => {
    expect(failoverHold("quota")).toEqual({ limit: "engine" });
  });

  it("auth stops with auth_required", () => {
    expect(failoverHold("auth")).toEqual({ stopReason: "auth_required" });
  });

  it("server holds the model until SERVER_HOLD_MS", () => {
    expect(failoverHold("server", now)).toEqual({ limit: "model", limitResetsAt: now + SERVER_HOLD_MS });
  });

  it("context holds the model until CONTEXT_HOLD_MS", () => {
    expect(failoverHold("context", now)).toEqual({ limit: "model", limitResetsAt: now + CONTEXT_HOLD_MS });
  });

  it("model holds the model until MODEL_HOLD_MS", () => {
    expect(failoverHold("model", now)).toEqual({ limit: "model", limitResetsAt: now + MODEL_HOLD_MS });
  });
});
