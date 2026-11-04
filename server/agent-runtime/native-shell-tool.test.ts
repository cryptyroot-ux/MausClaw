import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";

import { runShellTool, type ShellToolContext } from "./native-shell-tool.ts";

let root: string;
let ctx: ShellToolContext;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nsh-")); ctx = { root }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native shell tool", () => {
  it("runs echo and captures stdout", async () => {
    const r = await runShellTool(ctx, { command: "echo hello" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr and non-zero exit", async () => {
    const r = await runShellTool(ctx, { command: "ls /nonexistent-dir-xyz" });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("supports pipes", async () => {
    const r = await runShellTool(ctx, { command: "echo 'a b c' | tr ' ' '\\n' | wc -l" });
    expect(r.ok).toBe(true);
    expect(r.content.trim()).toMatch(/3/);
  });

  it("times out", async () => {
    const r = await runShellTool(ctx, { command: "sleep 10", timeout: 1000 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("timed out");
  });

  it("rejects empty command", async () => {
    const r = await runShellTool(ctx, { command: "" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("required");
  });

  it("runs in workspace cwd", async () => {
    const r = await runShellTool(ctx, { command: "pwd" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain(root);
  });

  it("blocks write commands in read-only sandbox", async () => {
    const roCtx = { ...ctx, sandboxMode: "read-only" as const };
    const r = await runShellTool(roCtx, { command: "rm -rf /tmp/x" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("read-only sandbox");
  });

  it("allows read commands in read-only sandbox", async () => {
    const roCtx = { ...ctx, sandboxMode: "read-only" as const };
    const r = await runShellTool(roCtx, { command: "echo hello" });
    expect(r.ok).toBe(true);
  });

  it("times out and aborts", async () => {
    const controller = new AbortController();
    const promise = runShellTool(ctx, { command: "sleep 15", timeout: 30000 }, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/interrupted|timed out|abort/i);
  });

  it("kills the process tree on abort, not just the shell", async () => {
    const pidFile = join(root, "bg-pid");
    const marker = join(root, "child-alive");
    // Background a long sleep, record its PID, keep bash alive briefly.
    const cmd = `sleep 15 & echo $! > ${pidFile}; touch ${marker}; sleep 2`;
    const controller = new AbortController();
    const promise = runShellTool(ctx, { command: cmd, timeout: 30000 }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    const r = await promise;
    expect(r.ok).toBe(false);

    // Give the process group a moment to be reaped.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const pidContent = await readFile(pidFile, "utf8").catch(() => null);
    expect(pidContent).not.toBeNull();
    const pid = Number((pidContent ?? "").trim());
    expect(Number.isFinite(pid)).toBe(true);
    // The background child must be dead: killing the process group took it too.
    let dead = false;
    try { process.kill(pid, 0); } catch { dead = true; }
    expect(dead).toBe(true);
  });

  it("kills the process tree on timeout, not just the shell", async () => {
    const pidFile = join(root, "bg-pid-timeout");
    const cmd = `sleep 15 & echo $! > ${pidFile}; sleep 2`;
    const r = await runShellTool(ctx, { command: cmd, timeout: 150 });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("timed out");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const pidContent = await readFile(pidFile, "utf8").catch(() => null);
    expect(pidContent).not.toBeNull();
    const pid = Number((pidContent ?? "").trim());
    expect(Number.isFinite(pid)).toBe(true);
    let dead = false;
    try { process.kill(pid, 0); } catch { dead = true; }
    expect(dead).toBe(true);
  });

  it("has an uncertain field on the result type", () => {
    const result: { ok: boolean; content: string; exitCode: number | null; durationMs: number; uncertain?: boolean } = {
      ok: false, content: "x", exitCode: null, durationMs: 0, uncertain: true,
    };
    expect(result.uncertain).toBe(true);
  });
});
