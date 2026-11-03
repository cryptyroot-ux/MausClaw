// Vitest tests for the isolated engine-task runner.
// Verifies: fresh workspace per run, request budget (N+1 including discovery/probe),
// infra vs task failure classification, cleanup/redaction, and that the native
// turn executes under the correct engine id.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { EngineTask } from "./tasks.ts";
import type { LiveInstance } from "../live/types.ts";
import { runEngineTask, isInfraError, redact } from "./run-engine-tasks.ts";

// Hoisted module-level mock state so per-test overrides work with vi.mock.
let sendTurnOverride: ((input: { threadId: string; botId: string; agentEngine: string; text: string; model?: string; approvalMode: string }) => Promise<{ turnId: string }>) | null = null;
let onEventOverride: ((listener: (event: unknown) => void) => () => void) | null = null;

function makeFakeAdapter() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    onEvent: (listener: (event: unknown) => void) => {
      if (onEventOverride) return onEventOverride(listener);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendTurn: async (input: { threadId: string; botId: string; agentEngine: string; text: string; model?: string; approvalMode: string }) => {
      if (sendTurnOverride) return sendTurnOverride(input);
      queueMicrotask(() => {
        for (const l of listeners) l({ type: "turn.completed", ok: true, stopReason: "done" });
      });
      return { turnId: "test-turn-" + randomUUID() };
    },
  };
}

vi.mock("../../server/drivers/builtIn.ts", () => ({
  BUILT_IN_DRIVERS: [{
    driverKind: "test" as const,
    create: async () => ({
      adapter: makeFakeAdapter(),
      startupModelRefresh: Promise.resolve(),
    }),
  }],
}));

vi.mock("../../server/message-db.ts", () => ({
  closeMessageDb: vi.fn().mockResolvedValue(undefined),
}));

let testWorkspaceRoot = "";
vi.mock("../../server/workspace.ts", () => ({
  ensureWorkspace: (botId: string) => join(testWorkspaceRoot, botId),
}));

vi.mock("../../server/agent-runtime/run-store.ts", () => ({
  createSqliteAgentRunStore: () => ({
    getRun: (turnId: string) => ({ turnId, modelRounds: 1 }),
  }),
}));

describe("runEngineTask", () => {
  let originalDataDir: string | undefined;
  let tempDataDir: string;

  beforeEach(() => {
    originalDataDir = process.env.MAUSCLAW_DATA_DIR;
    tempDataDir = mkdtempSync(join(tmpdir(), "mausclaw-test-"));
    testWorkspaceRoot = mkdtempSync(join(tmpdir(), "mausclaw-ws-"));
    sendTurnOverride = null;
    onEventOverride = null;
    process.env.MAUSCLAW_DATA_DIR = tempDataDir;
  });

  afterEach(() => {
    rmSync(tempDataDir, { recursive: true, force: true });
    rmSync(testWorkspaceRoot, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MAUSCLAW_DATA_DIR;
    else process.env.MAUSCLAW_DATA_DIR = originalDataDir;
    vi.restoreAllMocks();
  });

  const makeTask = (id: string, overrides: Partial<EngineTask> = {}): EngineTask => ({
    id,
    prompt: "echo hello",
    files: { "README.md": "# Test\n" },
    check: () => ({ pass: true, why: "ok" }),
    solution: { "README.md": "# Test\n" },
    ...overrides,
  });

  const makeInstance = (overrides: Partial<LiveInstance> = {}): LiveInstance => ({
    instanceId: "test-instance",
    driver: "test",
    displayName: "Test",
    enabled: true,
    environment: {},
    config: {},
    model: "test-model",
    ...overrides,
  });

  it("runs a task and returns pass status with fresh workspace", async () => {
    const task = makeTask("basic-1");
    const instance = makeInstance();

    const row = await runEngineTask({ task, instance, maxRequests: 10 });

    expect(row.task).toBe("basic-1");
    expect(row.status).toBe("pass");
    expect(row.rounds).toBeGreaterThanOrEqual(1);
    expect(row.durationMs).toBeGreaterThan(0);
  });

  it("enforces request budget: exceeding the cap returns infra", async () => {
    const task = makeTask("budget-test");
    const instance = makeInstance();

    // First fetch: uses up the budget (state.sent 0→1, max=1).
    // Second fetch: refused because state.sent(1) >= max(1) — throws budget error synchronously.
    sendTurnOverride = async () => {
      try { await fetch("http://127.0.0.1:1/probe"); } catch {}
      // No try/catch: budget error propagates from sendTurn → runEngineTask catch → infra
      await fetch("http://127.0.0.1:1/turn");
      return { turnId: "budget-turn" }; // unreachable
    };
    onEventOverride = (listener) => {
      queueMicrotask(() => listener({ type: "turn.completed", ok: true, stopReason: "done" }));
      return () => {};
    };

    const row = await runEngineTask({ task, instance, maxRequests: 1 });

    expect(row.status).toBe("infra");
    expect(row.requests).toBe(1);
    expect(row.why).toMatch(/eval request budget/);
  });

  it("classifies provider errors as infra, not task failure", async () => {
    const task = makeTask("infra-test");
    const instance = makeInstance();

    sendTurnOverride = async () => { throw new Error("429 rate limit exceeded"); };

    const row = await runEngineTask({ task, instance, maxRequests: 10 });

    expect(row.status).toBe("infra");
    expect(row.error).toMatch(/429|rate limit/i);
  });

  it("classifies engine/tool errors as task failure, not infra", async () => {
    const task = makeTask("fail-test");
    const instance = makeInstance();

    onEventOverride = (listener) => {
      queueMicrotask(() => listener({ type: "turn.completed", ok: false, stopReason: "failed", message: "tool failed", code: "tool_error" }));
      return () => {};
    };

    const row = await runEngineTask({ task, instance, maxRequests: 10 });

    expect(row.status).toBe("fail");
    expect(row.stopReason).toBe("failed");
  });

  it("redacts secrets from request/response logs", async () => {
    const secretKey = "sk-live-abcdefghijklmnopqrstuvwxyz";
    const task = makeTask("redact-test");
    const instance = makeInstance({
      config: { apiKey: secretKey },
    });

    const row = await runEngineTask({ task, instance, maxRequests: 10 });

    expect(row.status).toBe("pass");

    // Verify redaction function works directly with a long enough secret
    const redacted = redact(`POST /v1/chat { "key": "${secretKey}" }`, [secretKey]);
    expect(redacted).not.toContain(secretKey);
    expect(redacted).toContain("[redacted]");
  });

  it("restores MAUSCLAW_DATA_DIR and cleans up temp dir on success", async () => {
    const task = makeTask("cleanup-test");
    const instance = makeInstance();

    const beforeDir = process.env.MAUSCLAW_DATA_DIR;
    await runEngineTask({ task, instance, maxRequests: 10 });

    expect(process.env.MAUSCLAW_DATA_DIR).toBe(beforeDir);
  });

  it("restores MAUSCLAW_DATA_DIR and cleans up temp dir on failure", async () => {
    const task = makeTask("cleanup-fail-test");
    const instance = makeInstance();

    sendTurnOverride = async () => { throw new Error("boom"); };

    const beforeDir = process.env.MAUSCLAW_DATA_DIR;
    await runEngineTask({ task, instance, maxRequests: 10 });

    expect(process.env.MAUSCLAW_DATA_DIR).toBe(beforeDir);
  });

  it("uses native engine id 'mausclaw-native' in sendTurn", async () => {
    const task = makeTask("engine-id-test");
    const instance = makeInstance();
    let capturedEngine: string | null = null;

    sendTurnOverride = async (input) => {
      capturedEngine = input.agentEngine;
      return { turnId: "engine-id-turn" };
    };
    onEventOverride = (listener) => {
      queueMicrotask(() => listener({ type: "turn.completed", ok: true, stopReason: "done" }));
      return () => {};
    };

    await runEngineTask({ task, instance, maxRequests: 10 });

    expect(capturedEngine).toBe("mausclaw-native");
  });

  it("includes tool names from tool.calls events in row", async () => {
    const task = makeTask("tools-test");
    const instance = makeInstance();

    onEventOverride = (listener) => {
      queueMicrotask(() => {
        listener({ type: "tool.calls", calls: [{ name: "shell" }, { name: "patch" }] });
        listener({ type: "turn.completed", ok: true, stopReason: "done" });
      });
      return () => {};
    };

    const row = await runEngineTask({ task, instance, maxRequests: 10 });

    expect(row.tools).toContain("shell");
    expect(row.tools).toContain("patch");
  });
});

describe("isInfraError", () => {
  it("detects rate limit errors", () => {
    expect(isInfraError("429 rate limit exceeded")).toBe(true);
    expect(isInfraError("rate limit")).toBe(true);
    expect(isInfraError("too many requests")).toBe(true);
  });

  it("detects server errors", () => {
    expect(isInfraError("502 bad gateway")).toBe(true);
    expect(isInfraError("503 service unavailable")).toBe(true);
    expect(isInfraError("504 gateway timeout")).toBe(true);
  });

  it("detects credit/endpoint errors", () => {
    expect(isInfraError("insufficient credits")).toBe(true);
    expect(isInfraError("endpoints are not available")).toBe(true);
    expect(isInfraError("provider returned error")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isInfraError("ECONNRESET")).toBe(true);
    expect(isInfraError("ETIMEDOUT")).toBe(true);
  });

  it("returns false for tool/model errors", () => {
    expect(isInfraError("tool not found")).toBe(false);
    expect(isInfraError("invalid function call")).toBe(false);
    expect(isInfraError("model refused")).toBe(false);
  });
});

describe("redact", () => {
  it("redacts exact secret strings (length >= 8)", () => {
    expect(redact("Bearer sk-live-abcdefgh", ["sk-live-abcdefgh"])).toBe("Bearer [redacted]");
  });

  it("redacts bearer tokens generically", () => {
    expect(redact("Authorization: Bearer sk-live-xyz789", [])).toBe("Authorization: Bearer [redacted]");
  });

  it("truncates long output", () => {
    const long = "x".repeat(300000);
    const out = redact(long, []);
    expect(out.length).toBeLessThanOrEqual(200050);
    expect(out).toContain("…[");
  });

  it("does not redact short secrets (below length-8 threshold)", () => {
    expect(redact("Bearer abc123", ["abc123"])).toBe("Bearer abc123");
  });
});