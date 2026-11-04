import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { COMPUTER_TOOL_DESCRIPTOR, runComputerTool, type ComputerToolContext } from "./native-computer-tool.ts";
import { NativeComputerCapabilityProvider } from "./native-computer-capability-provider.ts";
import type { CapabilityCall, CapabilityGrant } from "./contracts.ts";

let root: string;
let ctx: ComputerToolContext;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nct-")); ctx = { root }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
  return { callId: "c1", capabilityId: "computer_exec", runId: "r1", arguments: args, botId: "b1", threadId: "t1" } as unknown as CapabilityCall;
}

function context(gr: CapabilityGrant = grant()) {
  return { grant: gr, signal: new AbortController().signal } as { readonly grant: CapabilityGrant; readonly signal: AbortSignal };
}

describe("native computer tool", () => {
  it("runs echo and captures stdout", async () => {
    const result = await runComputerTool(ctx, { command: "echo hello" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("hello");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit", async () => {
    const result = await runComputerTool(ctx, { command: "ls /nonexistent-dir-xyz-12345" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("supports pipes", async () => {
    const result = await runComputerTool(ctx, { command: "printf 'a b c' | tr ' ' '\\n' | wc -l" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("2");
  });

  it("runs in workspace cwd by default", async () => {
    const result = await runComputerTool(ctx, { command: "pwd" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(root);
  });

  it("honors cwd inside workspace", async () => {
    const sub = join(root, "sub");
    await import("node:fs").then((fs) => fs.mkdirSync(sub, { recursive: true }));
    const result = await runComputerTool(ctx, { command: "pwd", cwd: "sub" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(sub);
  });

  it("blocks path traversal via cwd", async () => {
    const result = await runComputerTool(ctx, { command: "pwd", cwd: "../../etc" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(root);
    expect(result.content).not.toContain("/etc");
  });

  it("blocks absolute cwd outside workspace", async () => {
    const result = await runComputerTool(ctx, { command: "pwd", cwd: "/etc" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain(root);
    expect(result.content).not.toContain("/etc");
  });

  it("strips control-plane env from child process", async () => {
    const rootCtx: ComputerToolContext = { root, env: { ...process.env, API_KEY: "secret123", TOKEN: "abc123", SECRET_KEY: "s3cr3t" } };
    const result = await runComputerTool(rootCtx, { command: "printf 'API_KEY=[%s] TOKEN=[%s] SECRET_KEY=[%s]' \"$API_KEY\" \"$TOKEN\" \"$SECRET_KEY\"" });
    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("secret123");
    expect(result.content).not.toContain("abc123");
    expect(result.content).not.toContain("s3cr3t");
  });

  it("times out a long-running command", async () => {
    const result = await runComputerTool(ctx, { command: "sleep 10", timeout_ms: 1000 });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("timed out");
  });

  it("rejects empty command", async () => {
    const result = await runComputerTool(ctx, { command: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("command is required");
  });
});

describe("NativeComputerCapabilityProvider", () => {
  it("lists computer_exec descriptor with write risk and sideEffect", () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const descs = provider.list(grant());
    expect(descs.length).toBe(1);
    expect(descs[0].id).toBe("native:computer");
    expect(descs[0].name).toBe("computer_exec");
    expect(descs[0].risk).toBe("write");
    expect(descs[0].sideEffect).toBe(true);
    expect(descs[0].timeoutMs).toBe(COMPUTER_TOOL_DESCRIPTOR.timeoutMs);
  });

  it("denied grant blocks list and invoke", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const denied = grant({ denied: ["native:computer"] });
    expect(provider.list(denied)).toEqual([]);
    const result = await provider.invoke(call({ command: "echo hi" }), context(denied));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("denied");
  });

  it("allow-list grant gates list", () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const allowed = grant({ allowed: ["bash"] });
    expect(provider.list(allowed)).toEqual([]);
  });

  it("invoke succeeds when allowed", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const result = await provider.invoke(call({ command: "echo provider-ok" }), context());
    expect(result.ok).toBe(true);
    expect(result.content).toContain("provider-ok");
  });

  it("invoke validates missing command", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const result = await provider.invoke(call({ command: "   " }), context());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("command is required");
  });

  it("invoke validates bad timeout_ms", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const result = await provider.invoke(call({ command: "echo hi", timeout_ms: 5 }), context());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("timeout_ms");
  });

  it("invoke respects abort signal", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    const controller = new AbortController();
    const promise = provider.invoke(call({ command: "sleep 10" }), { grant: grant(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100).unref();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/interrupted|timed out|abort/i);
  });

  it("mount resolves when workspace exists", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    await expect(provider.mount()).resolves.toBeUndefined();
  });

  it("mount resolves even when workspace missing (lazy)", async () => {
    const missingCtx: ComputerToolContext = { root: join(root, "does-not-exist") };
    const provider = new NativeComputerCapabilityProvider(missingCtx);
    await expect(provider.mount()).resolves.toBeUndefined();
  });

  it("close sets closed flag so list returns empty", async () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    await provider.close();
    expect(provider.list(grant())).toEqual([]);
  });

  it("describe returns a string", () => {
    const provider = new NativeComputerCapabilityProvider(ctx);
    expect(typeof provider.describe()).toBe("string");
    expect(provider.describe().length).toBeGreaterThan(0);
  });
});
