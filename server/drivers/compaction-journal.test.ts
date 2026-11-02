import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CompactionEntry } from "./compaction-journal.ts";
import {
  appendCompaction,
  COMPACTIONS_FILE,
  foldCompactions,
  readCompactions,
} from "./compaction-journal.ts";

const root = mkdtempSync(join(tmpdir(), "mausclaw-compaction-journal-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const makeEntry = (overrides: Partial<CompactionEntry> = {}): CompactionEntry => ({
  id: "run-1-1",
  runId: "run-1",
  threadId: "thread-1",
  round: 1,
  reason: "budget",
  messagesBefore: 10,
  messagesAfter: 5,
  tokensBefore: 1000,
  tokensAfter: 400,
  tokensSaved: 600,
  summary: "summary-1",
  timestamp: 1000,
  ...overrides,
});

describe("compaction-journal", () => {
  it("appendCompaction writes a valid NDJSON line to the expected file path", () => {
    const dir = join(root, "t-append");
    const entry = makeEntry({ id: "run-1-1", runId: "run-1" });
    appendCompaction(dir, entry);

    const file = join(dir, COMPACTIONS_FILE);
    expect(existsSync(file)).toBe(true);

    const line = readFileSync(file, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject(entry);
  });

  it("readCompactions returns entries matching filters (runId, threadId, botId)", () => {
    const dir = join(root, "t-filter");
    appendCompaction(dir, makeEntry({ id: "run-1-1", runId: "run-1", threadId: "thread-1", botId: "bot-a", round: 1 }));
    appendCompaction(dir, makeEntry({ id: "run-1-2", runId: "run-1", threadId: "thread-1", botId: "bot-a", round: 2 }));
    appendCompaction(dir, makeEntry({ id: "run-2-1", runId: "run-2", threadId: "thread-2", botId: "bot-b", round: 1 }));

    expect(readCompactions(dir, { runId: "run-1" })).toHaveLength(2);
    expect(readCompactions(dir, { runId: "run-2" })).toHaveLength(1);
    expect(readCompactions(dir, { threadId: "thread-2" })).toHaveLength(1);
    expect(readCompactions(dir, { botId: "bot-a" })).toHaveLength(2);
    expect(readCompactions(dir, { runId: "run-1", botId: "bot-b" })).toHaveLength(0);
    expect(readCompactions(dir, { runId: "nope" })).toHaveLength(0);
  });

  it("readCompactions returns [] when file doesn't exist", () => {
    const dir = join(root, "t-missing");
    expect(readCompactions(dir)).toEqual([]);
    expect(readCompactions(dir, { runId: "run-1" })).toEqual([]);
  });

  it("foldCompactions folds by runId (last entry per runId wins)", () => {
    const dir = join(root, "t-fold");
    appendCompaction(dir, makeEntry({ id: "run-1-1", runId: "run-1", round: 1, summary: "first" }));
    appendCompaction(dir, makeEntry({ id: "run-1-2", runId: "run-1", round: 2, summary: "second" }));
    appendCompaction(dir, makeEntry({ id: "run-2-1", runId: "run-2", round: 1, summary: "only" }));

    const folded = foldCompactions(readCompactions(dir));
    expect(folded.size).toBe(2);
    expect(folded.get("run-1")?.summary).toBe("second");
    expect(folded.get("run-2")?.summary).toBe("only");
  });

  it("corrupt lines are skipped, not thrown", () => {
    const dir = join(root, "t-corrupt");
    const valid = makeEntry({ id: "run-1-1", runId: "run-1" });
    const file = join(dir, COMPACTIONS_FILE);
    mkdirSync(join(dir, "compactions"), { recursive: true });
    writeFileSync(file, "{not valid json\n" + JSON.stringify(valid) + "\nbroken\n");

    expect(() => readCompactions(dir)).not.toThrow();
    expect(readCompactions(dir)).toEqual([valid]);
  });

  it("file is created with mode 0o600 and directory with mode 0o700", () => {
    const dir = join(root, "t-modes");
    appendCompaction(dir, makeEntry());

    const file = join(dir, COMPACTIONS_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "compactions")).mode & 0o777).toBe(0o700);
  });
});
