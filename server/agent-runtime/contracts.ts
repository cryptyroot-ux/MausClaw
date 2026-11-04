// MausClaw Native Agent Runtime contracts.
//
// These contracts define the boundary between the MausClaw-owned agent engine and
// replaceable provider/model adapters plus MausClaw-owned capability execution.
// They are intentionally protocol-neutral: no provider wire format, CLI, or
// capability transport is allowed to leak through these interfaces.

export type RunId = string;
export type ThreadId = string;
export type BotId = string;
export type EngineId = string;
export type ProviderId = string;
export type ModelId = string;
export type CapabilityId = string;
export type CapabilityCallId = string;

export interface ProviderModelRef {
  providerId: ProviderId;
  modelId: ModelId;
}

export type CapabilitySupport = "supported" | "unsupported" | "unknown";
export type CapabilityLimit = { readonly status: "known"; readonly value: number } | { readonly status: "unknown" };

export interface ModelCapabilities {
  readonly tools: CapabilitySupport;
  readonly parallelTools: CapabilitySupport;
  readonly streaming: CapabilitySupport;
  readonly contextWindow: CapabilityLimit;
  readonly imageInput: CapabilitySupport;
  readonly imageOutput: CapabilitySupport;
  readonly audioInput: CapabilitySupport;
  readonly audioOutput: CapabilitySupport;
  readonly structuredOutput: CapabilitySupport;
  readonly toolSchemaLimit: CapabilityLimit;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly variants?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

export interface ModelCatalog {
  readonly default: string;
  readonly options: ReadonlyArray<ModelCatalogEntry>;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<ModelContentPart> | null;
  readonly toolCallId?: string;
  readonly toolCalls?: ReadonlyArray<ModelToolCall>;
}

/** Provider-neutral content. The adapter owns the wire encoding; the loop never sees a provider format. */
export type ModelContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mimeType: string; readonly data: string };

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelToolResult {
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly content: string;
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
}

export interface ModelGenerateRequest {
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly model: string;
  readonly tools: ReadonlyArray<CapabilityDescriptor>;
  readonly signal: AbortSignal;
}

export type ModelEvent =
  | { readonly type: "content.delta"; readonly kind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "tool_calls"; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "usage"; readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }
  | { readonly type: "completed"; readonly finishReason: string | null };

export type ModelAdapterErrorCode = "transient" | "unsupported_capability" | "unsupported_tools" | "request_too_large" | "invalid_request" | "terminal";

export interface ModelAdapterError extends Error {
  readonly code: ModelAdapterErrorCode;
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;
  /** Present for `request_too_large`: the rejected request's encoded size. */
  readonly bytes?: number;
}

export interface ModelAdapter {
  readonly providerId: ProviderId;
  discoverModels(): Promise<ModelCatalog>;
  capabilities(modelId: ModelId): ModelCapabilities;
  generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent>;
}

export interface ModelAdapterRegistry {
  resolve(ref: ProviderModelRef): ModelAdapter;
}

export interface CapabilityGrant {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly approvalMode: "ask" | "auto-edits" | "approve-for-me" | "full";
  readonly allowed: ReadonlySet<CapabilityId>;
  readonly denied: ReadonlySet<CapabilityId>;
}

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly name: string;
  readonly description: string;
  readonly schema: unknown;
  readonly risk: "read" | "write" | "destructive";
  readonly sideEffect: boolean;
  readonly timeoutMs: number;
  /** When true, multiple instances of this capability may run concurrently in the same batch.
   *  Host-declared only: missing or false means serial execution. */
  readonly parallelSafe?: boolean;
  /** Optional provider-derived key: calls sharing the same key serialize even across different
   *  capabilities, protecting access to shared stateful resources. */
  readonly concurrencyKey?: string;
  /** A tool the engine may drop when a provider rejects the whole tools parameter (e.g. the built-in question tool). */
  readonly optional?: boolean;
}

export interface CapabilityCall {
  readonly runId: RunId;
  readonly callId: CapabilityCallId;
  readonly capabilityId: CapabilityId;
  readonly arguments: unknown;
  readonly botId: BotId;
  readonly threadId: ThreadId;
}

export interface CapabilityResult {
  readonly callId: CapabilityCallId;
  readonly ok: boolean;
  readonly content: string;
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
  readonly uncertain?: boolean;
  readonly error?: string;
}

export interface CapabilitySession {
  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor>;
  validate(call: CapabilityCall, grant: CapabilityGrant): void;
  invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult>;
  close(): Promise<void>;
}

/** A provider of capabilities (MCP server, native tool, skill, browser/computer, data connector).
 *  One lifecycle: mount → invoke → close, governed by a single grant/policy. */
export interface CapabilityProvider {
  readonly id: CapabilityId;
  readonly kind: "mcp" | "native-tool" | "skill" | "browser" | "computer" | "data";
  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor>;
  validate(call: CapabilityCall, grant: CapabilityGrant): void;
  mount(context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<void>;
  invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult>;
  close(): Promise<void>;
  describe(): string;
}

export type AgentRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "recovery_required";
export type CapabilityCallStatus = "dispatching" | "succeeded" | "failed" | "recovery_required";

export interface AgentRunRecord {
  readonly runId: RunId;
  readonly engineId: EngineId;
  readonly providerModel: ProviderModelRef;
  readonly status: AgentRunStatus;
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly modelRounds: number;
  readonly toolCalls: number;
  readonly failureCode?: string;
}

export interface AgentCapabilityCallRecord {
  readonly runId: RunId;
  readonly callId: CapabilityCallId;
  readonly capabilityId: CapabilityId;
  readonly risk: CapabilityDescriptor["risk"];
  readonly status: CapabilityCallStatus;
  readonly startedAt: number;
  readonly settledAt?: number;
}

export interface AgentRunStore {
  createRun(record: AgentRunRecord): void;
  getRun(runId: RunId): AgentRunRecord | undefined;
  updateRunProgress(runId: RunId, progress: { readonly modelRounds: number; readonly toolCalls: number; readonly updatedAt: number }): void;
  transitionRun(runId: RunId, expected: AgentRunStatus, next: AgentRunStatus, updatedAt: number, failureCode?: string): boolean;
  beginCapabilityCall(record: AgentCapabilityCallRecord): void;
  settleCapabilityCall(runId: RunId, callId: CapabilityCallId, status: CapabilityCallStatus, settledAt: number): void;
  recoverUnsettledRuns(now: number): void;
  /** Optional so existing stores and tests do not need to persist compaction history. */
  recordCompaction?(record: AgentCompactionRecord): void;
  /** Optional: retain a tool output that was truncated before entering the model prompt. */
  recordToolOutput?(record: AgentToolOutputRecord): void;
  readToolOutput?(runId: RunId, callId: CapabilityCallId): AgentToolOutputRecord | undefined;
}

export interface AgentCompactionRecord {
  readonly runId: RunId;
  readonly sequence: number;
  readonly summary: string;
  readonly firstKeptIndex: number;
  readonly tokenEstimate: number;
  readonly trigger: "auto" | "overflow";
  readonly createdAt: number;
}

export interface AgentToolOutputRecord {
  readonly runId: RunId;
  readonly callId: CapabilityCallId;
  readonly content: string;
  readonly bytes: number;
  readonly createdAt: number;
}

export type AgentEvent =
  | { readonly type: "run.started"; readonly runId: RunId; readonly engineId: EngineId; readonly providerModel: ProviderModelRef }
  | { readonly type: "model.delta"; readonly runId: RunId; readonly kind: "assistant_text" | "reasoning_text"; readonly delta: string }
  | { readonly type: "usage"; readonly runId: RunId; readonly input: number; readonly output: number; readonly cachedInput?: number; readonly costUsd?: number }
  | { readonly type: "tool.calls"; readonly runId: RunId; readonly calls: ReadonlyArray<ModelToolCall> }
  | { readonly type: "tool.result"; readonly runId: RunId; readonly callId: CapabilityCallId; readonly result: CapabilityResult }
  | { readonly type: "turn.completed"; readonly runId: RunId; readonly ok: boolean; readonly stopReason: string | null }
  | { readonly type: "run.failed"; readonly runId: RunId; readonly message: string; readonly code?: string }
  | { readonly type: "run.interrupted"; readonly runId: RunId }
  | { readonly type: "run.compacted"; readonly runId: RunId; readonly summary: string; readonly firstKeptIndex: number; readonly tokenEstimate: number; readonly trigger: "auto" | "overflow" }
  | { readonly type: "run.recovery_required"; readonly runId: RunId; readonly callId: CapabilityCallId }
  | { readonly type: "run.checkpoint_available"; readonly runId: RunId; readonly callId: CapabilityCallId; readonly checkpointHash: string }
  | { readonly type: "run.plugins_loaded"; readonly runId: RunId; readonly plugins: ReadonlyArray<string> };

export interface AgentRunRequest {
  readonly botId: BotId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly providerModel: ProviderModelRef;
  /** Optional fallback providers tried in order when the primary fails with a terminal error. */
  readonly fallbackProviders?: ReadonlyArray<ProviderModelRef>;
  readonly grant: CapabilityGrant;
  readonly capabilities: CapabilitySession;
  readonly signal: AbortSignal;
  /** Images attached to this turn only; kept out of the replay transcript. */
  readonly images?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
  /** Optional hard caps for this run. The run stops gracefully when any is reached. */
  readonly budget?: {
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
    readonly maxWallTimeMs?: number;
  };
  /** Nudge a reply that announces a step and ends without a tool call, at most three times per run. */
  readonly nudgeAnnouncedAction?: boolean;
  /** Tool scope for filtering available tools. */
  readonly toolScope?: unknown;
  /** Number of corrective rounds allowed when a tool call fails. */
  readonly toolErrorCorrectiveRounds?: number;
  /** Maximum number of model requests per turn. The last request is sent with tools disabled. */
  readonly maxTurnRequests?: number;
  /** Provider instance identity for calibration and request limiting. */
  readonly providerInstanceId?: string;
  /** Optional hook runner (PreToolUse/PostToolUse/PreCompact/Stop). */
  readonly hooks?: {
    run(event: "pre_tool_use" | "post_tool_use" | "pre_compact" | "stop" | "session_start" | "session_end", context: { readonly runId: string; readonly threadId: string; readonly botId: string; readonly capabilityId?: string; readonly callId?: string; readonly arguments?: unknown; readonly result?: { readonly ok: boolean; readonly content: string }; readonly reason?: string }): Promise<{ readonly allow: boolean; readonly messages: ReadonlyArray<string>; readonly modifiedArguments?: unknown }>;
  };
}

export interface AgentRunHandle {
  readonly runId: RunId;
  readonly done: Promise<void>;
}

export interface AgentEngine {
  readonly engineId: EngineId;
  run(request: AgentRunRequest): Promise<AgentRunHandle>;
  interrupt(runId: RunId): Promise<void>;
  /** Queue a user correction for the next model round. Never interrupts a running tool batch. */
  steer(runId: RunId, text: string): Promise<"steered" | "refused">;
  getState(runId: RunId): AgentRunRecord | undefined;
  onEvent(threadId: string, listener: (event: AgentEvent) => void): () => void;
  /** Optional orchestrator: multi-step task orchestration with swarm support. */
  readonly orchestrator?: {
    readonly runPlan: (steps: ReadonlyArray<unknown>, context: unknown) => { planId: string; done: Promise<void> };
    readonly onEvent: (planId: string, listener: (event: unknown) => void) => () => void;
    readonly interrupt: (planId: string) => void;
  };
  /** Optional bounded in-loop plan+verify. Off by default. */
  readonly planVerify?: {
    readonly enabled: boolean;
    readonly maxPlanSteps: number;
    readonly maxVerifyRounds: number;
  };
}

// ============================================================================
// Layer 3: Orchestration (Option A — orchestrator above Agent Engine)
// Additive only; no existing types modified.
// ============================================================================

export type PlanId = string;
export type StepId = string;

export type PlanStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "approval_required";

export interface PlanStep {
  readonly id: StepId;
  readonly text: string;
  readonly providerModel: ProviderModelRef;
  readonly grant: CapabilityGrant;
  readonly capabilities: CapabilitySession;
  readonly dependsOn?: ReadonlyArray<StepId>;
  readonly approval?: "auto" | "ask";
  readonly budget?: {
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
    readonly maxWallTimeMs?: number;
    readonly maxModelRounds?: number;
  };
}

export interface PlanResult {
  readonly stepId: StepId;
  readonly runId: string;
  readonly status: StepStatus;
  readonly output?: string;
  readonly error?: string;
  readonly modelRounds?: number;
  readonly toolCalls?: number;
}

export interface OrchestratorContext {
  readonly planId: PlanId;
  readonly contextVariables: ReadonlyMap<string, string>;
  readonly signal: AbortSignal;
  readonly approvalMode: "ask" | "auto-edits" | "approve-for-me" | "full";
}

export interface PlanRecord {
  readonly planId: PlanId;
  readonly status: PlanStatus;
  readonly steps: ReadonlyArray<StepId>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contextVariables: ReadonlyMap<string, string>;
}

export interface StepRecord {
  readonly stepId: StepId;
  readonly planId: PlanId;
  readonly status: StepStatus;
  readonly result?: PlanResult;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface OrchestratorStore {
  createPlan(record: PlanRecord): void;
  getPlan(planId: PlanId): PlanRecord | undefined;
  updatePlanStatus(planId: PlanId, status: PlanStatus, updatedAt: number): boolean;
  createStep(record: StepRecord): void;
  getStep(stepId: StepId): StepRecord | undefined;
  updateStepStatus(stepId: StepId, status: StepStatus, updatedAt: number, result?: PlanResult): boolean;
  listSteps(planId: PlanId): StepRecord[];
  recoverUnsettledPlans(now: number): void;
}

export type OrchestrationEvent =
  | { readonly type: "plan.started"; readonly planId: PlanId; readonly stepCount: number }
  | { readonly type: "plan.completed"; readonly planId: PlanId }
  | { readonly type: "plan.failed"; readonly planId: PlanId; readonly error: string }
  | { readonly type: "plan.interrupted"; readonly planId: PlanId }
  | { readonly type: "step.started"; readonly planId: PlanId; readonly stepId: StepId }
  | { readonly type: "step.completed"; readonly planId: PlanId; readonly stepId: StepId; readonly runId: string }
  | { readonly type: "step.failed"; readonly planId: PlanId; readonly stepId: StepId; readonly error: string }
  | { readonly type: "step.retry"; readonly planId: PlanId; readonly stepId: StepId; readonly attempt: number; readonly feedback: string }
  | { readonly type: "step.approval_required"; readonly planId: PlanId; readonly stepId: StepId }
  | { readonly type: "plan.approval_required"; readonly planId: PlanId }
  | { readonly type: "context.variable.set"; readonly planId: PlanId; readonly key: string; readonly value: string }
  | { readonly type: "plan.conflicts"; readonly planId: PlanId; readonly conflicts: ReadonlyArray<{ readonly stepId: string; readonly reason: string }> };

export interface Orchestrator {
  readonly engineId: EngineId;
  runPlan(steps: readonly PlanStep[], context: OrchestratorContext): { planId: PlanId; done: Promise<void> };
  /** Generate a plan from a task description. Returns steps that can be passed to runPlan. */
  generatePlan?(input: { readonly task: string; readonly providerModel: ProviderModelRef; readonly grant: CapabilityGrant; readonly capabilities: CapabilitySession; readonly maxSteps?: number }): readonly PlanStep[];
  getPlanResults(planId: PlanId): readonly StepRecord[] | undefined;
  interrupt(planId: PlanId): void;
  approve(planId: PlanId, stepId?: StepId): void;
  reject(planId: PlanId, stepId?: StepId, reason?: string): void;
  onEvent(planId: string, listener: (event: OrchestrationEvent) => void): () => void;
}
