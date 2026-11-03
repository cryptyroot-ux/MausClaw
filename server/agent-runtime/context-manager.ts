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
import {
  TokenCalibration as LegacyTokenCalibration,
  turnCompactBudget,
  offloadToolOutput,
  readToolOutput,
  DEFAULT_KEEP_EXCHANGES,
  refusesContextLength,
  type Offloaded,
} from "../drivers/turn-context.ts";
import type { CapabilityDescriptor, ModelMessage } from "./contracts.ts";
import { countTokens } from "../drivers/tokenizer.ts";

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
  private readonly calibration = new LegacyTokenCalibration();

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
  readonly defaultOffloadBytes = 16_000;
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

export type { CompactionOptions, CompactionResult, CompactionStrategy, Offloaded };
