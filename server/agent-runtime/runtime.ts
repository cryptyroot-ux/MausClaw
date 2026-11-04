import { randomUUID } from "node:crypto";

import { computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../drivers/retry.ts";
import { announcesAction, MAX_ANNOUNCEMENT_NUDGES, NUDGE_ANNOUNCED_ACTION } from "./announcement.ts";
import { workspaceDir } from "../workspace.ts";
import { parseToolScope, allowsTool } from "../../shared/tool-scope.ts";
import { snapshot as createCheckpoint, rollback } from "../checkpoints.ts";
import { createRunScopedCapabilitySession, TOOL_OUTPUT_READ_CAPABILITY } from "./capability-runtime.ts";
import {
  compactionKeepTokens,
  contextBudget,
  estimateMessagesTokens,
  planRecovery,
  chooseBodyCut,
  compactionTranscript,
  compactMessages,
  SUMMARY_PROMPT,
  buildCompactionRecord,
} from "./compaction.ts";
import type {
  AgentEngine,
  AgentEvent,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunStatus,
  AgentRunStore,
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityResult,
  ModelAdapter,
  ModelAdapterError,
  ModelCapabilities,
  ModelContentPart,
  ModelMessage,
  ModelToolCall,
} from "./contracts.ts";
import type { LiveProbeResult } from "./capability-probe.ts";

const MAX_MODEL_ROUNDS = 64;
const MAX_TOOL_CALLS = 200;
/** Mirrors the chat image budget: 32 MiB of encoded base64 per run. */
const MAX_ENCODED_IMAGE_BYTES = Math.ceil(32 * 1024 * 1024 / 3) * 4;

const COMPACTION_MIN_MESSAGES = 6;
const COMPACTION_MAX_PER_RUN = 3;
const COMPACTION_MIN_MESSAGE_GAP = 4;
const SUMMARY_MAX_CHARS = 4_000;
const TOOL_OUTPUT_PROMPT_CHARS = 8_000;
/** Above this length, a tool output string is truncated on request_too_large recovery. */
const SHORT_TOOL_CHARS = 2_000;
const OMITTED_IMAGE = "[image omitted to fit the provider's size limit]";

class AgentRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentRuntimeError";
  }
}

function isModelAdapterError(error: unknown): error is ModelAdapterError {
  if (!(error instanceof Error)) return false;
  const candidate = error as ModelAdapterError;
  return ["transient", "unsupported_capability", "unsupported_tools", "request_too_large", "invalid_request", "terminal"].includes(candidate.code)
    && typeof candidate.retryable === "boolean"
    && typeof candidate.retrySafe === "boolean"
    && typeof candidate.requestStarted === "boolean";
}

function errorCode(error: unknown): string {
  if (error instanceof AgentRuntimeError) return error.code;
  if (isModelAdapterError(error)) return error.code;
  return "terminal";
}

function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 2_000);
  return "The native agent run failed.";
}

function modelEventFailure(message: string): AgentRuntimeError {
  return new AgentRuntimeError("invalid_model_response", message);
}

/** Normalize provider-specific finish reasons to a canonical set.
 *  Normal completion reasons map to "stop"; error/incomplete reasons pass through
 *  so they trigger the existing failure path at line 877. */
const NORMAL_FINISH_REASONS = new Set(["stop", "end_turn", "STOP", "completed"]);
function normalizeFinishReason(reason: string | null): string | null {
  if (reason === null) return null;
  return NORMAL_FINISH_REASONS.has(reason) ? "stop" : reason;
}

/** Merge live probe results over static model capabilities. The live probe is ground truth
 *  for features it actually exercises (tools, streaming); static hints provide everything
 *  else (context window, modalities the probe does not test such as image input). */
function mergeLiveCapabilities(staticCaps: ModelCapabilities, live: LiveProbeResult | undefined): ModelCapabilities {
  if (!live) return staticCaps;
  return {
    ...staticCaps,
    tools: live.tools ? "supported" : "unsupported",
    streaming: live.streaming ? "supported" : "unsupported",
  };
}

/** Shorten content that may exceed the provider's request size:
 * converts image parts to a placeholder text and truncates long tool outputs.
 * Returns new message objects (message content is read-only).
 */
function shortenMessageContents(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const content = message.content;
    if (content === null || content === undefined) return message;
    if (Array.isArray(content)) {
      if (content.some((part) => part.type === "image")) {
        return {
          ...message,
          content: content.map((part) =>
            part.type === "image" ? { type: "text" as const, text: OMITTED_IMAGE } : part,
          ),
        };
      }
      return message;
    }
    if (message.role === "tool" && content.length > SHORT_TOOL_CHARS) {
      return {
        ...message,
        content: `${content.slice(0, SHORT_TOOL_CHARS)}\n[tool output shortened to fit the provider's size limit]`,
      };
    }
    return message;
  });
}

export function createAgentEngine(dependencies: {
  readonly adapters: { resolve(ref: AgentRunRecord["providerModel"]): ModelAdapter };
  readonly store: AgentRunStore;
  /** Optional live capability probe: verifies tools/streaming against the real adapter.
   *  Results are cached per modelId; a failed probe is retried on the next run. */
  readonly probe?: { run(adapter: ModelAdapter, modelId: string): Promise<LiveProbeResult | null> };
  /** Optional Intelligence Layer: classifies tasks, routes models, estimates cost. */
  readonly intelligence?: {
    readonly enabled: boolean;
    readonly decide: (input: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean; messages: ReadonlyArray<{ content: string | null | undefined }>; primaryModel: AgentRunRecord["providerModel"] }) => { readonly allowed: boolean; readonly reason?: string; readonly route: { readonly candidates: ReadonlyArray<AgentRunRecord["providerModel"]> } };
    readonly log?: (entry: { readonly kind: string; readonly detail: string }) => void;
    readonly verify?: (output: string) => { ok: boolean; feedback: string } | Promise<{ ok: boolean; feedback: string }>;
  };
  /** Enable response caching for identical model requests. */
  readonly cacheEnabled?: boolean;
  /** Optional plugin registry: additional capability providers loaded at runtime. */
  readonly plugins?: { readonly list: () => ReadonlyArray<{ readonly manifest: { readonly name: string }; readonly capabilities: ReadonlyArray<string> }> };
  /** Optional orchestrator: multi-step task orchestration with swarm support. */
  readonly orchestrator?: {
    readonly runPlan: (steps: ReadonlyArray<unknown>, context: unknown) => { planId: string; done: Promise<void> };
    readonly onEvent: (planId: string, listener: (event: unknown) => void) => () => void;
    readonly interrupt: (planId: string) => void;
  };
}): AgentEngine {
  const active = new Map<string, {
    readonly threadId: string;
    readonly controller: AbortController;
    readonly steers: string[];
    finishing: boolean;
  }>();
  const activeByThread = new Map<string, string>();
  const listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  /** Live probe results cached per modelId for the engine's lifetime. Only successful probes
   *  are cached; failed probes are retried on the next run (cheap when there is no API key). */
  const liveProbeCache = new Map<string, LiveProbeResult>();

  const emit = (threadId: string, event: AgentEvent) => {
    for (const listener of Array.from(listeners.get(threadId) ?? [])) listener(event);
  };

  const transition = (runId: string, from: AgentRunStatus, to: AgentRunStatus, failureCode?: string): void => {
    if (!dependencies.store.transitionRun(runId, from, to, Date.now(), failureCode)) {
      throw new AgentRuntimeError("run_state_conflict", `Could not transition run from ${from} to ${to}`);
    }
  };

  return {
    engineId: "mausclaw-native",

    async run(request: AgentRunRequest) {
      if (activeByThread.has(request.threadId)) throw new AgentRuntimeError("thread_busy", "A native run is already active for this thread");

      const runId = randomUUID();
      const runCapabilities = createRunScopedCapabilitySession(request.capabilities, { runId, store: dependencies.store });

      // Plugin System: mount plugin capabilities into the capability session.
      // Plugins declare capabilities (names) and optionally provide handlers.
      // If the base session supports registration (InMemoryCapabilitySession),
      // register each plugin capability with its handler.
      if (dependencies.plugins) {
        const loaded = dependencies.plugins.list();
        if (loaded.length > 0) {
          emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: loaded.map((p) => p.manifest.name) });
          const pluginCaps = loaded.flatMap((p) => p.capabilities);
          if (pluginCaps.length > 0) {
            const session = runCapabilities as { register?: (d: any, h: any) => void };
            if (typeof session.register === "function" && "getCapabilityHandlers" in dependencies.plugins) {
              const handlers = (dependencies.plugins as any).getCapabilityHandlers?.();
              if (handlers) {
                for (const [name, { handler, pluginName }] of handlers) {
                  const descriptor = { id: name, name, description: `Plugin capability from ${pluginName}`, schema: { type: "object", properties: {}, additionalProperties: true }, risk: "read" as const, sideEffect: false, timeoutMs: 30_000 };
                  try { session.register(descriptor, handler); } catch { /* session may not support registration */ }
                }
              }
            }
            emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: pluginCaps });
          }
        }
      }
      const startedAt = Date.now();
      dependencies.store.createRun({
        runId,
        engineId: "mausclaw-native",
        providerModel: request.providerModel,
        status: "queued",
        threadId: request.threadId,
        botId: request.botId,
        startedAt,
        updatedAt: startedAt,
        modelRounds: 0,
        toolCalls: 0,
      });

      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal]);
      const control = { threadId: request.threadId, controller, steers: [] as string[], finishing: false };
      active.set(runId, control);
      activeByThread.set(request.threadId, runId);

      const done = Promise.resolve().then(async () => {
        const runStatus: { value: AgentRunStatus } = { value: "queued" };
        let modelRounds = 0;
        let toolCalls = 0;
        let outputVisible = false;
        let capabilityDispatched = false;
        let capabilityFailure = false;
        let verificationFailure = false;
        let verificationFeedback = "";
        let completed = false;
        let stopReason: string | null = null;
        let failure: unknown;
        let sessionClosed = false;
        const initialImages = request.images ?? [];
        let encodedImages = initialImages.reduce((total, image) => total + image.data.length, 0);
        if (encodedImages > MAX_ENCODED_IMAGE_BYTES) {
          throw new AgentRuntimeError("image_budget_exceeded", "Turn image budget exceeded (32 MiB encoded); the turn was not sent.");
        }
        const userContent: ModelMessage["content"] = initialImages.length
          ? [
              { type: "text", text: request.text },
              ...initialImages.map((image): ModelContentPart => ({ type: "image", mimeType: image.mimeType, data: image.data })),
            ]
          : request.text;
        const messages: ModelMessage[] = [...request.messages, { role: "user", content: userContent }];
        const seenCallIds = new Set<string>();
        let nudges = 0;
        let callsAtNudge = -1;
        let correctiveRounds = 0;

        const progress = () => dependencies.store.updateRunProgress(runId, { modelRounds, toolCalls, updatedAt: Date.now() });
        const updateStatus = (next: AgentRunStatus, code?: string) => {
          transition(runId, runStatus.value, next, code);
          runStatus.value = next;
        };
        const closeSession = async () => {
          if (sessionClosed) return;
          sessionClosed = true;
          await runCapabilities.close();
        };

        try {
          signal.throwIfAborted();
          updateStatus("running");
          emit(request.threadId, { type: "run.started", runId, engineId: "mausclaw-native", providerModel: request.providerModel });

          const adapterChain = [dependencies.adapters.resolve(request.providerModel), ...(request.fallbackProviders ?? []).map((ref) => dependencies.adapters.resolve(ref))];
          let adapterIndex = 0;
          let adapter = adapterChain[0]!;
          if (dependencies.cacheEnabled) {
            const { createCachingAdapter } = await import("./caching-adapter.ts");
            adapter = createCachingAdapter(adapter);
          }
          let currentModelId = request.providerModel.modelId;
          // Plugin System: log loaded plugin capabilities for observability.
          if (dependencies.plugins) {
            const loaded = dependencies.plugins.list();
            if (loaded.length > 0) {
              emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: loaded.map((p) => p.manifest.name) });
            }
          }

          // Live probe: verify tools/streaming against the real adapter before trusting static hints.
          // Cached per modelId; a failed probe falls back to static capabilities and retries next run.
          // The probe must not block a turn indefinitely: if the adapter never answers
          // (e.g. a test fixture that ends the response before sending a body), fall back
          // to static capabilities and retry the probe on the next run.
          let liveCaps: LiveProbeResult | undefined;
          if (dependencies.probe && !liveProbeCache.has(currentModelId)) {
            const probed = await Promise.race([
              dependencies.probe.run(adapter, currentModelId),
              new Promise<LiveProbeResult | null>((resolve) => {
                setTimeout(() => resolve(null), 5_000);
              }),
            ]);
            if (probed) {
              liveProbeCache.set(currentModelId, probed);
              liveCaps = probed;
            }
          } else if (dependencies.probe) {
            liveCaps = liveProbeCache.get(currentModelId);
          }
          // Intelligence Layer: classify task, route model, estimate cost.
          if (dependencies.intelligence?.enabled) {
            const intelligenceDecision = dependencies.intelligence.decide({
              text: request.text,
              messageCount: messages.length,
              toolCount: request.capabilities ? 0 : 0,
              hasImages: initialImages.length > 0,
              hasCode: /```|function\\s+\\w|class\\s+\\w/.test(request.text),
              messages: messages.map((m) => ({ content: typeof m.content === "string" ? m.content : null })),
              primaryModel: request.providerModel,
            });
            dependencies.intelligence.log?.({ kind: "intelligence.decide", detail: JSON.stringify({ allowed: intelligenceDecision.allowed, reason: intelligenceDecision.reason }) });
            if (!intelligenceDecision.allowed) {
              updateStatus("failed", "budget_exceeded");
              emit(request.threadId, { type: "run.failed", runId, message: intelligenceDecision.reason ?? "Budget exceeded", code: "budget_exceeded" });
              await closeSession();
              return;
            }
            if (intelligenceDecision.route.candidates.length > 0) {
              const routedRef = intelligenceDecision.route.candidates[0]!;
              if (routedRef.modelId !== currentModelId || routedRef.providerId !== request.providerModel.providerId) {
                try {
                  adapter = dependencies.adapters.resolve(routedRef);
                  currentModelId = routedRef.modelId;
                } catch {
                  // Keep original adapter if routing fails.
                }
              }
            }
          }
          const modelCapabilities = mergeLiveCapabilities(adapter.capabilities(currentModelId), liveCaps);
          const budget = contextBudget(modelCapabilities.contextWindow);
          const runBudget = request.budget;
          const runStartedAt = Date.now();
          let budgetExhausted = false;
          let totalTokens = 0;
          let totalCost = 0;
          let hasCost = false;
          let compactions = 0;
          let lastCompactAttempt = 0;
          let lastReportedInputTokens = 0;
          const keepTokens = compactionKeepTokens(modelCapabilities.contextWindow);
          const precomputeTrigger = Math.floor(budget.trigger * 0.7);
          let precomputed: { readonly summary: string; readonly cut: number; readonly messageCount: number; readonly model: string } | null = null;
          let overflowRejected = false;
          const allowSummarize = true;
          const allowShrink = true;
          let sizeRetries = 0;

          const firePrecompute = (): void => {
            if (compactions >= COMPACTION_MAX_PER_RUN || messages.length < COMPACTION_MIN_MESSAGES) return;
            const body = messages.filter((m) => m.role !== "system");
            const cut = chooseBodyCut(body, keepTokens, currentModelId);
            if (cut <= 0 || cut >= body.length - 1) return;
            const older = body.slice(0, cut);
            if (older.length < 2) return;
            const transcript = compactionTranscript(older);
            if (!transcript.trim()) return;
            const snapshotCount = messages.length;
            const snapshotModel = currentModelId;
            void (async () => {
              let summary = "";
              try {
                for await (const event of adapter.generate({
                  messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: transcript }],
                  model: currentModelId,
                  tools: [],
                  signal,
                })) {
                  if (event.type === "content.delta" && event.kind === "assistant_text") summary += event.delta;
                }
              } catch {
                return;
              }
              summary = summary.trim();
              if (!summary) return;
              if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS) + "…";
              if (messages.length !== snapshotCount) return;
              if (request.providerModel.modelId !== snapshotModel) return;
              precomputed = { summary, cut, messageCount: snapshotCount, model: snapshotModel };
            })();
          };

          /** Compact the message list in place using the multi-tier compaction engine.
           * Returns true when compaction was applied, false when no compaction was possible. */
          const doCompact = async (trigger: "auto" | "overflow"): Promise<boolean> => {
            if (trigger === "overflow") overflowRejected = true;
            if (compactions >= COMPACTION_MAX_PER_RUN || messages.length < COMPACTION_MIN_MESSAGES) return false;
            const result = compactMessages(messages, {
              keepTokens,
              maxTokens: budget.window,
              modelId: currentModelId,
              allowSummarize,
              allowShrink,
              minKeepMessages: 2,
              bridgeMessages: 2,
            });
            if (result.droppedCount === 0) return false;
            // Prefer precomputed summary if still valid.
            let summary = "";
            const pc = precomputed;
            if (pc && pc.messageCount === messages.length && pc.model === currentModelId && pc.cut > 0) {
              const body = messages.filter((m) => m.role !== "system");
              if (pc.cut < body.length - 1) {
                const older = body.slice(0, pc.cut);
                if (older.length >= 2) summary = pc.summary;
              }
            }
            if (!summary) {
              modelRounds++;
              progress();
              try {
                for await (const event of adapter.generate({
                  messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: compactionTranscript(result.droppedMessages) }],
                  model: currentModelId,
                  tools: [],
                  signal,
                })) {
                  if (event.type === "content.delta" && event.kind === "assistant_text") summary += event.delta;
                }
              } catch {
                return false;
              }
              summary = summary.trim();
              if (!summary) return false;
              if (summary.length > SUMMARY_MAX_CHARS) summary = summary.slice(0, SUMMARY_MAX_CHARS) + "…";
            }
            const summaryMessage: ModelMessage = {
              role: "user",
              content: `[Earlier conversation summary — ${result.droppedMessages.length} message${result.droppedMessages.length === 1 ? "" : "s"} compacted to fit the context window. The full transcript remains in the app.]\n\n${summary}`,
            };
            const system = messages.filter((m: ModelMessage) => m.role === "system");
            const newMessages: ModelMessage[] = [...system, summaryMessage, ...result.messages.filter((m: ModelMessage) => m.role !== "system")];
            messages.splice(0, messages.length, ...newMessages);
            compactions++;
            lastCompactAttempt = messages.length;
            const tokenEstimate = estimateMessagesTokens(messages, currentModelId);
            dependencies.store.recordCompaction?.(buildCompactionRecord(runId, compactions, summary, result.messages.length, tokenEstimate, trigger, Date.now()));
            emit(request.threadId, { type: "run.compacted", runId, summary, firstKeptIndex: system.length + 1, tokenEstimate, trigger });
            precomputed = null;
            return true;
          };
          let allowTools = true;
          while (modelRounds < MAX_MODEL_ROUNDS) {
            signal.throwIfAborted();
            if (control.steers.length) {
              messages.push({ role: "user", content: control.steers.splice(0).join("\n\n") });
              precomputed = null;
            }
            if (runBudget?.maxWallTimeMs && Date.now() - runStartedAt > runBudget.maxWallTimeMs) {
              budgetExhausted = true;
            }
            if (budgetExhausted) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            const tokenEst = estimateMessagesTokens(messages, currentModelId);
            // Fire background precompute early (OpenCode-style).
            // Precompute only while approaching (not yet over) the trigger, so we don't
            // fire a redundant summary call when compaction is already required now.
            if (tokenEst > precomputeTrigger && tokenEst <= budget.trigger && !precomputed && !overflowRejected) {
              firePrecompute();
            }
            if (
              compactions < COMPACTION_MAX_PER_RUN
              && messages.length - lastCompactAttempt >= COMPACTION_MIN_MESSAGE_GAP
              && (tokenEst > budget.trigger || lastReportedInputTokens > budget.trigger)
            ) {
              const recovery = planRecovery(tokenEst, budget.trigger, budget.window, {
                compactions,
                maxCompactions: COMPACTION_MAX_PER_RUN,
                sizeRetries,
                maxSizeRetries: 2,
                allowSummarize,
                allowShrink,
              });
              if (recovery.action === "compact" || recovery.action === "shrink") {
                let allowCompact = true;
                if (request.hooks) {
                  const hr = await request.hooks.run("pre_compact", { runId, threadId: request.threadId, botId: request.botId });
                  allowCompact = hr.allow;
                }
                if (allowCompact) await doCompact("auto");
              } else if (recovery.action === "escalate") {
                // All compaction strategies exhausted; try a fallback model or fail below.
                overflowRejected = true;
              }
              precomputed = null;
            }
            let toolDescriptors = allowTools ? runCapabilities.list(request.grant) : [];
            if (toolDescriptors.length > 0 && modelCapabilities.tools !== "supported") {
              throw new AgentRuntimeError("unsupported_capability", "The selected model is not verified for structured tool calls");
            }

            let responseText = "";
            let responseCalls: ReadonlyArray<ModelToolCall> = [];
            let finishReason: string | null = null;
            let sawCompletion = false;
            let attempt = 0;

            for (;;) {
              signal.throwIfAborted();
              responseText = "";
              responseCalls = [];
              finishReason = null;
              sawCompletion = false;
              modelRounds++;
              progress();
              try {
                for await (const event of adapter.generate({
                  messages,
                  model: currentModelId,
                  tools: toolDescriptors,
                  signal,
                })) {
                  signal.throwIfAborted();
                  switch (event.type) {
                    case "content.delta":
                      if (event.kind === "assistant_text") {
                        responseText += event.delta;
                        if (event.delta) outputVisible = true;
                      }
                      emit(request.threadId, { type: "model.delta", runId, kind: event.kind, delta: event.delta });
                      break;
                    case "tool_calls":
                      if (responseCalls.length) throw modelEventFailure("The model emitted more than one tool-call batch in a round");
                      responseCalls = event.calls;
                      break;
                    case "usage":
                      totalTokens += event.input + event.output;
                      if (event.costUsd !== undefined) { totalCost += event.costUsd; hasCost = true; }
                      if (runBudget?.maxTokens && totalTokens > runBudget.maxTokens) budgetExhausted = true;
                      if (runBudget?.maxCostUsd && hasCost && totalCost > runBudget.maxCostUsd) budgetExhausted = true;
                      // Track last reported input tokens for usage-aware trigger
                      lastReportedInputTokens = event.input;
                      emit(request.threadId, { type: "usage", runId, input: event.input, output: event.output, ...(event.cachedInput !== undefined ? { cachedInput: event.cachedInput } : {}), ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}) });
                      break;
                    case "completed":
                      if (sawCompletion) throw modelEventFailure("The model emitted more than one completion event in a round");
                      sawCompletion = true;
                      finishReason = event.finishReason;
                      break;
                  }
                }
                if (!sawCompletion || finishReason === null) throw modelEventFailure("Stream ended before completion");
                if (budgetExhausted) {
                  throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
                }
                break;
              } catch (error) {
                if (
                  isModelAdapterError(error)
                  && error.code === "unsupported_tools"
                  && allowTools
                  && !outputVisible
                  && !capabilityDispatched
                  && !signal.aborted
                ) {
                  const offered = runCapabilities.list(request.grant);
                  if (offered.length > 0 && offered.every((tool) => tool.optional === true)) {
                    allowTools = false;
                    toolDescriptors = [];
                    continue;
                  }
                }
                if (
                  isModelAdapterError(error)
                  && error.code === "request_too_large"
                  && sizeRetries === 0
                  && !outputVisible
                  && !signal.aborted
                ) {
                  overflowRejected = true;
                  // Force shrink on the first rejection: aggressively drop older messages
                  // and shorten remaining large content (images, long tool outputs).
                  const result = compactMessages(messages, {
                    keepTokens: 1,
                    maxTokens: budget.window,
                    modelId: currentModelId,
                    allowSummarize: false,
                    allowShrink: true,
                    minKeepMessages: 1,
                    bridgeMessages: 1,
                  });
                  const shortened = shortenMessageContents(result.messages);
                  messages.splice(0, messages.length, ...shortened);
                  sizeRetries++;
                  precomputed = null;
                  continue;
                }
                if (
                  isModelAdapterError(error)
                  && error.code === "request_too_large"
                  && sizeRetries < 2
                  && !outputVisible
                  && !signal.aborted
                ) {
                  overflowRejected = true;
                  const result = compactMessages(messages, {
                    keepTokens: 1,
                    maxTokens: budget.window,
                    modelId: currentModelId,
                    allowSummarize: false,
                    allowShrink: true,
                    minKeepMessages: 1,
                    bridgeMessages: 1,
                  });
                  const shortened = shortenMessageContents(result.messages);
                  messages.splice(0, messages.length, ...shortened);
                  sizeRetries++;
                  continue;
                }
                const canRetry = isModelAdapterError(error)
                  && error.code === "transient"
                  && error.retryable
                  && error.retrySafe
                  && !error.requestStarted
                  && !outputVisible
                  && !capabilityDispatched
                  && !signal.aborted
                  && attempt < RETRY_MAX_ATTEMPTS - 1;
                // Fallback provider chain: on terminal failure, try the next provider.
                if (!canRetry && isModelAdapterError(error) && error.code === "terminal" && adapterIndex < adapterChain.length - 1) {
                  adapterIndex++;
                  adapter = adapterChain[adapterIndex]!;
                  if (request.fallbackProviders?.[adapterIndex - 1]) currentModelId = request.fallbackProviders[adapterIndex - 1].modelId;
                  sizeRetries = 0;
                  continue;
                }
                if (!canRetry) throw error;
                const wait = interruptibleDelay(computeBackoff(attempt), signal);
                const waited = await wait.promise;
                if (waited === "cancelled") signal.throwIfAborted();
                attempt++;
              }
            }

            if (budgetExhausted) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            if (responseCalls.length > 0) {
              if (toolDescriptors.length === 0) throw new AgentRuntimeError("tool_not_available", "The model returned tool calls but no capabilities are available");
              if (toolCalls + responseCalls.length > MAX_TOOL_CALLS) throw new AgentRuntimeError("tool_budget_exceeded", `Stopped after ${MAX_TOOL_CALLS} tool calls`);

              const batch: Array<{ readonly call: CapabilityCall; readonly descriptor: (typeof toolDescriptors)[number] }> = [];
              // Reset capability failure for this new batch of tool calls;
              // it will be re-set to true if any call in this batch fails or is excluded.
              capabilityFailure = false;
              for (const modelCall of responseCalls) {
                if (!modelCall.id.trim() || seenCallIds.has(modelCall.id)) throw new AgentRuntimeError("invalid_tool_call", "The model reused or omitted a tool-call ID");
                seenCallIds.add(modelCall.id);
                const descriptor = toolDescriptors.find((item) => item.name === modelCall.name || item.id === modelCall.name);
                if (!descriptor) {
                  if (modelCall.name === "tool_output_read") throw new AgentRuntimeError("capability_not_granted", `The model requested an unavailable capability: ${modelCall.name}`);
                  const parsed = parseToolScope(request.toolScope);
                  const scope = parsed.ok ? parsed.scope : undefined;
                  // Check both native and mcp identities
                  const nativeExcluded = parsed.ok && !allowsTool(scope, { kind: "native", name: modelCall.name });
                  const mcpExcluded = parsed.ok && !allowsTool(scope, { kind: "mcp", server: "fx", name: modelCall.name });
                  const excluded = nativeExcluded || mcpExcluded;
                  const msg = excluded ? "tool selection excludes this tool" : `Unknown capability: ${modelCall.name}`;
                  emit(request.threadId, { type: "tool.result", runId, callId: modelCall.id, result: { callId: modelCall.id, ok: false, content: msg, error: "not_found" } });
                  messages.push({ role: "tool", content: JSON.stringify({ ok: false, result: msg }), toolCallId: modelCall.id });
                  capabilityFailure = true;
                  continue;
                }
                batch.push({
                  descriptor,
                  call: { runId, callId: modelCall.id, capabilityId: descriptor.id, arguments: modelCall.arguments, botId: request.botId, threadId: request.threadId },
                });
              }
              for (const item of batch) {
                runCapabilities.validate(item.call, request.grant);
              }

              messages.push({ role: "assistant", content: responseText || null, toolCalls: responseCalls });
              emit(request.threadId, { type: "tool.calls", runId, calls: responseCalls });
              const batchImages: ModelContentPart[] = [];

              const checkpointHashes = new Map<string, string>();
              // Classify: read-only tools (risk "read", no side effects) may run concurrently
              // (Claude Code pattern). Mutating tools run sequentially for safety.
              const allReadOnly = batch.every(({ descriptor }) => descriptor.risk === "read" && descriptor.sideEffect === false);

              // Invoke phase: concurrent for all-read-only batches, sequential otherwise.
              const invoked: Array<{ call: CapabilityCall; descriptor: CapabilityDescriptor; result: CapabilityResult | null; uncertain: boolean }> = [];
              if (allReadOnly && batch.length > 1) {
                // Pre-tool-use hooks (sequential, before concurrent invoke).
                const preHookResults = request.hooks ? await Promise.all(batch.map(({ call }) =>
                  request.hooks!.run("pre_tool_use", { runId, threadId: request.threadId, botId: request.botId, capabilityId: call.capabilityId, callId: call.callId, arguments: call.arguments })
                )) : batch.map(() => ({ allow: true, messages: [] as string[], modifiedArguments: undefined }));
                const invokedResults = await Promise.all(batch.map(async ({ call, descriptor }, idx) => {
                  signal.throwIfAborted();
                  if (preHookResults[idx].allow === false) {
                    return { call, descriptor, result: { callId: call.callId, ok: false, content: preHookResults[idx].messages.join("; ") || "Blocked by hook.", error: "denied" } as CapabilityResult, uncertain: false };
                  }
                  const dispatchedAt = Date.now();
                  let checkpointHash: string | null = null;
                  if (descriptor.risk !== "read") {
                    try { checkpointHash = await createCheckpoint(request.botId, workspaceDir(request.botId), `before ${call.capabilityId}`, signal, { pin: call.callId }); } catch {}
                  }
                  if (checkpointHash) checkpointHashes.set(call.callId, checkpointHash);
                  toolCalls++;
                  progress();
                  dependencies.store.beginCapabilityCall({
                    runId,
                    callId: call.callId,
                    capabilityId: call.capabilityId,
                    risk: descriptor.risk,
                    status: "dispatching",
                    startedAt: dispatchedAt,
                  });
                  capabilityDispatched = true;
                  const invokeCall = preHookResults[idx].modifiedArguments !== undefined
                    ? { ...call, arguments: preHookResults[idx].modifiedArguments }
                    : call;
                  try {
                    const r = await runCapabilities.invoke(invokeCall, { grant: request.grant, signal });
                    return { call: invokeCall, descriptor, result: r, uncertain: !!r.uncertain };
                  } catch {
                    return { call, descriptor, result: null, uncertain: true };
                  }
                }));
                for (const r of invokedResults) invoked.push(r);
              } else {
                for (const { call, descriptor } of batch) {
                  signal.throwIfAborted();
                  let preHookAllow = true;
                  let preHookMsg = "";
                  let modifiedArgs: unknown;
                  if (request.hooks) {
                    const hr = await request.hooks.run("pre_tool_use", { runId, threadId: request.threadId, botId: request.botId, capabilityId: call.capabilityId, callId: call.callId, arguments: call.arguments });
                    preHookAllow = hr.allow;
                    preHookMsg = hr.messages.join("; ");
                    modifiedArgs = hr.modifiedArguments;
                  }
                  const invokeCall = modifiedArgs !== undefined
                    ? { ...call, arguments: modifiedArgs }
                    : call;
                  if (!preHookAllow) {
                    const denied: CapabilityResult = { callId: call.callId, ok: false, content: preHookMsg || "Blocked by hook.", error: "denied" };
                    dependencies.store.beginCapabilityCall({ runId, callId: call.callId, capabilityId: call.capabilityId, risk: descriptor.risk, status: "dispatching", startedAt: Date.now() });
                    capabilityDispatched = true;
                    dependencies.store.settleCapabilityCall(runId, call.callId, "failed", Date.now());
                    emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result: denied });
                    messages.push({ role: "tool", content: JSON.stringify({ ok: false, result: denied.content }), toolCallId: call.callId });
                    continue;
                  }
                  const dispatchedAt = Date.now();
                  let checkpointHash: string | null = null;
                  if (descriptor.risk !== "read") {
                    try { checkpointHash = await createCheckpoint(request.botId, workspaceDir(request.botId), `before ${call.capabilityId}`, signal, { pin: call.callId }); } catch {}
                  }
                  if (checkpointHash) checkpointHashes.set(call.callId, checkpointHash);
                  toolCalls++;
                  progress();
                  dependencies.store.beginCapabilityCall({
                    runId,
                    callId: call.callId,
                    capabilityId: call.capabilityId,
                    risk: descriptor.risk,
                    status: "dispatching",
                    startedAt: dispatchedAt,
                  });
                  capabilityDispatched = true;
                  try {
                    const r = await runCapabilities.invoke(invokeCall, { grant: request.grant, signal });
                    invoked.push({ call: invokeCall, descriptor, result: r, uncertain: !!r.uncertain });
                  } catch {
                    invoked.push({ call: invokeCall, descriptor, result: null, uncertain: true });
                  }
                }
              }

              // Process phase: sequential, in order (settle, emit, push messages).
              for (const { call, result: rawResult, uncertain: wasUncertain } of invoked) {
                const checkpointHash = checkpointHashes.get(call.callId) ?? null;
                let result: CapabilityResult;
                if (wasUncertain && rawResult === null) {
                  result = {
                    callId: call.callId,
                    ok: false,
                    content: "The operation may have taken effect. Inspect its state before continuing.",
                    uncertain: true,
                    error: "uncertain_side_effect",
                  };
                  try { dependencies.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now()); } catch {}
                  emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  if (checkpointHash) emit(request.threadId, { type: "run.checkpoint_available", runId, callId: call.callId, checkpointHash });
                  updateStatus("recovery_required", "uncertain_side_effect");
                  emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }
                result = rawResult!;

                if (result.uncertain) {
                  dependencies.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now());
                  emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  if (checkpointHash) emit(request.threadId, { type: "run.checkpoint_available", runId, callId: call.callId, checkpointHash });
                  updateStatus("recovery_required", result.error ?? "uncertain_side_effect");
                  emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }

                dependencies.store.settleCapabilityCall(runId, call.callId, result.ok ? "succeeded" : "failed", Date.now());
                if (!result.ok) capabilityFailure = true;
                emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                // Post-tool-use hooks: observe results and enforce blocks. A blocked
                // mutating tool is undone via its pre-call checkpoint, then denied.
                if (request.hooks) {
                  const postHook = await request.hooks.run("post_tool_use", { runId, threadId: request.threadId, botId: request.botId, capabilityId: call.capabilityId, callId: call.callId, arguments: call.arguments, result: { ok: result.ok, content: result.content } });
                  if (postHook.allow === false && checkpointHash) {
                    try { await rollback(request.botId, workspaceDir(request.botId), checkpointHash, signal); } catch {}
                  }
                  if (postHook.allow === false) {
                    result = { ...result, ok: false, content: postHook.messages.join("; ") || "Blocked by post-tool hook.", error: "denied" };
                    capabilityFailure = true;
                    dependencies.store.settleCapabilityCall(runId, call.callId, "failed", Date.now());
                    emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                    continue;
                  }
                }
                if (result.images?.length && modelCapabilities.imageInput !== "supported") {
                  throw new AgentRuntimeError("unsupported_capability", "The capability returned an image result the selected model cannot receive");
                }
                let promptResult = result.content;
                let outputRef: Record<string, unknown> | undefined;
                if (result.content.length > TOOL_OUTPUT_PROMPT_CHARS && runCapabilities.recordToolOutput(call.callId, result.content)) {
                  promptResult = `${result.content.slice(0, TOOL_OUTPUT_PROMPT_CHARS)}\n\n[Output truncated: ${TOOL_OUTPUT_PROMPT_CHARS} of ${result.content.length} chars shown. Full output is stored as call ${call.callId}. Use ${TOOL_OUTPUT_READ_CAPABILITY} with callId "${call.callId}" and offset/limit to read more.]`;
                  outputRef = { callId: call.callId, totalChars: result.content.length, shownChars: TOOL_OUTPUT_PROMPT_CHARS, truncated: true };
                }
                messages.push({
                  role: "tool",
                  content: JSON.stringify({ ok: result.ok, result: promptResult, ...(outputRef ? { outputRef } : {}) }),
                  toolCallId: call.callId,
                });
                if (result.images?.length) {
                  encodedImages += result.images.reduce((total, image) => total + image.data.length, 0);
                  if (encodedImages > MAX_ENCODED_IMAGE_BYTES) {
                    throw new AgentRuntimeError("image_budget_exceeded", "Tool images exceeded the 32 MiB encoded budget for this run.");
                  }
                  batchImages.push(
                    { type: "text", text: `Screenshot result from tool call ${call.callId}:` },
                    ...result.images.map((image): ModelContentPart => ({ type: "image", mimeType: image.mimeType, data: image.data })),
                  );
                }
              }
              // Intelligence verify: verify tool results against success criteria.
              if (dependencies.intelligence?.verify) {
                const toolOutput = batch.map(({ call }) => call.capabilityId).join(", ");
                try {
                  const verification = await dependencies.intelligence.verify(toolOutput);
                  if (!verification.ok) {
                    verificationFailure = true;
                    verificationFeedback = verification.feedback || verificationFeedback;
                    dependencies.intelligence.log?.({ kind: "intelligence.verify", detail: JSON.stringify({ ok: verification.ok, feedback: verification.feedback }) });
                    if (verification.feedback) {
                      messages.push({ role: "user", content: `[Intelligence verify: ${verification.feedback}]` });
                    }
                  }
                } catch {
                  // Verification failure is non-fatal.
                }
              }
              if (batchImages.length) messages.push({ role: "user", content: batchImages });
              continue;
            }

            if (!responseText.trim()) throw modelEventFailure("The model returned an empty final answer");
            if (normalizeFinishReason(finishReason) !== "stop") throw modelEventFailure(`The model did not finish the response (${finishReason})`);
            if (control.steers.length) {
              messages.push({ role: "assistant", content: responseText });
              continue;
            }
            control.finishing = true;
            const needsCorrection = capabilityFailure || verificationFailure;
            if (needsCorrection) {
              const maxCorrective = request.toolErrorCorrectiveRounds ?? 0;
              if (correctiveRounds < maxCorrective) {
                correctiveRounds += 1;
                const feedback = verificationFailure && verificationFeedback
                  ? `[MausClaw: verification failed (${verificationFeedback}). Re-run the failed operations with corrected inputs where possible, check the results, then give your final answer. Do not report results you did not get.]`
                  : "[MausClaw: a tool call in this turn failed (its result is marked ok:false). Re-run the failed operations with corrected inputs where possible, check the results, then give your final answer. Do not report results you did not get.]";
                messages.push({ role: "assistant", content: responseText || "" }, { role: "user", content: feedback });
                precomputed = null;
                continue;
              }
            }
            if (capabilityFailure) throw new AgentRuntimeError("capability_failed", "One or more capabilities failed or were denied; the run is not a success receipt");
            if (request.nudgeAnnouncedAction && toolDescriptors.length > 0 && announcesAction(responseText)) {
              if (nudges >= MAX_ANNOUNCEMENT_NUDGES) {
                throw new AgentRuntimeError("incomplete_action", `Stopped after ${MAX_ANNOUNCEMENT_NUDGES} announcement nudges without a verified final answer. Earlier operations may have taken effect; inspect their state and continue only the remaining work.`);
              }
              if (callsAtNudge === seenCallIds.size) {
                throw new AgentRuntimeError("incomplete_action", "The model announced another action without tool progress after a nudge. The task is incomplete; earlier operations may have taken effect. Inspect their state before continuing.");
              }
              nudges += 1;
              callsAtNudge = seenCallIds.size;
              messages.push({ role: "assistant", content: responseText }, { role: "user", content: NUDGE_ANNOUNCED_ACTION });
              continue;
            }
            stopReason = normalizeFinishReason(finishReason);
            completed = true;
            break;
          }

          if (!completed && runStatus.value === "running") throw new AgentRuntimeError("round_budget_exceeded", `Stopped after ${MAX_MODEL_ROUNDS} model rounds`);
        } catch (error) {
          failure = error;
        }
        control.finishing = true;

        try {
          await closeSession();
        } catch (error) {
          if (!failure && runStatus.value !== "recovery_required") failure = error;
        }

        if (runStatus.value === "recovery_required") return;
        if (signal.aborted) {
          updateStatus("interrupted", "interrupted");
          emit(request.threadId, { type: "run.interrupted", runId });
        } else if (failure) {
          updateStatus("failed", errorCode(failure));
          emit(request.threadId, { type: "run.failed", runId, message: safeMessage(failure), code: isModelAdapterError(failure) ? failure.code : errorCode(failure) });
        } else if (completed) {
          updateStatus("completed");
          emit(request.threadId, { type: "turn.completed", runId, ok: true, stopReason });
        } else {
          updateStatus("failed", "terminal");
          emit(request.threadId, { type: "run.failed", runId, message: "The run ended without a final answer", code: "terminal" });
        }
      }).finally(() => {
        active.delete(runId);
        if (activeByThread.get(request.threadId) === runId) activeByThread.delete(request.threadId);
      });

      active.set(runId, control);
      return { runId, done };
    },

    async interrupt(runId) {
      active.get(runId)?.controller.abort(new DOMException("Native agent run interrupted", "AbortError"));
    },

    async steer(runId, text) {
      const control = active.get(runId);
      if (!control || control.finishing) return "refused";
      const trimmed = text.trim();
      if (!trimmed) return "refused";
      control.steers.push(trimmed);
      return "steered";
    },

    getState(runId) {
      return dependencies.store.getRun(runId);
    },

    onEvent(threadId, listener) {
      if (!listeners.has(threadId)) listeners.set(threadId, new Set());
      listeners.get(threadId)!.add(listener);
      return () => {
        const threadListeners = listeners.get(threadId);
        threadListeners?.delete(listener);
        if (threadListeners?.size === 0) listeners.delete(threadId);
      };
    },
  };
}
