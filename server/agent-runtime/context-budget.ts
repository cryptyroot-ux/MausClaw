// Context budget & adaptive window learning for the MausClaw native engine.
//
// Tracks per-model overflow observations and learns a smaller context window
// after repeated overflows, so compaction can trigger before the provider
// rejects the request. Provider/model-agnostic: only model ids and token
// counts cross this boundary; no provider wire format leaks through.

import type { CapabilityLimit } from "./contracts.ts";
import { countTokens } from "../drivers/tokenizer.ts";

/** Default context window used when a model is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Compact budget: 25% of the window, clamped to this range. */
const COMPACT_BUDGET_FRACTION = 0.25;
const COMPACT_BUDGET_MIN = 8_000;
const COMPACT_BUDGET_MAX = 32_000;

/** Compaction trigger: max(50% of window, window - reserve). The reserve is
 * 15% of the window, never below 16k tokens, so large windows keep absolute
 * headroom for tool results and generation. */
const TRIGGER_HALF = 0.5;
const TRIGGER_RESERVE_FRACTION = 0.15;
const TRIGGER_RESERVE_MIN = 16_000;

/** learnContextWindow: shrink after this many consecutive overflows. */
const OVERFLOW_STREAK_LIMIT = 2;
/** Multiply the window by this factor when shrinking. */
const WINDOW_SHRINK_FACTOR = 0.75;
/** Never shrink below this many tokens. */
const WINDOW_MIN = 8_192;

/** Known model family windows. Provider prefixes (e.g. "openai/") are ignored. */
const KNOWN_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["gpt-4o", 128_000],
  ["gpt-4.1", 128_000],
  ["gpt-4.5", 128_000],
  ["gpt-5", 128_000],
  ["gpt-6", 128_000],
  ...["o1", "o2", "o3", "o4", "o5", "o6", "o7", "o8", "o9"].map((id) => [id, 128_000] as [string, number]),
  ["chatgpt-4o", 128_000],
  ["codex", 128_000],
]);

function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().split("/").pop()!;
}

/** Returns the known context window for `modelId`, or DEFAULT_CONTEXT_WINDOW
 * for unknown models. */
export function contextWindowFor(modelId: string): number {
  const known = KNOWN_WINDOWS.get(normalizeModelId(modelId));
  return known !== undefined ? known : DEFAULT_CONTEXT_WINDOW;
}

/** Returns 25% of `window`, clamped to [8000, 32000]. Unknown limits use
 * DEFAULT_CONTEXT_WINDOW. */
export function compactBudget(window: CapabilityLimit): number {
  const size =
    window.status === "known" ? window.value : DEFAULT_CONTEXT_WINDOW;
  return Math.min(
    COMPACT_BUDGET_MAX,
    Math.max(COMPACT_BUDGET_MIN, Math.floor(size * COMPACT_BUDGET_FRACTION)),
  );
}

/** Compaction trigger = max(50% of window, window - 15% reserve). Returns
 * true when `tokens` strictly exceed the trigger. Unknown limits use
 * DEFAULT_CONTEXT_WINDOW. */
export function shouldCompact(tokens: number, window: CapabilityLimit): boolean {
  const size =
    window.status === "known" ? window.value : DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.max(TRIGGER_RESERVE_MIN, Math.floor(size * TRIGGER_RESERVE_FRACTION));
  const trigger = Math.max(Math.floor(size * TRIGGER_HALF), size - reserve);
  return tokens > trigger;
}

/** Tracks consecutive overflow observations per model so a single transient
 * overflow does not shrink the window; only repeated overflow does. */
const overflowStreaks = new Map<string, number>();

/** Adjusts `currentWindow` downward after repeated overflow for `modelId`,
 * and keeps it stable when there is no overflow. Returns the (possibly
 * reduced) window the caller should use next. */
export function learnContextWindow(
  modelId: string,
  currentWindow: number,
  observation: { overflow: boolean },
): number {
  const id = normalizeModelId(modelId);
  const streak = overflowStreaks.get(id) ?? 0;

  if (observation.overflow) {
    const next = streak + 1;
    overflowStreaks.set(id, next);
    if (next < OVERFLOW_STREAK_LIMIT) return currentWindow;
    overflowStreaks.delete(id);
    return Math.max(WINDOW_MIN, Math.floor(currentWindow * WINDOW_SHRINK_FACTOR));
  }

  overflowStreaks.delete(id);
  return currentWindow;
}

/** Counts tokens (not bytes) for every text in `texts` using the BPE-aware
 * tokenizer for `modelId`, and returns the total. */
export function threadTokens(texts: string[], modelId: string): number {
  let total = 0;
  for (const text of texts) {
    total += countTokens(text, modelId);
  }
  return total;
}
