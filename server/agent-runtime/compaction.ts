// Context compaction & request-size recovery for the MausClaw-native agent engine.
//
// This module replaces the rough JSON.length/4 token estimate and pure-recency
// message selection with model-aware token counting, importance-based message
// scoring, a sliding window with bridge context, and multi-tier request-size
// recovery (compact → shrink → escalate → fail). Designed to outperform Claude
// Code, Codex, OpenCode, Hermes, Pi, and Antigravity on long-thread context
// management.
//
// Contract boundary: no provider wire format, CLI, or capability transport
// leaks through this module. It works purely on ModelMessage arrays.

import type { AgentCompactionRecord, ModelMessage } from "./contracts.ts";
import { countTokens } from "../drivers/tokenizer.ts";
import {
  contextWindowFor,
  compactBudget,
  learnContextWindow,
} from "./context-budget.ts";
import { engineMemory } from "../engine-memory.ts";

// ══════════════════════════════════════════════════════════════════════════════
// Token counting — BPE-aware via gpt-tokenizer, char estimate fallback
// ══════════════════════════════════════════════════════════════════════════════

/** Estimate tokens for a raw string using model-aware BPE counting. */
export function estimateTokensForText(text: string, modelId?: string): number {
  return countTokens(text, modelId);
}

/** Estimate tokens for a single model message, including role/tool-call overhead. */
export function estimateMessageTokens(message: ModelMessage, modelId?: string): number {
  let total = 4; // per-message role/format overhead

  const content = message.content;
  if (content === null || content === undefined) return total;

  if (typeof content === "string") {
    total += countTokens(content, modelId);
  } else {
    for (const part of content) {
      if (part.type === "text") {
        total += countTokens(part.text, modelId);
      } else if (part.type === "image") {
        // Vision: roughly 1 token per 64 bytes of base64-encoded image data.
        total += Math.max(1, Math.ceil(part.data.length / 64));
      }
    }
  }

  if (message.toolCallId) {
    total += countTokens(message.toolCallId, modelId);
  }
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      total += 4; // call overhead
      total += countTokens(call.name, modelId);
      total += countTokens(call.id, modelId);
      total += estimateTokensForText(JSON.stringify(call.arguments), modelId);
    }
  }

  return total;
}

/** Estimate total tokens for an array of messages. */
export function estimateMessagesTokens(messages: readonly ModelMessage[], modelId?: string): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message, modelId);
  }
  return total;
}

/** Choose a compaction cut point within body messages: keep the newest messages
 * within keepTokens, then move the cut so the kept slice never starts with an
 * orphan tool result. Returns the index into `body` where the cut should be. */
export function chooseBodyCut(
  body: readonly ModelMessage[],
  keepTokens: number,
  modelId?: string,
): number {
  let total = 0;
  let cut = body.length;
  for (let index = body.length - 1; index >= 0; index--) {
    const tokens = estimateMessageTokens(body[index], modelId);
    if (total + tokens > keepTokens) break;
    total += tokens;
    cut = index;
  }
  while (cut > 0 && body[cut]?.role === "tool") cut--;
  return cut;
}

// ═════════════════════════════════════════════════════════════════════════════
// Context budget
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Proportional keep: 25% of context window, clamped to [8k, 32k]. */
export function compactionKeepTokens(
  contextWindow: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" },
): number {
  const window = contextWindow.status === "known" ? contextWindow.value : DEFAULT_CONTEXT_WINDOW;
  return Math.min(32_000, Math.max(8_000, Math.floor(window * 0.25)));
}

/** Returns the context window and the compaction trigger point.
 * Trigger = max(50% of window, window - 15% reserve). */
export function contextBudget(
  contextWindow: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" },
): { readonly window: number; readonly trigger: number } {
  const window = contextWindow.status === "known" ? contextWindow.value : DEFAULT_CONTEXT_WINDOW;
  const reserve = Math.max(16_000, Math.floor(window * 0.15));
  return { window, trigger: Math.max(Math.floor(window / 2), window - reserve) };
}

// ═════════════════════════════════════════════════════════════════════════════
// Importance scoring
// ═════════════════════════════════════════════════════════════════════════════

const FILE_PATH_RE = /(?:^|[\s/])[\w.-]+\.[a-zA-Z]{2,}(?:[/?#]\S*)?/;
const ERROR_RE = /\b(error|failed|failure|exception|panic|traceback|not\s+found|404|500|timeout)\b/i;
const DECISION_RE = /\b(decid|chosen|selected|approved|resolved|fixed|completed|done)\b/i;
const CODE_RE = /```[\s\S]*?```|`[^`]+`/;
const QUESTION_RE = /\?/;

interface MessageScore {
  readonly index: number;
  readonly score: number; // 0-100
  readonly reasons: readonly string[];
}

/** Score a single message's importance for compaction retention (0-100).
 * System messages are always scored 100 (caller handles them separately). */
export function scoreMessageImportance(
  message: ModelMessage,
  index: number,
  total: number,
): MessageScore {
  const reasons: string[] = [];
  let score = 0;

  // System messages: never dropped, highest importance.
  if (message.role === "system") {
    return { index, score: 100, reasons: ["system"] };
  }

  // Recency: newer messages score higher (0-40 points).
  const recency = total > 1 ? index / (total - 1) : 1;
  score += Math.round(recency * 40);
  if (recency > 0.8) reasons.push("recent");

  // Role-based base score.
  if (message.role === "user") {
    score += 15;
    reasons.push("user");
    const contentStr = messageContentString(message);
    if (QUESTION_RE.test(contentStr)) {
      score += 5;
      reasons.push("question");
    }
  } else if (message.role === "assistant") {
    score += 10;
    reasons.push("assistant");
    if (message.toolCalls?.length) {
      score += 20;
      reasons.push("tool-calls");
    }
    if (DECISION_RE.test(messageContentString(message))) {
      score += 10;
      reasons.push("decision");
    }
  } else if (message.role === "tool") {
    score += 5;
    reasons.push("tool-result");
    const contentStr = messageContentString(message);
    if (ERROR_RE.test(contentStr)) {
      score += 15;
      reasons.push("error");
    }
    if (FILE_PATH_RE.test(contentStr)) {
      score += 10;
      reasons.push("file-path");
    }
  }

  // Content density: concise messages with high info density score higher.
  const contentStr = messageContentString(message);
  if (contentStr.length > 0 && contentStr.length < 500) {
    score += 5;
    reasons.push("concise");
  }
  if (CODE_RE.test(contentStr)) {
    score += 5;
    reasons.push("code");
  }

  return { index, score: Math.min(score, 100), reasons };
}

function messageContentString(message: ModelMessage): string {
  if (message.content === null || message.content === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
}

// ═════════════════════════════════════════════════════════════════════════════
// Compaction tiers & result
// ═════════════════════════════════════════════════════════════════════════════

export type CompactionStrategy = "none" | "sliding-window" | "summarize" | "shrink" | "escalate";

export interface CompactionOptions {
  /** Target token budget for kept (non-summary) messages. */
  readonly keepTokens: number;
  /** Hard limit: if even after compaction we exceed this, strategy is "escalate". */
  readonly maxTokens: number;
  /** Model ID for token counting. */
  readonly modelId?: string;
  /** Whether summarization (model call) is available. */
  readonly allowSummarize: boolean;
  /** Whether aggressive shrinking (truncate outputs, drop images) is available. */
  readonly allowShrink: boolean;
  /** Minimum non-system messages to keep besides the last user turn. */
  readonly minKeepMessages: number;
  /** Number of bridge messages immediately before the last user turn to keep for continuity. */
  readonly bridgeMessages: number;
}

export interface CompactionResult {
  readonly messages: ModelMessage[];
  readonly droppedCount: number;
  readonly savedTokens: number;
  readonly strategy: CompactionStrategy;
  readonly qualityScore: number; // 0-100, approx. context preserved
  readonly summary?: string;
}

/** Build the transcript string used for summarization of older messages. */
export function compactionTranscript(
  messages: readonly ModelMessage[],
  { clipChars = 2_000, maxChars = 120_000 }: { readonly clipChars?: number; readonly maxChars?: number } = {},
): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    const content = messageContentString(message);
    const text = content.length > clipChars ? `${content.slice(0, clipChars)}…` : content;
    const calls = message.toolCalls?.length
      ? `\nTOOL CALLS: ${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join("; ")}`
      : "";
    const line = `${message.role.toUpperCase()}: ${text}${calls}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

/** Summary prompt used when asking the model to compress older history. */
export const SUMMARY_PROMPT = [
  "You are compacting an agent conversation so it can continue in a smaller context window.",
  "Preserve, in this order: the person's objective and constraints; decisions already made; files read or changed (exact paths);",
  "commands, tests, and their results; unresolved errors and risks; exact identifiers the next turn needs.",
  "Drop greetings, repeated reasoning, and superseded plans. Do not invent facts. Output only the summary, in compact Markdown.",
].join(" ");

const SHORT_TOOL_CHARS = 2_000;
const OMITTED_IMAGE = "[image omitted to fit the provider's size limit]";

/** Multi-tier compaction: sliding window → (optional) summarize → shrink → escalate.
 *
 * Tier 1 (sliding-window): keep system + last user turn + bridge messages +
 * highest-importance messages within keepTokens. Replaces dropped messages with
 * a note if no summarization is available.
 *
 * Tier 2 (summarize): caller uses the returned `droppedMessages` transcript to
 * generate a summary via the model, then splices it in.
 *
 * Tier 3 (shrink): truncate long tool outputs, replace images with text.
 *
 * Tier 4 (escalate): return best-effort result; caller should try a fallback
 * model with a larger context window or fail.
 */
export function compactMessages(
  messages: readonly ModelMessage[],
  options: CompactionOptions,
): CompactionResult & { readonly droppedMessages: readonly ModelMessage[] } {
  const {
    keepTokens: configuredKeepTokens,
    modelId,
    allowShrink,
    minKeepMessages = 2,
    bridgeMessages = 2,
  } = options;

  const totalTokens = estimateMessagesTokens(messages, modelId);

  // Adaptive keepTokens: when a model id is provided, derive the budget from
  // the model's learned context window so that repeated overflow lowers it.
  let effectiveKeepTokens = configuredKeepTokens;
  let overflow = false;
  if (modelId) {
    const window = contextWindowFor(modelId);
    overflow = totalTokens > configuredKeepTokens;
    const learnedWindow = learnContextWindow(modelId, window, { overflow });
    effectiveKeepTokens = Math.min(
      configuredKeepTokens,
      compactBudget({ status: "known", value: learnedWindow }),
    );
  }

  if (totalTokens <= effectiveKeepTokens) {
    return {
      messages: [...messages],
      droppedCount: 0,
      savedTokens: 0,
      strategy: "none",
      qualityScore: 100,
      droppedMessages: [],
    };
  }

  const system = messages.filter((m) => m.role === "system");
  const body = messages.filter((m) => m.role !== "system");
  const systemTokens = estimateMessagesTokens(system, modelId);

  if (body.length === 0) {
    return {
      messages: [...messages],
      droppedCount: 0,
      savedTokens: 0,
      strategy: "none",
      qualityScore: 100,
      droppedMessages: [],
    };
  }

  // Always keep the last user message (current turn).
  const lastUserIndex = body.findLastIndex((m) => m.role === "user");
  if (lastUserIndex < 0) {
    return {
      messages: [...messages],
      droppedCount: 0,
      savedTokens: 0,
      strategy: "none",
      qualityScore: 100,
      droppedMessages: [],
    };
  }

  // Score all body messages for importance.
  const scored = body.map((m, i) => scoreMessageImportance(m, i, body.length));

  // Determine kept indices.
  const keptIndices = new Set<number>([lastUserIndex]);

  // Add bridge messages immediately before the last user turn for continuity.
  const bridgeStart = Math.max(0, lastUserIndex - bridgeMessages);
  for (let i = bridgeStart; i < lastUserIndex; i++) {
    keptIndices.add(i);
  }

  // Budget available for non-system messages.
  const availableTokens = effectiveKeepTokens - systemTokens;
  let usedTokens = estimateMessagesTokens(
    body.filter((_, i) => keptIndices.has(i)),
    modelId,
  );

  // Add highest-importance messages within budget (sorted by score desc, then index asc for stability).
  const byScore = [...scored]
    .filter((s) => !keptIndices.has(s.index))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  for (const { index } of byScore) {
    if (usedTokens >= availableTokens) break;
    const msgTokens = estimateMessageTokens(body[index], modelId);
    if (usedTokens + msgTokens > availableTokens) continue;
    keptIndices.add(index);
    usedTokens += msgTokens;
  }

  // Ensure minimum keep (besides last user).
  let keptNonUser = body.filter((_, i) => keptIndices.has(i) && i !== lastUserIndex).length;
  if (keptNonUser < minKeepMessages && body.length > 1) {
    const candidates = scored
      .filter((s) => s.index !== lastUserIndex && !keptIndices.has(s.index))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { index } of candidates) {
      if (keptNonUser >= minKeepMessages) break;
      const msgTokens = estimateMessageTokens(body[index], modelId);
      if (usedTokens + msgTokens > availableTokens) break;
      keptIndices.add(index);
      usedTokens += msgTokens;
      keptNonUser++;
    }
  }

  const keptBody = body.filter((_, i) => keptIndices.has(i));
  const droppedMessages = body.filter((_, i) => !keptIndices.has(i));
  const droppedCount = droppedMessages.length;

  if (droppedCount === 0) {
    return {
      messages: [...messages],
      droppedCount: 0,
      savedTokens: 0,
      strategy: "none",
      qualityScore: 100,
      droppedMessages: [],
    };
  }

  const keptTokens = estimateMessagesTokens([...system, ...keptBody], modelId);

  // Tier 1: sliding-window result fits within budget.
  if (keptTokens <= effectiveKeepTokens) {
    const resultMessages: ModelMessage[] = [...system];
    if (droppedCount > 0) {
      resultMessages.push({
        role: "assistant",
        content: `[${droppedCount} earlier message${droppedCount === 1 ? "" : "s"} compacted to fit the context window.]`,
      });
    }
    resultMessages.push(...keptBody);
    const finalTokens = estimateMessagesTokens(resultMessages, modelId);
    return {
      messages: resultMessages,
      droppedCount,
      savedTokens: totalTokens - finalTokens,
      strategy: "sliding-window",
      qualityScore: Math.round((finalTokens / totalTokens) * 100),
      droppedMessages,
    };
  }

  // Tier 3: aggressive shrink (truncate tool outputs, drop images).
  if (allowShrink) {
    // Image replacement happens before tool-output truncation.
    let toolLimit = SHORT_TOOL_CHARS;
    let shrunkBody = shrinkBody(keptBody, toolLimit);
    let shrunkTokens = estimateMessagesTokens([...system, ...shrunkBody], modelId);

    // Progressive truncation: if the shrunk result still exceeds the budget,
    // reduce the tool-output limit and retry until it fits or the limit bottoms out.
    while (shrunkTokens > effectiveKeepTokens && toolLimit > 256) {
      toolLimit = Math.floor(toolLimit * 0.5);
      shrunkBody = shrinkBody(keptBody, toolLimit);
      shrunkTokens = estimateMessagesTokens([...system, ...shrunkBody], modelId);
    }

    if (shrunkTokens <= effectiveKeepTokens) {
      const resultMessages: ModelMessage[] = [...system];
      if (droppedCount > 0) {
        resultMessages.push({
          role: "assistant",
          content: `[${droppedCount} earlier message${droppedCount === 1 ? "" : "s"} compacted to fit the context window.]`,
        });
      }
      resultMessages.push(...shrunkBody);
      const finalTokens = estimateMessagesTokens(resultMessages, modelId);
      return {
        messages: resultMessages,
        droppedCount,
        savedTokens: totalTokens - finalTokens,
        strategy: "shrink",
        qualityScore: Math.round((finalTokens / totalTokens) * 100),
        droppedMessages,
      };
    }
  }

  // Tier 4: escalate — cannot fit within budget even after compaction.
  const resultMessages: ModelMessage[] = [...system];
  if (droppedCount > 0) {
    resultMessages.push({
      role: "assistant",
      content: `[${droppedCount} earlier message${droppedCount === 1 ? "" : "s"} compacted to fit the context window.]`,
    });
  }
  resultMessages.push(...keptBody);
  const finalTokens = estimateMessagesTokens(resultMessages, modelId);
  return {
    messages: resultMessages,
    droppedCount,
    savedTokens: totalTokens - finalTokens,
    strategy: "escalate",
    qualityScore: Math.round((finalTokens / totalTokens) * 100),
    droppedMessages,
  };
}

/** Shrink a kept message body: images become text first, then long tool
 * outputs are cut at the last complete line/sentence boundary within `toolLimit`. */
function shrinkBody(body: readonly ModelMessage[], toolLimit: number): ModelMessage[] {
  return body.map((m) => {
    // Image replacement happens before tool-output truncation.
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) =>
          p.type === "image" ? { type: "text" as const, text: OMITTED_IMAGE } : p,
        ),
      };
    }
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > toolLimit) {
      return { ...m, content: truncateToolOutput(m.content, toolLimit) };
    }
    return m;
  });
}

/** Cut `text` at the last complete sentence or line within `limit`, then
 * append the omission notice. Falls back to a hard cut at `limit`. */
function truncateToolOutput(text: string, limit: number): string {
  const slice = text.slice(0, limit);
  const sentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("!\n"),
    slice.lastIndexOf("?\n"),
  );
  const line = slice.lastIndexOf("\n");
  const cut = sentence >= 0 ? sentence + 1 : line >= 0 ? line + 1 : limit;
  return `${text.slice(0, Math.min(cut, limit))}\n[tool output shortened to fit the provider's size limit]`;
}

// ════════════════════════════════════════════════════════════════════════════
// Request-size recovery planning
// ═════════════════════════════════════════════════════════════════════════════

/** Effective compaction trigger adjusted for memory pressure.
 *
 * The base trigger is max(50% of window, window - 15% reserve). When
 * engineMemory.headroom() is below 0.3 the trigger is scaled down so
 * compaction starts earlier; at or above 0.3 (including > 0.7) it is normal.
 */
export function compactionTrigger(headroom: number, window: number): number {
  const reserve = Math.max(16_000, Math.floor(window * 0.15));
  const baseTrigger = Math.max(Math.floor(window / 2), window - reserve);
  if (headroom < 0.3) {
    return Math.floor(baseTrigger * Math.max(0, Math.min(1, headroom / 0.3)));
  }
  return baseTrigger;
}

export type RecoveryAction = "none" | "compact" | "shrink" | "escalate" | "fail";

/** Decide what recovery action to take given the current token estimate and
 * the provider's reported rejected size (for request_too_large errors). */
export function planRecovery(
  tokenEst: number,
  trigger: number,
  maxTokens: number,
  options: {
    readonly compactions: number;
    readonly maxCompactions: number;
    readonly sizeRetries: number;
    readonly maxSizeRetries: number;
    readonly allowSummarize: boolean;
    readonly allowShrink: boolean;
  },
): { readonly action: RecoveryAction; readonly reason: string } {
  const { compactions, maxCompactions, sizeRetries, maxSizeRetries, allowSummarize, allowShrink } = options;

  // OOM-aware trigger: under memory pressure compact earlier by lowering the
  // trigger; at healthy headroom use the trigger as given.
  const headroom = engineMemory.headroom();
  const effectiveTrigger =
    headroom < 0.3 ? Math.floor(trigger * Math.max(0.25, headroom / 0.3)) : trigger;

  if (tokenEst <= effectiveTrigger) {
    return { action: "none", reason: "within budget" };
  }

  if (compactions < maxCompactions && allowSummarize) {
    return { action: "compact", reason: "over trigger, compaction slots available" };
  }

  if (sizeRetries < maxSizeRetries && allowShrink) {
    return { action: "shrink", reason: "compactions exhausted, shrink available" };
  }

  if (tokenEst > maxTokens) {
    return { action: "escalate", reason: "over hard limit, try fallback model" };
  }

  return { action: "fail", reason: "all recovery strategies exhausted" };
}

// ═════════════════════════════════════════════════════════════════════════════
// Compaction record builder (for AgentRunStore.recordCompaction)
// ═════════════════════════════════════════════════════════════════════════════

export function buildCompactionRecord(
  runId: string,
  sequence: number,
  summary: string,
  firstKeptIndex: number,
  tokenEstimate: number,
  trigger: "auto" | "overflow",
  createdAt: number = Date.now(),
): AgentCompactionRecord {
  return {
    runId,
    sequence,
    summary,
    firstKeptIndex,
    tokenEstimate,
    trigger,
    createdAt,
  };
}
