// Single context/budget API for the MausClaw native engine.
//
// Unifies compaction.ts, context-budget.ts, and the model-loop-only parts of
// drivers/turn-context.ts behind one ContextManager instance. Every adapter
// shares the same manager so context decisions are consistent across providers.

import {
  compactionKeepTokens,
  contextBudget as compactionContextBudget,
  planRecovery,
  chooseBodyCut,
  compactionTranscript,
  compactMessages,
  SUMMARY_PROMPT,
  buildCompactionRecord,
  type CompactionOptions,
  type CompactionResult,
  type CompactionStrategy,
} from "./compaction.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFor,
  compactBudget,
  shouldCompact,
  learnContextWindow,
  threadTokens,
} from "./context-budget.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { prefixBytes } from "../context-rebuild.ts";
import type { CapabilityDescriptor, ModelMessage } from "./contracts.ts";
import { countTokens } from "../drivers/tokenizer.ts";

/** Fraction of window at which a turn compacts before the next model call. */
export const DEFAULT_TURN_COMPACT_AT = 0.75;
/** Default tool offload threshold in bytes. */
export const DEFAULT_OFFLOAD_BYTES = 16_000;
/** Most recent assistant exchanges kept verbatim. */
export const DEFAULT_KEEP_EXCHANGES = 4;
const HEAD_BYTES = 2_000;
const TAIL_BYTES = 1_000;
/** Learns how far the cheap estimate is from the provider's own prompt_tokens, never scaling it below 1. */
export class TokenCalibration {
  private ratio = 1;
  observe(estimated: number, reported: number | undefined) {
    if (!reported || reported <= 0 || estimated <= 0) return;
    this.ratio = Math.min(3, Math.max(1, reported / estimated));
  }
  apply(estimated: number) { return Math.ceil(estimated * this.ratio); }
}

const threadFolder = (dir: string, threadId: string) => join(dir, createHash("sha256").update(threadId).digest("hex").slice(0, 24));

const HANDLE = /^out_[A-Za-z0-9_-]{6,64}$/;

export interface Offloaded { text: string; handle: string; bytes: number }

/** Saves `text` in full and returns head + tail + a note naming the handle; null when it is small enough. */
export function offloadToolOutput(
  text: string,
  input: { dir?: string; threadId: string; callId: string; thresholdBytes?: number },
): Offloaded | null {
  const threshold = input.thresholdBytes ?? DEFAULT_OFFLOAD_BYTES;
  const bytes = Buffer.byteLength(text);
  if (!input.dir || bytes <= threshold) return null;
  const handle = `out_${createHash("sha256").update(`${input.threadId}\0${input.callId}\0${bytes}`).digest("base64url").slice(0, 16)}`;
  const folder = threadFolder(input.dir, input.threadId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${handle}.txt`), text, { mode: 0o600 });
  const head = prefixBytes(text, HEAD_BYTES);
  const tailStart = Math.max(head.length, text.length - TAIL_BYTES);
  const tail = text.slice(tailStart);
  const note = `\n\n[… output shortened: ${text.length} characters in total, ${text.length - head.length - tail.length} omitted. ` +
    `Full output saved with handle ${handle}; call read_tool_output {"handle":"${handle}","offset":${head.length},"limit":8000} to read more.]\n\n`;
  return { text: `${head}${note}${tail}`, handle, bytes };
}

export function readToolOutput(
  args: Record<string, unknown>,
  input: { dir?: string; threadId: string },
): { ok: boolean; text: string } {
  const handle = typeof args.handle === "string" ? args.handle.trim() : "";
  if (!input.dir) return { ok: false, text: "Tool output offload is not enabled for this turn." };
  if (!HANDLE.test(handle)) return { ok: false, text: "Unknown handle: pass the out_… handle from a shortened tool result." };
  const folder = threadFolder(input.dir, input.threadId);
  const file = resolve(folder, `${handle}.txt`);
  if (!file.startsWith(resolve(folder) + sep) || !existsSync(file)) return { ok: false, text: `No saved output for handle ${handle} in this conversation.` };
  const full = readFileSync(file, "utf8");
  const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
  const limit = Math.min(20_000, Math.max(1, Math.floor(Number(args.limit ?? 8_000)) || 8_000));
  const slice = full.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { ok: true, text: `[${handle}: characters ${offset}–${end} of ${full.length}${end < full.length ? `; next offset ${end}` : "; end of output"}]\n${slice}` };
}

/** Turn compaction budget: window * compactAt, clamped. */
export function turnCompactBudget(window: number, compactAt?: number): number {
  const at = typeof compactAt === "number" && Number.isFinite(compactAt) && compactAt > 0 ? compactAt : DEFAULT_TURN_COMPACT_AT;
  return Math.max(1, Math.floor(Math.min(at < 1 ? window * at : at, window * 0.9)));
}

/** A provider's refusal of a prompt over its context window. */
const CONTEXT_OVERFLOW = /context[_ ]length[_ ]exceeded|maximum context length|context (?:window|length) (?:of|is|exceeded)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|too many (?:input )?tokens|reduce the length of the messages|input (?:is )?too long|exceeds (?:the )?available context(?: size)?|request exceeds the maximum|tokens? (?:limit|budget) exceeded/i;

export function refusesContextLength(status: number, body: string): boolean {
  return (status === 400 || status === 413 || status === 422 || status === 500) && CONTEXT_OVERFLOW.test(body);
}

/** Token counting wrapper for consistency across the kernel. */
export function countMessageTokens(message: ModelMessage, modelId?: string): number {
  const text =
    message.content === null || message.content === undefined
      ? ""
      : typeof message.content === "string"
        ? message.content
        : message.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
  return countTokens(text, modelId ?? "gpt-4o");
}

/** Runs token estimation and compaction for a single turn. */
export class ContextManager {
  private readonly calibration = new TokenCalibration();

  /** Estimate tokens for a request (messages + tool schemas), before calibration. */
  estimateRequestTokens(messages: readonly ModelMessage[], tools: readonly CapabilityDescriptor[] = []): number {
    let total = 3;
    for (const message of messages) total += estimateMessageTokens(message);
    if (tools.length) total += Math.ceil(JSON.stringify(tools).length / 4);
    return total;
  }

  /** Apply learned calibration to an estimate. */
  applyCalibration(estimated: number): number {
    return this.calibration.apply(estimated);
  }

  /** Observe provider-reported vs estimated tokens to refine calibration. */
  observeCalibration(estimated: number, reported: number | undefined): void {
    this.calibration.observe(estimated, reported);
  }

  /** Returns the known context window for `modelId`, or DEFAULT_CONTEXT_WINDOW. */
  contextWindowFor(modelId: string): number {
    return contextWindowFor(modelId);
  }

  /** Returns 25% of window clamped to [8000, 32000]. */
  compactBudget(window: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" }): number {
    return compactBudget(window);
  }

  /** Compaction trigger = max(50% of window, window - 15% reserve). */
  shouldCompact(tokens: number, window: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" }): boolean {
    return shouldCompact(tokens, window);
  }

  /** Shrink window after repeated overflow; stable when no overflow. */
  learnContextWindow(modelId: string, currentWindow: number, observation: { readonly overflow: boolean }): number {
    return learnContextWindow(modelId, currentWindow, observation);
  }

  /** Total tokens for an array of texts using the BPE-aware tokenizer. */
  threadTokens(texts: string[], modelId: string): number {
    return threadTokens(texts, modelId);
  }

  /** Default context window when a model is unknown. */
  readonly defaultContextWindow = DEFAULT_CONTEXT_WINDOW;

  /** Default keep exchanges for compaction. */
  readonly defaultKeepExchanges = DEFAULT_KEEP_EXCHANGES;

  /** Multi-tier compaction: sliding-window → summarize → shrink → escalate. */
  compactMessages(messages: readonly ModelMessage[], options: CompactionOptions): CompactionResult & { readonly droppedMessages: readonly ModelMessage[] } {
    return compactMessages(messages, options);
  }

  /** Build the transcript string used for summarization of older messages. */
  compactionTranscript(
    messages: readonly ModelMessage[],
    opts?: { readonly clipChars?: number; readonly maxChars?: number },
  ): string {
    return compactionTranscript(messages, opts);
  }

  /** Proportional keep: 25% of context window, clamped to [8k, 32k]. */
  compactionKeepTokens(
    contextWindow: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" },
  ): number {
    return compactionKeepTokens(contextWindow);
  }

  /** Returns the context window and the compaction trigger point. */
  contextBudget(
    contextWindow: { readonly status: "known"; readonly value: number } | { readonly status: "unknown" },
  ): { readonly window: number; readonly trigger: number } {
    return compactionContextBudget(contextWindow);
  }

  /** Choose a cut point in the body for background summary precomputation. */
  chooseBodyCut(body: readonly ModelMessage[], keepTokens: number, modelId?: string): number {
    return chooseBodyCut(body, keepTokens, modelId);
  }

  /** Plan recovery after context overflow. */
  planRecovery(
    tokenEst: number,
    trigger: number,
    maxTokens: number,
    options: { readonly compactions: number; readonly maxCompactions: number; readonly sizeRetries: number; readonly maxSizeRetries: number; readonly allowSummarize: boolean; readonly allowShrink: boolean },
  ): { readonly action: "none" | "compact" | "shrink" | "escalate" | "fail"; readonly reason: string } {
    return planRecovery(tokenEst, trigger, maxTokens, options);
  }

  /** Build a compaction record for the store. */
  buildCompactionRecord(
    runId: string,
    sequence: number,
    summary: string,
    firstKeptIndex: number,
    tokenEstimate: number,
    trigger: "auto" | "overflow",
    createdAt?: number,
  ): { readonly runId: string; readonly sequence: number; readonly summary: string; readonly firstKeptIndex: number; readonly tokenEstimate: number; readonly trigger: "auto" | "overflow"; readonly createdAt: number } {
    return buildCompactionRecord(runId, sequence, summary, firstKeptIndex, tokenEstimate, trigger, createdAt);
  }

  /** Summarization prompt used when compressing older history. */
  readonly summaryPrompt = SUMMARY_PROMPT;

  /** Turn compaction budget: window * compactAt, clamped. */
  turnCompactBudget(window: number, compactAt?: number): number {
    return turnCompactBudget(window, compactAt);
  }

  /** Offload large tool output to disk, returning a shortened preview + handle. */
  offloadToolOutput(
    text: string,
    input: { dir?: string; threadId: string; callId: string; thresholdBytes?: number },
  ): Offloaded | null {
    return offloadToolOutput(text, input);
  }

  /** Read a previously offloaded tool output by handle. */
  readToolOutput(
    args: Record<string, unknown>,
    input: { dir?: string; threadId: string },
  ): { ok: boolean; text: string } {
    return readToolOutput(args, input);
  }

  /** Check whether a provider response indicates a context-length refusal. */
  refusesContextLength(status: number, body: string): boolean {
    return refusesContextLength(status, body);
  }

  /** Default tool offload threshold in bytes. */
  readonly defaultOffloadBytes = DEFAULT_OFFLOAD_BYTES;
}

/** Estimate tokens for a single message. */
function estimateMessageTokens(message: ModelMessage): number {
  const text =
    message.content === null || message.content === undefined
      ? ""
      : typeof message.content === "string"
        ? message.content
        : message.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
  return Math.ceil(text.length / 4) + 4;
}

export type { CompactionOptions, CompactionResult, CompactionStrategy };
