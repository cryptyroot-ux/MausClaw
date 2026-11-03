// CLI runner for engine-task evals.
//
// Two modes:
//   * checkers (default, offline): for every task, seed the task files into a
//     fresh temp workspace, run the task checker (seeded state must fail), then
//     overlay the known-good solution and re-check (must pass). Zero provider
//     requests are sent and no LiveInstance is required. This is what
//     `pnpm eval:engine` runs by default.
//   * live (opt-in): runs each task through the native engine via runEngineTask
//     against a configured LiveInstance (MAUSCLAW_EVAL_LIVE_INSTANCE or
//     MAUSCLAW_EVAL_LIVE_CONFIG). Live/paid model runs require explicit owner
//     approval and refuse before any HTTP request when not configured.
//
// Reports are written to evals/results/ (gitignored). A committed baseline
// manifest lives at evals/engine-tasks/baselines/phase0.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineTask } from "../engine-tasks/tasks.ts";
import type { EngineTaskRow } from "../engine-tasks/run-engine-tasks.ts";
import { runEngineTask } from "../engine-tasks/run-engine-tasks.ts";
import type { LiveInstance } from "../live/types.ts";
import { z } from "zod";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const RESULTS_DIR = join(ROOT, "evals", "results");
const MAX_REQUESTS = 25; // per task: discovery + probe + turn + tool exchanges

const SCHEMA_VERSION = 1;

const liveInstanceEnvSchema = z.object({
  instanceId: z.string().min(1),
  driver: z.string().min(1),
  displayName: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  model: z.string().min(1),
});

function loadLiveInstance(): LiveInstance | null {
  const raw = process.env.MAUSCLAW_EVAL_LIVE_INSTANCE;
  if (raw) {
    const parsed = liveInstanceEnvSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`MAUSCLAW_EVAL_LIVE_INSTANCE invalid JSON: ${parsed.error.message}`);
    }
    return parsed.data as LiveInstance;
  }
  const configPath = process.env.MAUSCLAW_EVAL_LIVE_CONFIG;
  if (configPath) {
    const parsed = liveInstanceEnvSchema.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
    if (!parsed.success) {
      throw new Error(`MAUSCLAW_EVAL_LIVE_CONFIG invalid JSON: ${parsed.error.message}`);
    }
    return parsed.data as LiveInstance;
  }
  return null;
}

// Commit that produced this report, best effort (null outside a git repo).
function resolveCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// Stable hash of the task set so the report is tied to an exact task catalog.
function taskSetHash(tasks: EngineTask[]): string {
  const payload = JSON.stringify(
    tasks.map((t) => ({ id: t.id, suite: t.suite })),
  );
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

interface EngineEvalReport {
  schemaVersion: number;
  generatedAt: string;
  commit: string | null;
  taskSetHash: string;
  mode: "checkers" | "live";
  liveStatus: "not-run" | "completed" | "blocked";
  provider?: string;
  model?: string;
  maxRequests?: number;
  requests: { sent: number; refused: number };
  rows: EngineTaskRow[];
  aggregate: {
    taskCount: number;
    passCount: number;
    failCount: number;
    infraCount: number;
    cappedCount: number;
    passRate: number;
    totalRequests: number;
    totalDurationMs: number;
    meanDurationMs: number;
    totalCompactions: number;
    toolsUsed: string[];
    bySuite: Record<"basic" | "hard", { total: number; pass: number; fail: number; infra: number }>;
  };
}

interface Aggregate {
  taskCount: number;
  passCount: number;
  failCount: number;
  infraCount: number;
  cappedCount: number;
  totalRequests: number;
  totalDurationMs: number;
  totalCompactions: number;
  toolsUsed: string[];
  bySuite: Record<"basic" | "hard", { total: number; pass: number; fail: number; infra: number }>;
}

function aggregateRows(rows: EngineTaskRow[], tasks: EngineTask[]): Aggregate {
  const passCount = rows.filter((r) => r.status === "pass").length;
  const failCount = rows.filter((r) => r.status === "fail").length;
  const infraCount = rows.filter((r) => r.status === "infra").length;
  const cappedCount = rows.filter((r) => r.status === "capped").length;
  const totalRequests = rows.reduce((s, r) => s + r.requests, 0);
  const totalDurationMs = rows.reduce((s, r) => s + r.durationMs, 0);
  const totalCompactions = rows.reduce((s, r) => s + r.compactions, 0);
  const toolsUsed = [...new Set(rows.flatMap((r) => r.tools))].sort();

  const bySuite: Aggregate["bySuite"] = {
    basic: { total: 0, pass: 0, fail: 0, infra: 0 },
    hard: { total: 0, pass: 0, fail: 0, infra: 0 },
  };
  for (const row of rows) {
    const task = tasks.find((t) => t.id === row.task);
    const suite = task?.suite ?? "basic";
    bySuite[suite].total++;
    if (row.status === "pass") bySuite[suite].pass++;
    else if (row.status === "fail") bySuite[suite].fail++;
    else if (row.status === "infra") bySuite[suite].infra++;
  }

  return {
    taskCount: rows.length,
    passCount,
    failCount,
    infraCount,
    cappedCount,
    totalRequests,
    totalDurationMs,
    totalCompactions,
    toolsUsed,
    bySuite,
  };
}

/** Checker mode: no provider, zero requests. Seeded state must fail; solution must pass. */
function runCheckerTask(task: EngineTask): EngineTaskRow {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), `mausclaw-engine-check-${task.id}-`));
  try {
    let seeded: { pass: boolean; why: string };
    try {
      for (const [name, text] of Object.entries(task.files ?? {})) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      seeded = task.check(dir);
    } catch (error) {
      seeded = { pass: false, why: `seeded check threw: ${error instanceof Error ? error.message : String(error)}` };
    }

    let solved: { pass: boolean; why: string };
    try {
      for (const [name, text] of Object.entries(task.solution ?? {})) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      solved = task.check(dir);
    } catch (error) {
      solved = { pass: false, why: `solution check threw: ${error instanceof Error ? error.message : String(error)}` };
    }

    let status: EngineTaskRow["status"];
    let why: string;
    if (!seeded.pass) {
      if (solved.pass) {
        status = "pass";
        why = "seeded state fails checker; known-good solution passes";
      } else {
        status = "fail";
        why = `solution did not pass checker: ${solved.why}`;
      }
    } else {
      status = "fail";
      why = `seeded state unexpectedly passed: ${seeded.why}`;
    }

    return {
      task: task.id,
      status,
      why,
      requests: 0,
      rounds: 0,
      durationMs: Date.now() - started,
      compactions: 0,
      tools: [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runLiveMode(
  tasks: EngineTask[],
  instance: LiveInstance,
): Promise<{ rows: EngineTaskRow[]; requests: { sent: number; refused: number } }> {
  const rows: EngineTaskRow[] = [];
  let totalSent = 0;
  let totalRefused = 0;

  for (const task of tasks) {
    console.log(`running ${task.id}...`);
    const row = await runEngineTask({ task, instance, maxRequests: MAX_REQUESTS });
    rows.push(row);
    totalSent += row.requests;
    const statusLabel = row.status === "infra" ? "INFRA" : row.status === "capped" ? "CAPPED" : row.status.toUpperCase();
    console.log(`  ${statusLabel} ${row.why} requests=${row.requests} rounds=${row.rounds} ${row.durationMs}ms`);
    if (row.error) console.log(`    error: ${row.error}`);
  }

  return { rows, requests: { sent: totalSent, refused: totalRefused } };
}

async function main() {
  const tasks = await import("../engine-tasks/tasks.ts").then((m) => m.ENGINE_TASKS);
  const instance = loadLiveInstance();
  const commit = resolveCommit();
  const hash = taskSetHash(tasks);

  let rows: EngineTaskRow[];
  let mode: EngineEvalReport["mode"];
  let liveStatus: EngineEvalReport["liveStatus"];
  let provider: string | undefined;
  let model: string | undefined;
  let maxRequests: number | undefined;
  let requests: { sent: number; refused: number };

  if (!instance) {
    // Offline checker mode: the default. No provider is constructed, no HTTP
    // request is sent, and no secret can leak.
    console.log("No LiveInstance configured — running offline checker mode (zero provider requests).");
    mode = "checkers";
    liveStatus = "not-run";
    rows = tasks.map((task) => runCheckerTask(task));
    requests = { sent: 0, refused: 0 };
  } else {
    mode = "live";
    provider = instance.driver;
    model = instance.model;
    maxRequests = MAX_REQUESTS;
    const liveResult = await runLiveMode(tasks, instance);
    rows = liveResult.rows;
    requests = liveResult.requests;
    liveStatus = rows.some((r) => r.status === "infra") ? "completed" : "completed";
    // Any infra row means the live run hit provider/transport issues; still
    // recorded as completed (rows classify infra vs task failure), never as a
    // silent pass. Keep liveStatus "completed" so the report reflects what ran.
  }

  const finishedAt = new Date().toISOString();
  const agg = aggregateRows(rows, tasks);
  const passRate = rows.length ? agg.passCount / rows.length : 0;

  const report: EngineEvalReport = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: finishedAt,
    commit,
    taskSetHash: hash,
    mode,
    liveStatus,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(maxRequests !== undefined ? { maxRequests } : {}),
    requests,
    rows,
    aggregate: {
      ...agg,
      passRate,
    },
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `engine-${mode}-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${out}`);
  console.log(`mode: ${mode} | liveStatus: ${liveStatus}`);
  console.log(`pass rate: ${(passRate * 100).toFixed(1)}% (${agg.passCount}/${rows.length})`);
  console.log(`fail: ${agg.failCount} | infra: ${agg.infraCount} | capped: ${agg.cappedCount}`);
  console.log(`requests sent: ${agg.totalRequests} | refused: ${requests.refused} | total duration: ${agg.totalDurationMs}ms`);
  console.log(`tools used: ${agg.toolsUsed.join(", ") || "(none)"}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
