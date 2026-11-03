import { createServer } from "node:http";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { launchVerificationServer, runControlMausclaw } from "../../scripts/control-mausclaw.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const TASKS_DIR = join(ROOT, "evals", "tasks");
const RESULTS_DIR = join(ROOT, "evals", "results");

function frame(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

interface Task {
  id: string;
  description: string;
  prompt: string;
  expectedReply: string;
  providerReply: string;
  budget?: { maxTokens?: number; maxCostUsd?: number; maxWallTimeMs?: number };
}

interface TaskResult {
  id: string;
  resolved: boolean;
  status: string;
  modelRounds: number;
  toolCalls: number;
  wallTimeMs: number;
  requestCount: number;
  compactions: number;
  recoveryRequired: boolean;
  error?: string;
}

async function runTask(task: Task): Promise<TaskResult> {
  const requests: Array<unknown> = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }> };
    const toolsProbe = parsed.tools?.length === 1 && parsed.tools[0]!.function.name === "noop";
    if (!toolsProbe) requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (toolsProbe) {
      response.write(frame({ tool_calls: [{ index: 0, id: "probe-call", type: "function", function: { name: "noop", arguments: "{}" } }] }, null));
      response.end(frame({ tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: "" } }] }, "tool_calls") + "data: [DONE]\n\n");
      return;
    }
    response.end(frame({ content: task.providerReply }, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("provider did not bind");
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json() as Promise<any>;
  };
  const control = (args: string[]) => runControlMausclaw([...args, "--url", fixture.info.url]) as Promise<any>;

  const started = Date.now();
  try {
    await api("PATCH", "/api/config", {
      openaiCompat: { key: "synthetic-eval-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" },
    });
    const { bot } = await control(["new-bot", "--name", `eval-${task.id}`]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", description: "Eval bot" });

    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", task.prompt]);
    const wait = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "60"]);

    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    const run = db.prepare("SELECT status, model_rounds, tool_calls FROM agent_runs").get() as { status: string; model_rounds: number; tool_calls: number } | undefined;
    const compactions = (db.prepare("SELECT COUNT(*) AS n FROM agent_compactions").get() as { n: number }).n;
    db.close();

    const bots = await api("GET", "/api/bots");
    const current = bots.bots.find((b: any) => b.id === bot.id);
    const resolved = current.messages.some((m: any) => m.role === "bot" && m.text?.includes(task.expectedReply));

    return {
      id: task.id,
      resolved,
      status: wait.status,
      modelRounds: run?.model_rounds ?? 0,
      toolCalls: run?.tool_calls ?? 0,
      wallTimeMs: Date.now() - started,
      requestCount: requests.length,
      compactions,
      recoveryRequired: wait.status === "recovery-required" || run?.status === "recovery_required",
    };
  } catch (error) {
    return {
      id: task.id,
      resolved: false,
      status: "error",
      modelRounds: 0,
      toolCalls: 0,
      wallTimeMs: Date.now() - started,
      requestCount: requests.length,
      compactions: 0,
      recoveryRequired: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

async function main() {
  const taskFiles = readdirSync(TASKS_DIR).filter((name) => name.endsWith(".json")).sort();
  const tasks: Task[] = taskFiles.map((name) => JSON.parse(readFileSync(join(TASKS_DIR, name), "utf8")));
  const results: TaskResult[] = [];
  for (const task of tasks) {
    console.log(`running ${task.id}...`);
    const result = await runTask(task);
    results.push(result);
    console.log(`  ${result.resolved ? "PASS" : "FAIL"} ${result.status} rounds=${result.modelRounds} tools=${result.toolCalls} requests=${result.requestCount} ${result.wallTimeMs}ms`);
  }
  const resolved = results.filter((r) => r.resolved).length;
  const report = {
    startedAt: new Date().toISOString(),
    tasks: results,
    aggregate: {
      taskCount: results.length,
      resolveRate: results.length ? resolved / results.length : 0,
      meanModelRounds: results.length ? results.reduce((s, r) => s + r.modelRounds, 0) / results.length : 0,
      meanToolCalls: results.length ? results.reduce((s, r) => s + r.toolCalls, 0) / results.length : 0,
      meanWallTimeMs: results.length ? results.reduce((s, r) => s + r.wallTimeMs, 0) / results.length : 0,
      meanRequests: results.length ? results.reduce((s, r) => s + r.requestCount, 0) / results.length : 0,
      totalCompactions: results.reduce((s, r) => s + r.compactions, 0),
      recoveryRequiredCount: results.filter((r) => r.recoveryRequired).length,
    },
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(RESULTS_DIR, `${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${out}`);
  console.log(`resolve rate: ${(report.aggregate.resolveRate * 100).toFixed(1)}% (${resolved}/${results.length})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
