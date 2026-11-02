// Compaction journaling for MausClaw Native Engine.
// Records every compaction decision (overflow recovery, turn context fold)
// as NDJSON for audit and replay. Append-only, non-blocking writes.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";


export const COMPACTIONS_FILE = join("compactions", "compactions.jsonl");

export interface CompactionEntry {
  id: string;
  runId: string;
  threadId: string;
  botId?: string;
  round: number;
  reason: "overflow" | "budget" | "context";
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  summary?: string;
  timestamp: number;
}

export function appendCompaction(dataDir: string, entry: CompactionEntry): void {
  try {
    const file = join(dataDir, COMPACTIONS_FILE);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error(`[compaction-journal] Failed to append: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function readCompactions(dataDir: string, filter?: { runId?: string; threadId?: string; botId?: string }): CompactionEntry[] {
  const file = join(dataDir, COMPACTIONS_FILE);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const entries: CompactionEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CompactionEntry;
      if (filter?.runId && entry.runId !== filter.runId) continue;
      if (filter?.threadId && entry.threadId !== filter.threadId) continue;
      if (filter?.botId && entry.botId !== filter.botId) continue;
      entries.push(entry);
    } catch {
      // Skip corrupt lines
    }
  }
  return entries;
}

export function foldCompactions(entries: CompactionEntry[]): Map<string, CompactionEntry> {
  const folded = new Map<string, CompactionEntry>();
  for (const entry of entries) {
    folded.set(entry.runId, entry);
  }
  return folded;
}

export function readCompactionsForThread(dataDir: string, threadId: string): CompactionEntry[] {
  return readCompactions(dataDir, { threadId });
}

export function foldCompactionsByThread(entries: CompactionEntry[]): Map<string, CompactionEntry> {
  const folded = new Map<string, CompactionEntry>();
  for (const entry of entries) {
    folded.set(entry.threadId, entry);
  }
  return folded;
}

export function getCompactionStats(entries: CompactionEntry[]): {
  totalSavedTokens: number;
  averageQuality: number;
  tierDistribution: Record<string, number>;
} {
  let totalSavedTokens = 0;
  let qualitySum = 0;
  const tierDistribution: Record<string, number> = {};

  for (const entry of entries) {
    totalSavedTokens += entry.tokensSaved;
    qualitySum += entry.tokensBefore > 0 ? entry.tokensSaved / entry.tokensBefore : 0;
    tierDistribution[entry.reason] = (tierDistribution[entry.reason] ?? 0) + 1;
  }

  return {
    totalSavedTokens,
    averageQuality: entries.length > 0 ? qualitySum / entries.length : 0,
    tierDistribution,
  };
}
