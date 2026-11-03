// Isolated, opt-in native engine-task runner. Each task runs a real native
// engine turn in a fresh bot workspace under a temporary MAUSCLAW_DATA_DIR,
// under a hard HTTP request budget. Provider/model errors are classified as
// infrastructure failures, not task failures. Everything allocated by a run
// (temp data dir, fetch hook, env, DB handle, server sockets) is released in
// finally, on success, failure, and abort.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EngineTask, EngineTaskCheck } from "./tasks.ts";
import type { LiveInstance } from "../live/types.ts";

export interface EngineTaskRow {
  task: string;
  status: "pass" | "fail" | "infra" | "capped";
  why: string;
  requests: number;
  rounds: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  stopReason?: string;
  costUsd?: number;
  costSource?: "provider" | "price-table" | "unknown";
  compactions: number;
  tools: string[];
  error?: string;
}

/** Errors that are the provider's, not the model's or the engine's. */
export function isInfraError(message: string): boolean {
  return /\b(429|402|502|503|504)\b|rate.?limit|too many requests|temporarily|overloaded|credit|endpoints?(?: are)?(?: not)? available|provider returned error|fetch failed|ECONNRESET|ETIMEDOUT|eval request budget/i.test(message ?? "");
}

const EXCHANGE_CHARS = 200_000;

/** Redacts configured secrets and bearer tokens from text. Never includes headers. */
export function redact(text: string, secrets: string[]): string {
  let out = text ?? "";
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]");
  return out.length > EXCHANGE_CHARS ? `${out.slice(0, EXCHANGE_CHARS)}…[${out.length - EXCHANGE_CHARS} more chars]` : out;
}

interface PendingFetch {
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}

/** Counts every outgoing provider HTTP request; past the budget none is sent. */
function installRequestBudget(max: number, secrets: string[]): {
  sent: number;
  refused: number;
  log: string[];
  exchanges: Array<{ n: number; url: string; status: number | "ERR"; request: string; response: string }>;
  restore: () => void;
} {
  const real = globalThis.fetch;
  const state = {
    sent: 0,
    refused: 0,
    log: [] as string[],
    exchanges: [] as Array<{ n: number; url: string; status: number | "ERR"; request: string; response: string }>,
  };
  const pending = new Set<PendingFetch>();

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (state.sent >= max) {
      state.refused++;
      const err = new Error(`eval request budget of ${max} reached`);
      state.exchanges.push({ n: state.sent + 1, url, status: "ERR", request: redact(typeof init?.body === "string" ? init.body : "", secrets), response: err.message });
      state.log.push(`${state.sent + 1} ERR ${err.message}`);
      throw err;
    }
    state.sent++;
    const n = state.sent;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const request = redact(typeof init?.body === "string" ? init.body : "", secrets);
    const p = new Promise<Response>((resolve, reject) => {
      pending.add({ resolve, reject });
      (real as typeof fetch)(input, init).then(
        (response) => {
          pending.delete(p as any);
          state.log.push(`${n} ${response.status} ${path}`);
          const exchange = { n, url: path, status: response.status, request, response: "" };
          state.exchanges.push(exchange);
          void response.clone().text().then(
            (text) => { exchange.response = redact(text, secrets); },
            (error) => { exchange.response = `[read failed: ${(error as Error).message}]`; },
          );
          resolve(response);
        },
        (error) => {
          pending.delete(p as any);
          state.log.push(`${n} ERR ${(error as Error).message}`);
          state.exchanges.push({ n, url: path, status: "ERR", request, response: redact((error as Error).message, secrets) });
          state.log.push(`${n} ERR ${(error as Error).message}`);
          reject(error);
        },
      );
    });
    return p;
  }) as typeof fetch;

  return {
    get sent() { return state.sent; },
    get refused() { return state.refused; },
    get log() { return state.log; },
    get exchanges() { return state.exchanges; },
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Collects a single turn's events into a row-shaped summary. */
interface TurnTrace {
  ok: boolean;
  stopReason: string | null;
  error: string | undefined;
  rounds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | undefined;
  compactions: number;
  tools: string[];
  failureCode: string | undefined;
}

async function traceTurn(
  adapter: { onEvent(listener: (event: unknown) => void): () => void },
  threadId: string,
  timeoutMs: number,
): Promise<TurnTrace> {
  const trace: TurnTrace = { ok: false, stopReason: null, error: undefined, rounds: 0, inputTokens: 0, outputTokens: 0, costUsd: undefined, compactions: 0, tools: [], failureCode: undefined };
  const toolNames = new Set<string>();
  const completed = new Promise<TurnTrace>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`turn timed out after ${timeoutMs}ms`)); }
    }, timeoutMs);
    const unsubscribe = adapter.onEvent((event: unknown) => {
      if (settled) return;
      const e = event as { threadId?: string; type?: string; runId?: string; ok?: boolean; stopReason?: string | null; message?: string; code?: string; input?: number; output?: number; costUsd?: number; calls?: Array<{ name?: string }>; summary?: string; firstKeptIndex?: number; tokenEstimate?: number; trigger?: string } | null;
      if (!e || e.threadId !== threadId && e.threadId !== undefined) return;
      switch (e.type) {
        case "turn.completed":
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve({ ...trace, ok: e.ok ?? false, stopReason: e.stopReason ?? null });
          break;
        case "run.failed":
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          resolve({ ...trace, ok: false, stopReason: "failed", error: e.message, failureCode: e.code });
          break;
        case "runtime.error":
          trace.error = String(e.message ?? "").slice(0, 500);
          break;
        case "usage":
          trace.inputTokens += e.input ?? 0;
          trace.outputTokens += e.output ?? 0;
          if (e.costUsd !== undefined) trace.costUsd = (trace.costUsd ?? 0) + e.costUsd;
          break;
        case "tool.calls":
          for (const call of e.calls ?? []) if (call.name) toolNames.add(call.name);
          break;
        case "run.compacted":
          trace.compactions++;
          break;
        case "thread.token-usage.updated":
          trace.rounds += 1;
          break;
      }
    });
  });
  const result = await completed;
  return { ...result, tools: [...toolNames] };
}

/**
 * Run a single engine task through the native loop in an isolated workspace.
 *
 * The caller supplies a resolved `LiveInstance` (driver, config, environment)
 * and a hard `maxRequests` ceiling. All provider HTTP traffic—including
 * capability discovery and the live probe—is counted against the budget.
 */
export async function runEngineTask(input: {
  task: EngineTask;
  instance: LiveInstance;
  maxRequests: number;
}): Promise<EngineTaskRow> {
  const { task, instance, maxRequests } = input;
  const started = Date.now();
  const originalDataDir = process.env.MAUSCLAW_DATA_DIR;

  // Per-run isolated data dir. Set before any server module is imported so
  // DATA_DIR (~/.mausclaw) resolves here, never the real home.
  const dataDir = mkdtempSync(join(tmpdir(), `mausclaw-engine-task-${task.id}-`));
  process.env.MAUSCLAW_DATA_DIR = dataDir;

  let budget: { sent: number; refused: number; log: string[]; exchanges: Array<{ n: number; url: string; status: number | "ERR"; request: string; response: string }>; restore: () => void } | undefined;

  try {
    // Dynamic imports after MAUSCLAW_DATA_DIR is set.
    const { BUILT_IN_DRIVERS } = await import("../../server/drivers/builtIn.ts");
    const { closeMessageDb: _closeMessageDb } = await import("../../server/message-db.ts");
    const { createSqliteAgentRunStore } = await import("../../server/agent-runtime/run-store.ts");

    const driver = BUILT_IN_DRIVERS.find((d) => d.driverKind === instance.driver);
    if (!driver) {
      return {
        task: task.id, status: "infra", why: `unknown driver: ${instance.driver}`,
        requests: 0, rounds: 0, durationMs: Date.now() - started, compactions: 0, tools: [],
        error: `unknown driver: ${instance.driver}`,
      };
    }

    const providerInstance = await driver.create({
      instanceId: instance.instanceId,
      displayName: instance.displayName ?? `engine-task-${task.id}`,
      environment: instance.environment ?? {},
      enabled: true,
      config: instance.config ?? {},
    });
    if (providerInstance.startupModelRefresh) await providerInstance.startupModelRefresh;

    // Secrets for redaction: configured API key and any bearer-like values.
    const secrets: string[] = [];
    const config = instance.config ?? {};
    if (typeof config.apiKey === "string" && config.apiKey) secrets.push(config.apiKey);
    if (typeof config.key === "string" && config.key) secrets.push(config.key);
    const keyEnv = typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "OPENAI_COMPAT_API_KEY";
    const envKey = instance.environment?.[keyEnv] ?? process.env[keyEnv];
    if (envKey) secrets.push(envKey);

    // Wrap fetch to count every provider request and enforce the hard cap.
    budget = installRequestBudget(maxRequests, secrets);

    // Seed the task into a fresh bot workspace.
    const botId = randomUUID();
    const { ensureWorkspace } = await import("../../server/workspace.ts");
    const workspace = ensureWorkspace(botId);
    for (const [name, text] of Object.entries(task.files)) {
      mkdirSync(dirname(join(workspace, name)), { recursive: true });
      writeFileSync(join(workspace, name), text);
    }

    const threadId = randomUUID();

    // Start the trace listener FIRST, then send the turn. traceTurn waits for
    // turn.completed, which only fires after sendTurn starts the turn — awaiting
    // traceTurn before sendTurn would deadlock.
    const tracePromise = traceTurn(providerInstance.adapter, threadId, 120_000);

    const turnId = await providerInstance.adapter.sendTurn({
      threadId,
      botId,
      agentEngine: "mausclaw-native",
      text: task.prompt,
      model: instance.model,
      approvalMode: "full",
    });

    const trace = await tracePromise;

    const run = createSqliteAgentRunStore().getRun(turnId);
    if (run) {
      trace.rounds = run.modelRounds ?? trace.rounds;
      // tools are collected from events; run doesn't carry tool names.
    }

    // Run the automatic checker against the seeded workspace.
    const checkResult: EngineTaskCheck = task.check(workspace);

    let status: EngineTaskRow["status"];
    if (!trace.ok || trace.failureCode || trace.error) {
      status = isInfraError(trace.error ?? trace.failureCode ?? "") ? "infra" : "fail";
    } else if (!checkResult.pass) {
      status = "fail";
    } else {
      status = "pass";
    }

    const costSource = trace.costUsd !== undefined ? "provider" : "unknown";

    return {
      task: task.id,
      status,
      why: checkResult.why,
      requests: budget.sent,
      rounds: trace.rounds,
      inputTokens: trace.inputTokens,
      outputTokens: trace.outputTokens,
      durationMs: Date.now() - started,
      stopReason: trace.stopReason,
      costUsd: trace.costUsd,
      costSource,
      compactions: trace.compactions,
      tools: trace.tools,
      ...(trace.error ? { error: trace.error } : {}),
    };
  } catch (error) {
    return {
      task: task.id,
      status: isInfraError(error instanceof Error ? error.message : String(error)) ? "infra" : "fail",
      why: error instanceof Error ? error.message : String(error),
      requests: budget?.sent ?? 0,
      rounds: 0,
      durationMs: Date.now() - started,
      compactions: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (budget) budget.restore();
    try { await _closeMessageDb(); } catch {}
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.MAUSCLAW_DATA_DIR;
    else process.env.MAUSCLAW_DATA_DIR = originalDataDir;
  }
}
