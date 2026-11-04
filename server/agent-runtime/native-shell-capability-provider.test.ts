import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runShellTool, type ShellToolContext } from "./native-shell-tool.ts";
import { NativeShellCapabilityProvider } from "./native-shell-capability-provider.ts";
import type { CapabilityCall, CapabilityGrant } from "./contracts.ts";

let root: string;
let ctx: ShellToolContext;
beforeEach(() => {
  const fs = require("node:fs");
  root = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "nshp-"));
  ctx = {
    root,
    spawnBoxed: async (command, _cwd, _env, options) => runShellTool({ root }, { command, timeout: options?.timeoutMs }, options?.signal),
  };
});
afterEach(() => {
  const fs = require("node:fs");
  fs.rmSync(root, { recursive: true, force: true });
});

function grant(overrides: { allowed?: string[]; denied?: string[] } = {}) {
  return {
    botId: "b1",
    threadId: "t1",
    approvalMode: "full" as const,
    allowed: new Set(overrides.allowed ?? []),
    denied: new Set(overrides.denied ?? []),
  } as unknown as CapabilityGrant;
}

function call(args: Record<string, unknown>) {
  return { callId: "c1", capabilityId: "bash", runId: "r1", arguments: args, botId: "b1", threadId: "t1" } as unknown as CapabilityCall;
}

function context(gr: CapabilityGrant = grant()) {
  return { grant: gr, signal: new AbortController().signal } as { readonly grant: CapabilityGrant; readonly signal: AbortSignal };
}

describe("NativeShellCapabilityProvider", () => {
  it("lists bash descriptor with write risk and sideEffect", () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const descs = provider.list(grant());
    expect(descs.length).toBe(1);
    expect(descs[0].id).toBe("bash");
    expect(descs[0].name).toBe("bash");
    expect(descs[0].risk).toBe("write");
    expect(descs[0].sideEffect).toBe(true);
  });

  it("denied grant blocks list and invoke", async () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const denied = grant({ denied: ["bash"] });
    expect(provider.list(denied)).toEqual([]);
    const result = await provider.invoke(call({ command: "echo hi" }), context(denied));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("denied");
  });

  it("allow-list grant gates list", () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const allowed = grant({ allowed: ["git"] });
    expect(provider.list(allowed)).toEqual([]);
  });

  it("invoke succeeds when allowed", async () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const result = await provider.invoke(call({ command: "echo provider-ok" }), context());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("provider-ok");
  });

  it("invoke validates missing command", async () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const result = await provider.invoke(call({ command: "   " }), context());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("command is required");
  });

  it("invoke respects abort signal", async () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    const controller = new AbortController();
    const promise = provider.invoke(call({ command: "sleep 10" }), { grant: grant(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100).unref();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/interrupted|timed out|abort/i);
  });

  it("fail closed: no OS sandbox means bash is not offered or executed", async () => {
    const unboxedCtx: ShellToolContext = { root };
    const provider = new NativeShellCapabilityProvider(unboxedCtx);
    expect(provider.list(grant())).toEqual([]);
    const result = await provider.invoke(call({ command: "echo hi" }), context());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("isolation_unavailable");
    expect(result.content).toContain("not isolated");
    await provider.close();
  });

  it("runShellTool falls back to direct spawn when no sandbox runner is provided", async () => {
    const direct = await runShellTool({ root }, { command: "echo direct-ok" });
    expect(direct.ok).toBe(true);
    expect(direct.content).toContain("direct-ok");
  });

  it("describe returns a string", () => {
    const provider = new NativeShellCapabilityProvider(ctx);
    expect(typeof provider.describe()).toBe("string");
    expect(provider.describe().length).toBeGreaterThan(0);
  });
});
