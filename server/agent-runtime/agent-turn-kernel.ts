// Single model/tool turn loop extracted from `runtime.ts`'s `AgentEngine.run()`.
// One kernel owns every supported product turn: model calls, tool dispatch,
// retries, compaction, budgets, terminal status, and event emission.
//
// The public `AgentEngine` contract (engineId, run/interrupt/steer/getState/onEvent)
// is implemented here; `runtime.ts` delegates to this class.

import { randomUUID } from "node:crypto";

import { computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "../drivers/retry.ts";
import { workspaceDir } from "../workspace.ts";
import { parseToolScope, allowsTool } from "../../shared/tool-scope.ts";
import { snapshot as createCheckpoint, rollback } from "../checkpoints.ts";
import { TOOL_OUTPUT_READ_CAPABILITY } from "./capability-runtime.ts";
import type { CapabilityProvider } from "./contracts.ts";
import { CapabilityCatalog, ToolSurface, executeWithScheduling, type SchedulingState } from "./capability-catalog.ts";
import {
  compactionKeepTokens,
  contextBudget,
  chooseBodyCut,
  compactionTranscript,
  compactMessages,
  planRecovery,
  SUMMARY_PROMPT,
  buildCompactionRecord,
  estimateMessagesTokens,
} from "./compaction.ts";
import { observeCalibration, applyCalibration } from "./calibration.ts";
import { createHookGateway } from "./hook-gateway.ts";
import type {
  AgentEngine,
  AgentEvent,
  AgentRunHandle,
  AgentRunRecord,
  AgentRunRequest,
  AgentRunStatus,
  AgentRunStore,
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityResult,
  CapabilitySession,
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
  return String(error).slice(0, 2_000);
}

function modelEventFailure(message: string): AgentRuntimeError {
  return new AgentRuntimeError("model_event_failure", message);
}

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

function mergeLiveCapabilities(staticCaps: ModelCapabilities, live: LiveProbeResult | undefined): ModelCapabilities {
  if (!live) return staticCaps;
  return {
    ...staticCaps,
    tools: live.tools ? "supported" : "unsupported",
    streaming: live.streaming ? "supported" : "unsupported",
  };
}

/** Run-scoped capability session: CapabilitySession plus tool-output offload. */
type RunCapabilitySession = CapabilitySession & {
  recordToolOutput(callId: string, content: string): boolean;
  /** Providers aggregated by the wrapped composite, if any (for catalog building). */
  providers?(): ReadonlyArray<CapabilityProvider>;
};
export interface KernelDependencies {
  readonly adapters: { resolve(ref: AgentRunRecord["providerModel"]): ModelAdapter };
  readonly store: AgentRunStore;
  /** Run-scoped capability session factory. */
  readonly createCapabilities: (request: { readonly runId: string; readonly capabilities: CapabilitySession; readonly store: AgentRunStore }) => RunCapabilitySession;
  /** Optional live capability probe. */
  readonly probe?: { run(adapter: ModelAdapter, modelId: string): Promise<LiveProbeResult | null> };
  /** Optional Intelligence Layer. */
  readonly intelligence?: {
    readonly enabled: boolean;
    readonly decide: (input: {
      readonly text: string;
      readonly messageCount?: number;
      readonly toolCount?: number;
      readonly hasImages?: boolean;
      readonly hasCode?: boolean;
      readonly messages: ReadonlyArray<{ readonly content: string | null | undefined }>;
      readonly primaryModel: AgentRunRecord["providerModel"];
    }) => {
      readonly allowed: boolean;
      readonly reason?: string;
      readonly route: { readonly candidates: ReadonlyArray<AgentRunRecord["providerModel"]> };
    };
    readonly log?: (entry: { readonly kind: string; readonly detail: string }) => void;
    readonly verify?: (output: string) => { ok: boolean; feedback: string } | Promise<{ ok: boolean; feedback: string }>;
  };
  /** Enable response caching for identical model requests. */
  readonly cacheEnabled?: boolean;
  /** Optional plugin registry. */
  readonly plugins?: {
    readonly list: () => ReadonlyArray<{ readonly manifest: { readonly name: string }; readonly capabilities: ReadonlyArray<string> }>;
  };
  /** Optional bounded in-loop plan+verify. Off by default. */
  readonly planVerify?: {
    readonly enabled: boolean;
    readonly maxPlanSteps: number;
    readonly maxVerifyRounds: number;
  };
}

/** Tracks a live run for interrupt/steer. */
interface RunControl {
  readonly threadId: string;
  readonly controller: AbortController;
  readonly steers: string[];
  finishing: boolean;
}

export class AgentTurnKernel implements AgentEngine {
  readonly engineId = "mausclaw-native";
  readonly orchestrator: AgentEngine["orchestrator"] | undefined;
  readonly planVerify: AgentEngine["planVerify"] | undefined;

  private readonly deps: KernelDependencies;
  private readonly active = new Map<string, RunControl>();
  private readonly activeByThread = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  /** Live probe results cached per modelId for the engine's lifetime. */
  private readonly liveProbeCache = new Map<string, LiveProbeResult>();
  private readonly plugins: KernelDependencies["plugins"] | undefined;

  constructor(deps: KernelDependencies) {
    this.deps = deps;
    this.plugins = deps.plugins;
    this.orchestrator = undefined;
    this.planVerify = deps.planVerify;
  }

  async run(request: AgentRunRequest): Promise<AgentRunHandle> {
    if (this.activeByThread.has(request.threadId)) {
      throw new AgentRuntimeError("thread_busy", "A native run is already active for this thread");
    }

    const runId = randomUUID();
    const runCapabilities = this.deps.createCapabilities({ runId, capabilities: request.capabilities, store: this.deps.store });

    // Phase 2 deferred discovery: build catalog and tool surface.
    const providers = typeof runCapabilities.providers === "function"
      ? [...runCapabilities.providers()]
      : [];
    const catalog = new CapabilityCatalog(providers, request.grant);
    const surface = new ToolSurface(catalog);
    // If no providers are exposed (e.g. test mocks), fall back to listing
    // directly from the capability session for the surface.
    if (providers.length === 0) {
      for (const descriptor of runCapabilities.list(request.grant)) {
        surface.addDescriptor(descriptor);
      }
    }
    const schedulingState: SchedulingState = {
      catalog,
      surface,
      readCache: new Map(),
      effectTracker: new Set(),
      concurrencyGates: new Map(),
    };

    // Plugin System: mount plugin capabilities into the capability session.
    if (this.plugins) {
      const loaded = this.plugins.list();
      if (loaded.length > 0) {
        this.emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: loaded.map((p) => p.manifest.name) });
        const pluginCaps = loaded.flatMap((p) => p.capabilities);
        if (pluginCaps.length > 0) {
          const session = runCapabilities as { register?: (d: any, h: any) => void };
          if (typeof session.register === "function" && "getCapabilityHandlers" in this.plugins) {
            const handlers = (this.plugins as any).getCapabilityHandlers?.();
            if (handlers) {
              for (const [name, { handler, pluginName }] of handlers) {
                const descriptor = { id: name, name, description: `Plugin capability from ${pluginName}`, schema: { type: "object", properties: {}, additionalProperties: true }, risk: "read" as const, sideEffect: false, timeoutMs: 30_000 };
                try { session.register(descriptor, handler); } catch { /* session may not support registration */ }
              }
            }
          }
          this.emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: pluginCaps });
        }
      }
    }

    const startedAt = Date.now();
    this.deps.store.createRun({
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
    const control: RunControl = { threadId: request.threadId, controller, steers: [] as string[], finishing: false };
    this.active.set(runId, control);
    this.activeByThread.set(request.threadId, runId);

    const done = Promise.resolve().then(async () => {
      const runStatus: { value: AgentRunStatus } = { value: "queued" };
      let modelRounds = 0;
      let toolCalls = 0;
      let outputVisible = false;
      let capabilityDispatched = false;
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
      const providerInstanceId = request.providerInstanceId ?? request.providerModel.modelId;

      const progress = () => this.deps.store.updateRunProgress(runId, { modelRounds, toolCalls, updatedAt: Date.now() });
      const updateStatus = (next: AgentRunStatus, code?: string): void => {
        if (!this.deps.store.transitionRun(runId, runStatus.value, next, Date.now(), code)) {
          throw new AgentRuntimeError("run_state_conflict", `Could not transition run from ${runStatus.value} to ${next}`);
        }
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
        this.emit(request.threadId, { type: "run.started", runId, engineId: "mausclaw-native", providerModel: request.providerModel });

        const adapterChain = [this.deps.adapters.resolve(request.providerModel), ...(request.fallbackProviders ?? []).map((ref) => this.deps.adapters.resolve(ref))];
        let adapterIndex = 0;
        let adapter = adapterChain[0]!;
        if (this.deps.cacheEnabled) {
          const { createCachingAdapter } = await import("./caching-adapter.ts");
          adapter = createCachingAdapter(adapter);
        }
        let currentModelId = request.providerModel.modelId;
        // Plugin System: log loaded plugin capabilities for observability.
        if (this.plugins) {
          const loaded = this.plugins.list();
          if (loaded.length > 0) {
            this.emit(request.threadId, { type: "run.plugins_loaded", runId, plugins: loaded.map((p) => p.manifest.name) });
          }
        }

        // Live probe: verify tools/streaming against the real adapter before trusting static hints.
        let liveCaps: LiveProbeResult | undefined;
        if (this.deps.probe && !this.liveProbeCache.has(currentModelId)) {
          const probed = await Promise.race([
            this.deps.probe.run(adapter, currentModelId),
            new Promise<LiveProbeResult | null>((resolve) => {
              setTimeout(() => resolve(null), 5_000);
            }),
          ]);
          if (probed) {
            this.liveProbeCache.set(currentModelId, probed);
            liveCaps = probed;
          }
        } else if (this.deps.probe) {
          liveCaps = this.liveProbeCache.get(currentModelId);
        }
        // Intelligence Layer: classify task, route model, estimate cost.
        if (this.deps.intelligence?.enabled) {
          const intelligenceDecision = this.deps.intelligence.decide({
            text: request.text,
            messageCount: messages.length,
            toolCount: request.capabilities ? 0 : 0,
            hasImages: initialImages.length > 0,
            hasCode: /```|function\\s+\\w|class\\s+\\w/.test(request.text),
            messages: messages.map((m) => ({ content: typeof m.content === "string" ? m.content : null })),
            primaryModel: request.providerModel,
          });
          this.deps.intelligence.log?.({ kind: "intelligence.decide", detail: JSON.stringify({ allowed: intelligenceDecision.allowed, reason: intelligenceDecision.reason }) });
          if (!intelligenceDecision.allowed) {
            updateStatus("failed", "budget_exceeded");
            this.emit(request.threadId, { type: "run.failed", runId, message: intelligenceDecision.reason ?? "Budget exceeded", code: "budget_exceeded" });
            await closeSession();
            return;
          }
          if (intelligenceDecision.route.candidates.length > 0) {
            const routedRef = intelligenceDecision.route.candidates[0]!;
            if (routedRef.modelId !== currentModelId || routedRef.providerId !== request.providerModel.providerId) {
              try {
                adapter = this.deps.adapters.resolve(routedRef);
                currentModelId = routedRef.modelId;
              } catch {
                // Keep original adapter if routing fails.
              }
            }
          }
        }
        const modelCapabilities = mergeLiveCapabilities(adapter.capabilities(currentModelId), liveCaps);
        const budget = contextBudget(modelCapabilities.contextWindow);
        // Output reserve: keep tokens free for the model's generation so the prompt
        // never consumes the entire context window. Reserve up to 25% of the window,
        // never below 4k tokens.
        const outputReserve = Math.min(Math.floor(budget.window * 0.25), Math.max(4_000, Math.floor(budget.window * 0.1)));
        const effectiveTrigger = Math.max(1, budget.trigger - outputReserve);
        let budgetExhausted = false;
        let totalTokens = 0;
        let totalCost = 0;
        let compactions = 0;
        const runBudget = request.budget;

        while (true) {
          signal.throwIfAborted();
          const currentControl = this.active.get(runId);
          if (!currentControl || currentControl.finishing) break;

          // Build tool descriptors for this round.
          let toolDescriptors: ReadonlyArray<CapabilityDescriptor> = [];
          let allowTools = true;
          if (request.capabilities) {
            toolDescriptors = surface.getDescriptors();
            allowTools = toolDescriptors.length > 0;
          }

          // Estimate request size and compact if needed.
          const keepTokens = compactionKeepTokens(modelCapabilities.contextWindow);
          // Calibrated token estimate: provider-reported tokens refine the estimate per provider instance/model.
          const estimateRequestTokens = (): number => applyCalibration(providerInstanceId, currentModelId, estimateMessagesTokens(messages, currentModelId));

          const firePrecompute = (): void => {
            if (compactions >= COMPACTION_MAX_PER_RUN || messages.length < COMPACTION_MIN_MESSAGES) return;
            const body = messages.filter((m) => m.role !== "system");
            const cut = chooseBodyCut(body, keepTokens, currentModelId);
            if (cut <= 0 || cut >= body.length - 1) return;
            const older = body.slice(0, cut);
            if (older.length < 2) return;
            const transcript = compactionTranscript(older);
            if (!transcript.trim()) return;
            void (async () => {
              // Precompute summary in background; applied on next overflow.
            })();
          };

          /** Multi-tier compaction with deterministic summary fallback.
           *  Tries model-based summary first; on failure, falls back to deterministic
           *  truncation of dropped messages so the turn can continue. */
          const doCompact = async (trigger: "auto" | "overflow"): Promise<boolean> => {
            if (compactions >= COMPACTION_MAX_PER_RUN || messages.length < COMPACTION_MIN_MESSAGES) return false;
            const result = compactMessages(messages, {
              keepTokens,
              maxTokens: budget.window,
              modelId: currentModelId,
              allowSummarize: true,
              allowShrink: true,
              minKeepMessages: 2,
              bridgeMessages: 2,
            });
            if (result.droppedCount === 0) return false;

            let summary = "";
            // Try model-based summary
            try {
              for await (const event of adapter.generate({
                messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: compactionTranscript(result.droppedMessages) }],
                model: currentModelId,
                tools: [],
                signal,
              })) {
                if (event.type === "content.delta" && event.kind === "assistant_text") summary += event.delta;
              }
              summary = summary.trim();
            } catch {
              // Deterministic fallback: truncate dropped messages to a fixed size
              // and use them as the summary.
            }
            if (!summary) {
              // Deterministic summary fallback: concatenate dropped messages with a header,
              // truncated to SUMMARY_MAX_CHARS.
              const MAX_SUMMARY_CHARS = 4_000;
              summary = result.droppedMessages
                .map((m) => `${m.role.toUpperCase()}: ${m.content ?? ""}`)
                .join("\n\n")
                .slice(0, MAX_SUMMARY_CHARS);
              if (!summary.trim()) return false;
            }
            if (summary.length > 4_000) summary = summary.slice(0, 4_000) + "…";

            const summaryMessage: ModelMessage = {
              role: "user",
              content: `[Earlier conversation summary — ${result.droppedMessages.length} message${result.droppedMessages.length === 1 ? "" : "s"} compacted to fit the context window.]\n\n${summary}`,
            };
            const system = messages.filter((m: ModelMessage) => m.role === "system");
            const newMessages: ModelMessage[] = [...system, summaryMessage, ...result.messages.filter((m: ModelMessage) => m.role !== "system")];
            messages.splice(0, messages.length, ...newMessages);
            compactions++;
            const tokenEstimate = estimateMessagesTokens(messages, currentModelId);
            this.deps.store.recordCompaction?.(buildCompactionRecord(runId, compactions, summary, system.length + 1, tokenEstimate, trigger, Date.now()));
            this.emit(request.threadId, { type: "run.compacted", runId, summary, firstKeptIndex: system.length + 1, tokenEstimate, trigger });
            return true;
          };

          void firePrecompute();

          let attempt = 0;
          let sawCompletion = false;
          let finishReason: string | null = null;
          let budgetExhaustedRound = false;
          let turnRequestCount = 0;

          for (;;) {
            signal.throwIfAborted();

            // Context-precision check before every model request: if the calibrated
            // estimate exceeds the effective trigger (window minus output reserve),
            // run recovery (compact → shrink → escalate → fail) before sending.
            const tokenEst = estimateRequestTokens();
            if (tokenEst > effectiveTrigger) {
              const recovery = planRecovery(tokenEst, effectiveTrigger, budget.window, {
                compactions,
                maxCompactions: COMPACTION_MAX_PER_RUN,
                sizeRetries: 0,
                maxSizeRetries: 1,
                allowSummarize: true,
                allowShrink: true,
              });
              if (recovery.action === "compact" || recovery.action === "shrink") {
                const didCompact = await doCompact("auto");
                if (!didCompact && recovery.action === "compact") {
                  // Compaction could not reduce size; try shrink once.
                  const shrank = await doCompact("overflow");
                  if (!shrank) {
                    stopReason = "context_overflow";
                    throw new AgentRuntimeError("context_overflow", "Request exceeds the provider's context window and compaction could not fit it.");
                  }
                }
              } else if (recovery.action === "escalate") {
                stopReason = "context_overflow";
                throw new AgentRuntimeError("context_overflow", "Request exceeds the provider's context window; no recovery strategy fits.");
              } else if (recovery.action === "fail") {
                stopReason = "context_overflow";
                throw new AgentRuntimeError("context_overflow", "All context recovery strategies exhausted.");
              }
            }

            let responseCalls: ReadonlyArray<ModelToolCall> = [];
            let responseText = "";

            try {
              turnRequestCount++;
              modelRounds++;
              progress();
              // Emit model delta events via adapter stream.
              const stream = adapter.generate({
                model: currentModelId,
                messages,
                // On the last allowed request, disable tools so the model must produce
                // a final answer instead of another tool call.
                tools: request.maxTurnRequests !== undefined && turnRequestCount >= request.maxTurnRequests ? [] : (allowTools ? toolDescriptors : []),
                signal,
              });

              for await (const event of stream) {
                signal.throwIfAborted();
                if (event.type === "content.delta") {
                  if (event.kind === "assistant_text") {
                    responseText += event.delta;
                    this.emit(request.threadId, { type: "model.delta", runId, kind: "assistant_text", delta: event.delta });
                  }
                  outputVisible = true;
                } else if (event.type === "tool_calls") {
                  responseCalls = event.calls;
                } else if (event.type === "usage") {
                  totalTokens += event.input + (event.output ?? 0);
                  totalCost += event.costUsd ?? 0;
                  // Observe provider-reported vs estimated tokens to refine calibration
                  // for this provider instance + model pair.
                  observeCalibration(providerInstanceId, currentModelId, estimateMessagesTokens(messages, currentModelId), event.input);
                  if (runBudget?.maxTokens && totalTokens > runBudget.maxTokens) budgetExhausted = true;
                  if (runBudget?.maxCostUsd && totalCost > runBudget.maxCostUsd) budgetExhausted = true;
                } else if (event.type === "completed") {
                  sawCompletion = true;
                  finishReason = event.finishReason;
                }
              }
            } catch (error) {
              if (
                isModelAdapterError(error)
                && error.code === "unsupported_tools"
                && allowTools
                && !outputVisible
                && !capabilityDispatched
                && !signal.aborted
              ) {
                const offered = surface.getDescriptors();
                if (offered.length > 0 && offered.every((tool) => tool.optional === true)) {
                  allowTools = false;
                  toolDescriptors = [];
                  continue;
                }
              }
              // One-pass fit on request_too_large: compact+shrink once, then escalate/fail.
              // No repeated resizing of the same request.
              if (
                isModelAdapterError(error)
                && error.code === "request_too_large"
                && !outputVisible
                && !signal.aborted
              ) {
                stopReason = "context_overflow";
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
                // One pass only: if still too large, escalate below.
                const stillTooLarge = estimateRequestTokens() > effectiveTrigger;
                if (stillTooLarge) {
                  // Try fallback provider with a larger window, or fail.
                  if (adapterIndex < adapterChain.length - 1) {
                    adapterIndex++;
                    adapter = adapterChain[adapterIndex]!;
                    if (request.fallbackProviders?.[adapterIndex - 1]) currentModelId = request.fallbackProviders[adapterIndex - 1].modelId;
                    continue;
                  }
                  throw new AgentRuntimeError("context_overflow", "Request exceeds the provider's context window after compaction and shrink.");
                }
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
                continue;
              }
              if (!canRetry) throw error;
              const wait = interruptibleDelay(computeBackoff(attempt), signal);
              const waited = await wait.promise;
              if (waited === "cancelled") signal.throwIfAborted();
              attempt++;
            }

            if (budgetExhausted) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            if (responseCalls.length > 0) {
              if (toolDescriptors.length === 0) throw new AgentRuntimeError("tool_not_available", "The model returned tool calls but no capabilities are available");
              if (toolCalls + responseCalls.length > MAX_TOOL_CALLS) throw new AgentRuntimeError("tool_budget_exceeded", `Stopped after ${MAX_TOOL_CALLS} tool calls`);

              const batch: Array<{ readonly call: CapabilityCall; readonly descriptor: (typeof toolDescriptors)[number] }> = [];
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
                  this.emit(request.threadId, { type: "tool.result", runId, callId: modelCall.id, result: { callId: modelCall.id, ok: false, content: msg, error: "not_found" } });
                  messages.push({ role: "tool", content: JSON.stringify({ ok: false, result: msg }), toolCallId: modelCall.id });
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
              this.emit(request.threadId, { type: "tool.calls", runId, calls: responseCalls });

              const checkpointHashes = new Map<string, string>();

              // Phase 2: Handle tool_search calls by searching the catalog instead of invoking.
              const searchCalls = batch.filter(({ call }) => call.capabilityId === "native:tool-search");
              const capabilityCalls = batch.filter(({ call }) => call.capabilityId !== "native:tool-search");

              // Execute tool_search calls (search catalog, return results).
              for (const { call, descriptor } of searchCalls) {
                const args = call.arguments as Record<string, unknown> | null;
                const query = args && typeof args.query === "string" ? args.query : "";
                const limit = args && typeof args.limit === "number" ? args.limit : 20;
                try {
                  const results = await catalog.search(query, limit);
                  const content = results.length === 0
                    ? "No matching tools found."
                    : results.map((d) => `- ${d.name}: ${d.description}`).join("\n");
                  const result: CapabilityResult = { callId: call.callId, ok: true, content };
                  toolCalls++;
                  progress();
                  this.deps.store.beginCapabilityCall({
                    runId, callId: call.callId, capabilityId: call.capabilityId,
                    risk: descriptor.risk, status: "dispatching", startedAt: Date.now(),
                  });
                  this.deps.store.settleCapabilityCall(runId, call.callId, "succeeded", Date.now());
                  this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  messages.push({
                    role: "tool",
                    content: JSON.stringify({ ok: true, result: content }),
                    toolCallId: call.callId,
                  });
                } catch (error) {
                  const result: CapabilityResult = {
                    callId: call.callId,
                    ok: false,
                    content: error instanceof Error ? error.message : String(error),
                    error: "failed",
                  };
                  this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  messages.push({
                    role: "tool",
                    content: JSON.stringify({ ok: false, result: result.content }),
                    toolCallId: call.callId,
                  });
                }
              }

              // Phase 2 safe scheduling for capability calls.
              const invokeFn = async (call: CapabilityCall, _ctx: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult> => {
                const dispatchedAt = Date.now();
                const item = batch.find((b) => b.call.callId === call.callId)!;
                const descriptor = item.descriptor;

                // Pre-tool-use hooks via gateway with final-argument revalidation.
                let preHookAllow = true;
                let preHookMsg = "";
                let modifiedArgs: unknown;
                if (request.hooks) {
                  const gateway = createHookGateway(request.hooks, (capabilityId) => surface.getDescriptors().find((d) => d.id === capabilityId || d.name === capabilityId));
                  const hr = await gateway.run("pre_tool_use", { runId, threadId: request.threadId, botId: request.botId, capabilityId: call.capabilityId, callId: call.callId, arguments: call.arguments });
                  preHookAllow = hr.allow;
                  preHookMsg = hr.messages.join("; ");
                  modifiedArgs = hr.modifiedArguments;
                }
                if (!preHookAllow) {
                  return { callId: call.callId, ok: false, content: preHookMsg || "Blocked by hook.", error: "denied" };
                }
                const invokeCall = modifiedArgs !== undefined ? { ...call, arguments: modifiedArgs } : call;
                let checkpointHash: string | null = null;
                if (descriptor.risk !== "read") {
                  try { checkpointHash = await createCheckpoint(request.botId, workspaceDir(request.botId), `before ${call.capabilityId}`, signal, { pin: call.callId }); } catch {}
                }
                if (checkpointHash) checkpointHashes.set(call.callId, checkpointHash);
                toolCalls++;
                progress();
                this.deps.store.beginCapabilityCall({
                  runId, callId: call.callId, capabilityId: call.capabilityId,
                  risk: descriptor.risk, status: "dispatching", startedAt: dispatchedAt,
                });
                capabilityDispatched = true;
                try {
                  const r = await runCapabilities.invoke(invokeCall, { grant: request.grant, signal });
                  return r;
                } catch {
                  return { callId: call.callId, ok: false, content: "interrupted", error: "interrupted" };
                }
              };

              const schedulingResults = await executeWithScheduling(
                schedulingState,
                capabilityCalls,
                invokeFn,
                { grant: request.grant, signal }
              );

              // Convert scheduling results to invoked format for process phase.
              const invoked: Array<{ call: CapabilityCall; descriptor: CapabilityDescriptor; result: CapabilityResult; uncertain: boolean }> = schedulingResults.map((slot) => {
                const item = batch.find((b) => b.call.callId === slot.callId)!;
                return { call: item.call, descriptor: slot.descriptor, result: slot.result, uncertain: !!slot.result.uncertain };
              });

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
                  try { this.deps.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now()); } catch {}
                  this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  if (checkpointHash) this.emit(request.threadId, { type: "run.checkpoint_available", runId, callId: call.callId, checkpointHash });
                  updateStatus("recovery_required", "uncertain_side_effect");
                  this.emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }
                result = rawResult!;

                if (result.uncertain) {
                  this.deps.store.settleCapabilityCall(runId, call.callId, "recovery_required", Date.now());
                  this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                  if (checkpointHash) this.emit(request.threadId, { type: "run.checkpoint_available", runId, callId: call.callId, checkpointHash });
                  updateStatus("recovery_required", result.error ?? "uncertain_side_effect");
                  this.emit(request.threadId, { type: "run.recovery_required", runId, callId: call.callId });
                  return;
                }

                this.deps.store.settleCapabilityCall(runId, call.callId, result.ok ? "succeeded" : "failed", Date.now());
                this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
                // Post-tool-use hooks via gateway with final-argument revalidation.
                if (request.hooks) {
                  const gateway = createHookGateway(request.hooks, (capabilityId) => surface.getDescriptors().find((d) => d.id === capabilityId || d.name === capabilityId));
                  const postHook = await gateway.run("post_tool_use", { runId, threadId: request.threadId, botId: request.botId, capabilityId: call.capabilityId, callId: call.callId, arguments: call.arguments, result: { ok: result.ok, content: result.content } });
                  if (postHook.allow === false && checkpointHash) {
                    try { await rollback(request.botId, workspaceDir(request.botId), checkpointHash, signal); } catch {}
                  }
                  if (postHook.allow === false) {
                    result = { ...result, ok: false, content: postHook.messages.join("; ") || "Blocked by post-tool hook.", error: "denied" };
                    this.deps.store.settleCapabilityCall(runId, call.callId, "failed", Date.now());
                    this.emit(request.threadId, { type: "tool.result", runId, callId: call.callId, result });
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
                }
              }
              continue;
            }

            if (!sawCompletion || finishReason === null) throw modelEventFailure("Stream ended before completion");
            if (budgetExhaustedRound) {
              throw new AgentRuntimeError("budget_exhausted", "Turn stopped at the configured token, cost, or time budget.");
            }
            currentControl.finishing = true;
            completed = true;
            stopReason = finishReason;
            break;
          }

          if (!completed && runStatus.value === "running") throw new AgentRuntimeError("round_budget_exceeded", `Stopped after ${MAX_MODEL_ROUNDS} model rounds`);
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
          this.emit(request.threadId, { type: "run.interrupted", runId });
        } else if (failure) {
          updateStatus("failed", errorCode(failure));
          this.emit(request.threadId, { type: "run.failed", runId, message: safeMessage(failure), code: isModelAdapterError(failure) ? failure.code : errorCode(failure) });
        } else if (completed) {
          updateStatus("completed");
          this.emit(request.threadId, { type: "turn.completed", runId, ok: true, stopReason });
        } else {
          updateStatus("failed", "terminal");
          this.emit(request.threadId, { type: "run.failed", runId, message: "The run ended without a final answer", code: "terminal" });
        }
      }).finally(() => {
        this.active.delete(runId);
        if (this.activeByThread.get(request.threadId) === runId) this.activeByThread.delete(request.threadId);
      });

      this.active.set(runId, control);
      return { runId, done };
    }

    async interrupt(runId: string): Promise<void> {
      this.active.get(runId)?.controller.abort(new DOMException("Native agent run interrupted", "AbortError"));
    }

    async steer(runId: string, text: string): Promise<"steered" | "refused"> {
      const control = this.active.get(runId);
      if (!control || control.finishing) return "refused";
      const trimmed = text.trim();
      if (!trimmed) return "refused";
      control.steers.push(trimmed);
      return "steered";
    }

    getState(runId: string): AgentRunRecord | undefined {
      return this.deps.store.getRun(runId);
    }

    onEvent(threadId: string, listener: (event: AgentEvent) => void): () => void {
      if (!this.listeners.has(threadId)) this.listeners.set(threadId, new Set());
      this.listeners.get(threadId)!.add(listener);
      return () => {
        const threadListeners = this.listeners.get(threadId);
        threadListeners?.delete(listener);
        if (threadListeners?.size === 0) this.listeners.delete(threadId);
      };
    }

    private emit(threadId: string, event: AgentEvent): void {
      for (const listener of Array.from(this.listeners.get(threadId) ?? [])) listener(event);
    }
  }
