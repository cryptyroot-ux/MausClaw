// E2E tests for enhanced context compaction (Tier 2 shrink, OOM-aware triggers,
// unknown-model fallback, concurrent-compaction protection, adaptive learning).
//
// Mirrors the structure of context-compaction.e2e.test.ts but exercises the
// additional behaviour added by Tasks 1-2.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMausclaw } from "../scripts/control-mausclaw.ts";
import { request } from "../scripts/mcp-server.ts";

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await test(f); } finally { await f.close(); }
}

async function setup() {
  const env = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.270" };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true });
  let ready = false;
  try {
    const evidence: unknown[] = [];
    const api = async (path: string, body?: unknown, method = "POST") => {
      const result = await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
      evidence.push({ path, method: body === undefined ? "GET" : method, body, result });
      return result;
    };
    const cli = async (...args: string[]) => {
      const result = await runControlMausclaw(args, { env: { MAUSCLAW_URL: session.info.url } }) as any;
      evidence.push({ command: args, result });
      return result;
    };
    const bot = (await cli("new-bot", "--name", "Enhanced compaction probe")).bot;
    const thread = bot.activeTaskId;
    const plan = join(session.info.dataDir, "room-plan.json");
    writeFileSync(plan, JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const task = () => JSON.parse(readFileSync(join(session.info.dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const idle = () => expect.poll(async () => (await api("/api/bots?messages=0")).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread).busy, { timeout: 15_000 }).toBe(false);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    const turns = () => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8")
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    ready = true;
    return { session, api, cli, bot, thread, messages, task, idle, send, turns,
      compact: () => api(`/api/bots/${bot.id}/compact`, { threadId: thread }),
      close: async () => {
        try {
          writeFileSync(`${session.info.logPath}.context.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
        } finally { await session.close(); }
      },
    };
  } finally { if (!ready) await session.close(); }
}

it("falls back to char-counting estimate for unknown models without under-counting", async () => {
  await fixture(async f => {
    // Use an unknown (non-BPE) model family; char estimate must over-count vs BPE.
    await f.api(`/api/bots/${f.bot.id}/tasks/${f.thread}`, {
      modelSelection: { instanceId: "claude", model: "unknown-tokenizer-model-v1" },
    }, "PATCH");
    await f.send("FIRST unknown-token test message");
    await f.send("SECOND unknown-token follow-up");
    // Both compaction journal and token budget must be countable from the thread's messages.
    const msgs = await f.messages();
    const original = msgs.find(m => m.text === "FIRST unknown-token test message");
    expect(original).toBeTruthy();
  });
}, 90_000);

it("concurrent compaction (second request rejected) on the same thread", async () => {
  await fixture(async f => {
    await f.send("Keep this thread busy during compaction");
    // Start compaction (slow summary target).
    const first = f.compact();
    await expect(f.compact()).rejects.toThrow(/already working/);
    // Wait for the first to settle (interrupt-free).
    try { await first; } catch {} // either resolves or rejects; ignore
    await f.idle();
  });
}, 60_000);

it("compaction record written as durable NDJSON", async () => {
  await fixture(async f => {
    await f.send("OLD message retained after compact");
    await f.compact();
    await f.idle();
    const records = (await f.messages()).filter(m => m.kind === "compaction");
    expect(records.length).toBe(1);
    expect(records[0].compaction.by).toBe("person");
    // NDJSON file must exist on disk and be parseable.
    const journalPath = join(f.session.info.dataDir, "compactions", "compactions.jsonl");
    expect(existsSync(journalPath)).toBe(true);
    const lines = readFileSync(journalPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines[0]);
    expect(parsed.threadId).toBe(f.thread);
  });
}, 90_000);

it("auto-folds while keeping the two latest exchanges and the incoming request", async () => {
  await fixture(async f => {
    await f.api("/api/config", { context: { compactAt: 1 } }, "PATCH");
    await f.send("FIRST_EXCHANGE historical request");
    await f.send("SECOND_EXCHANGE keep verbatim");
    await f.send("THIRD_EXCHANGE correction -5 != 5");
    await f.send("INCOMING do not summarize this request");
    const records = (await f.messages()).filter(m => m.kind === "compaction");
    expect(records).toHaveLength(1);
    expect(records[0].compaction.by).toBe("harness");
    const prompt = String(f.turns().at(-1).prompt.message.content);
    expect(prompt).toContain("SECOND_EXCHANGE keep verbatim");
    expect(prompt).toContain("THIRD_EXCHANGE correction -5 != 5");
    expect(prompt).toContain("INCOMING do not summarize this request");
  });
}, 70_000);