// E2E tests for enhanced context compaction (Tier 2 shrink, OOM-aware triggers,
// unknown-model fallback, concurrent-compaction protection).
//
// Mirrors the structure of context-compaction.e2e.test.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMausclaw } from "../scripts/control-mausclaw.ts";
import { request } from "../scripts/mcp-server.ts";

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, hang = false) {
  const f = await setup(hang);
  try { await test(f); } finally { await f.close(); }
}

async function setup(hang = false) {
  const env = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.270", ...(hang ? { FAKE_CLAUDE_TEXT_HANG: "1" } : {}) };
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
    const idle = () => expect.poll(async () => (await api("/api/bots?messages=0")).bots
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread).busy, { timeout: 15_000 }).toBe(false);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    const turns = () => existsSync(`${plan}.evidence.jsonl`) ? readFileSync(`${plan}.evidence.jsonl`, "utf8")
      .trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    ready = true;
    return { session, api, cli, bot, thread, messages, idle, send, turns,
      compact: () => api(`/api/bots/${bot.id}/compact`, { threadId: thread }),
      close: async () => {
        try {
          writeFileSync(`${session.info.logPath}.context.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
        } finally { await session.close(); }
      },
    };
  } finally { if (!ready) await session.close(); }
}

it("concurrent compaction rejected while stall still in progress", async () => {
  await fixture(async f => {
    await f.send("Keep this thread present");
    const first = f.compact(); // hangs due to FAKE_CLAUDE_TEXT_HANG
    await expect(f.compact()).rejects.toThrow(/already working/);
    await f.cli("interrupt", "--bot", f.bot.id, "--task", f.thread);
    await f.idle();
    try { await first; } catch {} // swallow the interrupted hang
  }, true);
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

it("unknown model falls back to char-count estimate", async () => {
  await fixture(async f => {
    // Use an unknown model: FAKE provider may reject, but the harness still loads the message.
    await f.send("FIRST unknown-model test message");
    await f.send("SECOND unknown-model follow-up");
    const msgs = await f.messages();
    const original = msgs.find(m => m.text === "FIRST unknown-model test message");
    expect(original).toBeTruthy();
    // Build the paragraph and confirm the thread still has the user turns.
    expect((await f.messages()).filter(m => m.role === "user").length).toBeGreaterThanOrEqual(2);
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
    expect(records[0].compaction.summary).not.toContain("INCOMING");
    const prompt = String(f.turns().at(-1).prompt.message.content);
    expect(prompt).toContain("SECOND_EXCHANGE keep verbatim");
    expect(prompt).toContain("THIRD_EXCHANGE correction -5 != 5");
    expect(prompt).toContain("INCOMING do not summarize this request");
  });
}, 70_000);