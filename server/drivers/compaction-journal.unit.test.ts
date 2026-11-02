import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CompactionEntry } from "./compaction-journal.ts";
import {
  appendCompaction,
  foldCompactionsByThread,
  getCompactionStats,
  readCompactions,
  readCompactionsForThread,
} from "./compaction-journal.ts";

const root = mkdtempSync(join(tmpdir(), "mausclaw-compaction-journal-unit-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const makeEntry = (overrides: Partial<CompactionEntry> = {}): CompactionEntry => ({
  id: "run-1-1",
  runId: "run-1",
  threadId: "thread-1",
  botId: "bot-a",
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

describe("compaction-journal per-thread helpers", () => {
  it("readCompactionsForThread returns entries matching threadId", () => {
    const dir = join(root, "t-thread");
    appendCompaction(dir, makeEntry({ id: "t1-1", runId: "run-1", threadId: "thread-1", round: 1 }));
    appendCompaction(dir, makeEntry({ id: "t1-2", runId: "run-1", threadId: "thread-1", round: 2 }));
    appendCompaction(dir, makeEntry({ id: "t2-1", runId: "run-2", threadId: "thread-2", round: 1 }));

    const forThread1 = readCompactionsForThread(dir, "thread-1");
    const forThread2 = readCompactionsForThread(dir, "thread-2");
    const forThread3 = readCompactionsForThread(dir, "thread-3");

    expect(forThread1).toHaveLength(2);
    expect(forThread2).toHaveLength(1);
    expect(forThread3).toEqual([]);
    expect(forThread1.every((e) => e.threadId === "thread-1")).toBe(true);
    expect(forThread2.every((e) => e.threadId === "thread-2")).toBe(true);
  });

  it("readCompactionsForThread returns [] when file doesn't exist", () => {
    const dir = join(root, "t-missing-thread");
    expect(readCompactionsForThread(dir, "thread-1")).toEqual([]);
  });

  it("readCompactionsForThread matches readCompactions with threadId filter", () => {
    const dir = join(root, "t-parity");
    appendCompaction(dir, makeEntry({ id: "p-1", runId: "run-1", threadId: "thread-x" }));
    appendCompaction(dir, makeEntry({ id: "p-2", runId: "run-2", threadId: "thread-y" }));

    expect(readCompactionsForThread(dir, "thread-x")).toEqual(readCompactions(dir, { threadId: "thread-x" }));
  });

  it("foldCompactionsByThread folds by threadId (last entry per thread wins)", () => {
    const entries = [
      makeEntry({ id: "a-1", threadId: "thread-a", round: 1, summary: "first" }),
      makeEntry({ id: "a-2", threadId: "thread-a", round: 2, summary: "second" }),
      makeEntry({ id: "b-1", threadId: "thread-b", round: 1, summary: "only" }),
    ];

    const folded = foldCompactionsByThread(entries);
    expect(folded.size).toBe(2);
    expect(folded.get("thread-a")?.id).toBe("a-2");
    expect(folded.get("thread-a")?.summary).toBe("second");
    expect(folded.get("thread-b")?.id).toBe("b-1");
    expect(folded.get("thread-c")).toBeUndefined();
  });

  it("foldCompactionsByThread returns empty Map for no entries", () => {
    expect(foldCompactionsByThread([])).toEqual(new Map());
    expect(foldCompactionsByThread([]).size).toBe(0);
  });

  it("getCompactionStats aggregates tokens saved, average quality, and tier distribution", () => {
    const entries = [
      makeEntry({ reason: "overflow", tokensBefore: 1000, tokensAfter: 400, tokensSaved: 600 }), // quality 0.6
      makeEntry({ reason: "budget", tokensBefore: 500, tokensAfter: 200, tokensSaved: 300 }),    // quality 0.6
      makeEntry({ reason: "context", tokensBefore: 800, tokensAfter: 800, tokensSaved: 0 }),      // quality 0
    ];

    const stats = getCompactionStats(entries);
    expect(stats.totalSavedTokens).toBe(900);
    expect(stats.averageQuality).toBeCloseTo(0.4); // (0.6 + 0.6 + 0) / 3
    expect(stats.tierDistribution).toEqual({ overflow: 1, budget: 1, context: 1 });
  });

  it("getCompactionStats treats zero tokensBefore as zero quality", () => {
    const stats = getCompactionStats([
      makeEntry({ tokensBefore: 0, tokensAfter: 0, tokensSaved: 0 }),
    ]);
    expect(stats.totalSavedTokens).toBe(0);
    expect(stats.averageQuality).toBe(0);
    expect(stats.tierDistribution).toEqual({ budget: 1 });
  });

  it("getCompactionStats returns zeros for empty entries", () => {
    expect(getCompactionStats([])).toEqual({
      totalSavedTokens: 0,
      averageQuality: 0,
      tierDistribution: {},
    });
  });
});
