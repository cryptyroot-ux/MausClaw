# MausClaw Native Runtime Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a durable MausClaw-owned multi-step API agent loop and prove it through the existing OpenAI-compatible `ProviderAdapter` boundary with no external agent CLI.

**Architecture:** Keep `ProviderAdapter.sendTurn` as the compatibility boundary. The first milestone adds a protocol-neutral `AgentEngine`, a real OpenAI-compatible `ModelAdapter`, a grant-enforcing adapter over the existing `ChatToolSession`, and a SQLite run/capability-call journal. Exercise the new engine through test-fixture injection; leave production routing, other provider drivers, ACP/CLI paths, UI selection, bot settings, and defaults unchanged.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Vitest, local HTTP/SSE fixtures, existing MCP test fixtures.

**Spec:**
- `docs/superpowers/specs/2026-10-26-mausclaw-native-agent-platform-design.md`
- `docs/superpowers/specs/2026-10-26-mausclaw-cli-free-acceptance-contract.md`

## Global Constraints

- Existing ACP/CLI providers, stored bot model selections, transcripts, approvals, and defaults remain unchanged.
- No user-facing engine-selection UI or persisted engine setting is added in this milestone.
- Unknown model capabilities fail closed; do not infer support from an endpoint URL or model-name substring.
- The injected M1 path accepts only input modalities represented by its `ModelMessage` contract; unsupported image/audio requests are rejected, never silently dropped. The uninjected legacy path remains unchanged.
- Validate all IDs, schemas, and aggregate budgets before any tool in a batch executes; then authorize calls individually in provider order.
- Persist a capability dispatch state before execution. On uncertain outcome, mark `recovery_required` and never replay automatically.
- Skills remain assigned context assets; they never grant or execute capabilities.
- CI acceptance uses only local deterministic services. Do not run a live API smoke, install, push, deploy, or change production defaults without separate explicit approval.
- The local full `pnpm test` run is currently not green and was stopped after about 1h24m. Use the targeted gates below; do not claim the repository-wide suite passes.

## Review Focus

- Unknown tool capability on a custom OpenAI-compatible model must block the request; test in Task 3.
- A mixed allowed/denied tool batch may partially execute only after whole-batch syntax/schema/budget preflight; test in Task 4.
- Crash after dispatch but before result persistence must become `recovery_required` and must not replay; test in Task 2.
- A transient model error is retried only before visible output or capability dispatch; cancellation/late errors must not retry or start a later call; test in Task 1.
- Duplicate call IDs, malformed schemas, and aggregate tool-budget overflow must cause zero batch side effects; test in Task 1.

---

### Task 1: Protocol-neutral Agent Engine loop

**Files:**
- Modify: `server/agent-runtime/contracts.ts`
- Modify: `server/agent-runtime/runtime.ts`
- Modify: `server/agent-runtime/model-adapter.ts`
- Modify: `server/agent-runtime/capability-runtime.ts`
- Modify: `server/agent-runtime/runtime.test.ts`
- Modify: `server/agent-runtime/model-adapter.test.ts`
- Modify: `server/agent-runtime/capability-runtime.test.ts`

**Interfaces:**
- Consumes: existing `ProviderModelRef`, `CapabilityGrant`, and `CapabilityDescriptor` concepts.
- Produces these exact ports in `contracts.ts`:
  - `CapabilitySupport = "supported" | "unsupported" | "unknown"` and `CapabilityLimit = { status: "known"; value: number } | { status: "unknown" }`.
  - `ModelCapabilities` has `tools`, `parallelTools`, `streaming`, `imageInput`, `imageOutput`, `audioInput`, `audioOutput`, and `structuredOutput` as `CapabilitySupport`; `contextWindow` and `toolSchemaLimit` are `CapabilityLimit`.
  - `ModelMessage` has `role: "system" | "user" | "assistant" | "tool"`, `content: string | null`, and optional `toolCallId`/`toolCalls`. `ModelToolCall` has `id`, `name`, and `arguments: unknown`. `ModelGenerateRequest` has `messages: ReadonlyArray<ModelMessage>`, `model: string`, `tools: ReadonlyArray<CapabilityDescriptor>`, and `signal: AbortSignal`.
  - `ModelEvent` is a discriminated union of `content.delta` (`kind: "assistant_text" | "reasoning_text"`, `delta`), `tool_calls` (`calls`), `usage` (`input`, `output`, optional `cachedInput`/`costUsd`), and `completed` (`finishReason`). `ModelAdapter` has `providerId`, `discoverModels(): Promise<ModelCatalog>`, `capabilities(modelId): ModelCapabilities`, and `generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent>`; `ModelAdapterRegistry.resolve(ref: ProviderModelRef): ModelAdapter`.
  - `ModelAdapter.generate` throws a normalized `ModelAdapterError` with `code: "transient" | "unsupported_capability" | "invalid_request" | "terminal"`, `retryable`, `requestStarted`, and a safe message; it never forwards raw provider bodies or credentials to user-facing events.
  - `CapabilityGrant` has `botId`, `threadId`, `approvalMode`, `allowed`, and `denied`. `CapabilityDescriptor` has `id`, `name`, `description`, `schema`, `risk`, `sideEffect`, and `timeoutMs`. `CapabilityCall` has `runId`, `callId`, `capabilityId`, `arguments`, `botId`, and `threadId`; `CapabilityResult` has `callId`, `ok`, `content`, and optional `images`, `uncertain`, and `error`.
  - A run-scoped `CapabilitySession` exposes `list(grant: CapabilityGrant): readonly CapabilityDescriptor[]`, `validate(call: CapabilityCall, grant: CapabilityGrant): void`, `invoke(call: CapabilityCall, context: { grant: CapabilityGrant; signal: AbortSignal }): Promise<CapabilityResult>`, and `close(): Promise<void>`.
  - `AgentRunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "recovery_required"`; `CapabilityCallStatus = "dispatching" | "succeeded" | "failed" | "recovery_required"`.
  - `AgentRunRecord` stores `runId`, `botId`, `threadId`, `engineId`, `providerModel`, `status`, `startedAt`, `updatedAt`, `modelRounds`, `toolCalls`, and optional `failureCode`. `modelRounds` counts each `ModelAdapter.generate` attempt, including a safe retry; the 64-round cap applies to attempts. `AgentCapabilityCallRecord` stores `runId`, `callId`, `capabilityId`, `risk`, `status`, `startedAt`, and optional `settledAt`; it does not store raw arguments, prompts, or credentials.
  - `AgentRunStore.createRun(record: AgentRunRecord): void`, `getRun(runId: string): AgentRunRecord | undefined`, `updateRunProgress(runId: string, progress: { modelRounds: number; toolCalls: number; updatedAt: number }): void`, `transitionRun(runId: string, expected: AgentRunStatus, next: AgentRunStatus, updatedAt: number, failureCode?: string): boolean` (false means stale prior status), `beginCapabilityCall(record: AgentCapabilityCallRecord): void`, `settleCapabilityCall(runId: string, callId: string, status: CapabilityCallStatus, settledAt: number): void`, and `recoverUnsettledRuns(now: number): void`.
  - `AgentEvent` includes `run.started`, `model.delta`, `usage`, `tool.calls`, `tool.result`, `turn.completed`, `run.failed`, `run.interrupted`, and `run.recovery_required`; each event carries its `runId`.
  - `createAgentEngine({ adapters, store }): AgentEngine`; `AgentEngine.run(request: AgentRunRequest): Promise<AgentRunHandle>`, `interrupt(runId: string): Promise<void>`, `getState(runId: string): AgentRunRecord | undefined`, and `onEvent(threadId: string, listener: (event: AgentEvent) => void): () => void`. `AgentRunRequest` contains `botId`, `threadId`, `text`, `messages: ReadonlyArray<ModelMessage>`, `providerModel`, `grant`, `capabilities: CapabilitySession`, and `signal`; `AgentRunHandle` contains `runId` and `done: Promise<void>`.

- [x] **Step 1: Write failing runtime behavior tests**

Add the eight runtime behavior tests named in the previous list. Also update the prototype adapter tests to cover tri-state capabilities and `AsyncIterable<ModelEvent>`, and update the in-memory capability tests to cover `CapabilitySession` list/validate/invoke/close with a run ID. Use fake adapters, a fake run store, and safe fixture capabilities. Assert ordered events, final state/counters, zero calls for rejected batches, safe pre-output retry only, and no post-cancel dispatch or duplicate call.

- [x] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm vitest run server/agent-runtime/`
Expected: the new runtime behaviors and old adapter/session contract tests fail against the obsolete prototype implementations, not due to test setup errors.

- [x] **Step 3: Implement the protocol-neutral contracts and loop**

Implement the protocol-neutral loop and update the existing in-memory CapabilitySession and adapter stub to the new contracts so this task remains typecheckable. Consume normalized `ModelEvent`s, prevalidate a full tool batch before dispatch, preserve `content: null` for assistant tool-call messages, and keep round/call caps at the existing API-loop limits of 64 attempts and 200 calls. Persist progress counters through `updateRunProgress`. Retry at most three total attempts only for `ModelAdapterError(code="transient", retryable=true, requestStarted=false)` before any visible delta or capability dispatch; use the existing interruptible backoff helper. Never retry after output or a possible side effect. Task 3 later replaces the stub adapter with real HTTP/SSE transport; Task 4 adds the ChatToolSession bridge.

- [x] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run server/agent-runtime/`
Expected: all runtime and in-memory adapter/session tests pass; denied/invalid/cancelled cases invoke no forbidden follow-up call.

Run: `pnpm typecheck`
Expected: TypeScript build and server typecheck pass with every current `server/agent-runtime/` consumer aligned to the new ports.

- [ ] **Step 5: Commit**

Commit with `feat: add protocol-neutral Agent Engine loop`.

### Task 2: Durable run and capability-call journal

**Files:**
- Create: `server/agent-runtime/run-store.ts`
- Modify: `server/message-db.ts`
- Test: `server/message-db.test.ts`
- Create: `server/agent-runtime/run-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `AgentRunStore`, `AgentRunRecord`, `AgentCapabilityCallRecord`, and status types.
- Produces: SQLite-backed implementations with the exact Task 1 method signatures; status transitions compare the expected prior state and fail on a stale transition.

- [x] **Step 1: Write failing persistence and recovery tests**

Add tests named `persists_run_transitions_and_progress_across_a_database_reopen`, `marks_in_flight_capability_calls_recovery_required_without_replaying_them`, and `marks_an_orphaned_model_run_interrupted_when_no_capability_was_in_flight`. Use a fresh temporary `DATA_DIR`; simulate process restart by closing/reopening the SQLite store.

- [x] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm vitest run server/agent-runtime/run-store.test.ts`
Expected: missing table/store behavior fails; the test must show the journal does not yet persist the run/call state.

- [x] **Step 3: Add the SQLite run journal**

Add `agent_runs` and `agent_capability_calls` tables to `message-db.ts`. Persist run transitions transactionally. Before invoking a capability, durably commit its `dispatching` record using the message DB's durable-write pattern; store only call identity/risk/status and a bounded redacted result summary, not raw prompts or credentials. On startup, convert orphaned model runs to `interrupted` and dispatching capability calls to `recovery_required`.

- [x] **Step 4: Run persistence tests**

Run: `pnpm vitest run server/agent-runtime/run-store.test.ts server/message-db.test.ts`
Expected: all selected tests pass; a reopened DB reports the uncertain call and never marks it safe to replay. Run `server/message-db.test.ts` only with a disposable `MAUSCLAW_DATA_DIR` because that suite deletes its data directory.

- [x] **Step 5: Commit**

Commit with `feat: persist native agent run and call state`.

### Task 3: OpenAI-compatible Model Adapter

**Files:**
- Modify: `server/agent-runtime/model-adapter.ts`
- Create: `server/agent-runtime/model-adapter.test.ts`
- Test: `server/drivers/openai-chat-protocol.test.ts`

**Interfaces:**
- Consumes: Task 1 `ModelEvent`, `ModelCapabilities`, and `ModelAdapter` contracts.
- Produces: `createOpenAICompatibleModelAdapter(config): ModelAdapter`, where `config` contains `providerId`, base `apiUrl`, in-memory `apiKey`, current `ModelCatalog`, per-model `capabilities(modelId)`, optional `requestBody(model, messages, stream)` customization, and optional injected `fetcher`. It handles `/chat/completions` JSON and SSE formats.

- [x] **Step 1: Write failing local-HTTP adapter tests**

Add tests named `maps a JSON tool completion to normalized events`, `maps SSE deltas, usage, and fragmented tool calls`, `classifies 429 and 5xx as transient before output`, `classifies an invalid request as non-retryable`, `reports unknown capabilities without guessing`, and `aborts fetch when the signal is cancelled`. Use a loopback HTTP fixture and an injected `fetch` implementation where required.

- [x] **Step 2: Run the focused adapter tests and confirm RED**

Run: `pnpm vitest run server/agent-runtime/model-adapter.test.ts`
Expected: the current stub response fails the scripted request/response assertions.

- [x] **Step 3: Extract Chat Completions transport into the adapter**

Implement the adapter as a standalone Chat Completions transport. Do not alter the legacy `openai-chat.ts` loop in this milestone; the native ProviderAdapter path in Task 5 calls the new adapter directly. Read API credentials from the existing provider instance environment in memory; never log or persist their values. Populate per-model capabilities from trustworthy provider metadata, a versioned manifest, or explicit test/operator profiles; leave unsupported evidence as `unknown`.

- [x] **Step 4: Run adapter and protocol tests**

Run: `pnpm vitest run server/agent-runtime/ server/drivers/openai-chat-protocol.test.ts`
Expected: all selected adapter and existing protocol tests pass with no external network access.

- [x] **Step 5: Commit**

Commit with `feat: add OpenAI-compatible model adapter`.

### Task 4: Capability Runtime bridge for existing Chat tools

**Files:**
- Create: `server/agent-runtime/chat-capability-runtime.ts`
- Test: `server/drivers/chat-mcp-tools.test.ts`
- Create: `server/agent-runtime/chat-capability-runtime.test.ts`
- Test: `server/drivers/chat-tool-approval.test.ts`

**Interfaces:**
- Consumes: Task 1 `CapabilitySession`, `CapabilityDescriptor`, `CapabilityCall`, `CapabilityGrant`, and `CapabilityResult`; existing `ChatToolSession` and chat approval API.
- Produces: `createChatCapabilitySession({ session, approval }): CapabilitySession`; `approval` adapts the existing `floored`, `ask`, and `question` decisions without bypassing them.

- [x] **Step 1: Write failing bridge tests**

Add tests named `lists only in-scope chat capabilities`, `waits for approval before executing an ask-only capability`, `preserves mixed batch partial results without replay`, `does not expose skill assets as capabilities`, and `closes the chat session and refuses later invocation`. Use a fake `ChatToolSession` and approval broker; assert denied/out-of-scope calls produce no execution.

- [x] **Step 2: Run the focused bridge tests and confirm RED**

Run: `pnpm vitest run server/agent-runtime/chat-capability-runtime.test.ts`
Expected: tests fail because the new bridge is absent.

- [x] **Step 3: Adapt existing ChatToolSession into CapabilityRuntime**

Map `ChatToolSession.definitions` to descriptors and implement `list`, `validate`, `invoke`, and `close`. AgentRuntime calls `validate` for every call in a batch before any side effect; `invoke` rechecks scope and current approval for each call in provider order. Never execute a denied call; normalize output/images/errors; close the session on every terminal path. Preserve the existing `ask_user`, MCP, and computer ownership rules. Do not load Skills as executable capabilities.

- [x] **Step 4: Run bridge and approval tests**

Run: `pnpm vitest run server/agent-runtime/chat-capability-runtime.test.ts server/drivers/chat-mcp-tools.test.ts server/drivers/chat-tool-approval.test.ts`
Expected: selected tests pass; denied/out-of-scope calls produce no fixture side effect.

Run: `pnpm typecheck`
Expected: TypeScript build and server typecheck pass.

- [x] **Step 5: Commit**

Commit with `feat: bridge chat tools into the native Capability Runtime`.

### Task 5: ProviderAdapter integration and CLI-free acceptance

**Files:**
- Modify: `server/drivers/openai-chat.ts`
- Create: `server/agent-runtime/native-provider-acceptance.test.ts`
- Test: `server/drivers/openai-chat-tools.test.ts`
- Test: `server/drivers/openai-chat.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 `AgentEngine`, SQLite `AgentRunStore`, OpenAI-compatible `ModelAdapter`, and `ChatToolSession` capability bridge.
- Produces: the existing `ProviderAdapter.sendTurn/interruptTurn/onEvent` surface backed by AgentRuntime when an optional `nativeAgentEngine: AgentEngine` is passed to `createOpenAIChatRuntime`. With no injection, the current loop and all production callers remain unchanged. The acceptance fixture injects an engine that substitutes its own capability session; production gets no capability-bypass hook.

- [x] **Step 1: Add the ProviderAdapter-level regression test first**

Add tests named `completes two tool rounds without an agent CLI` and `rejects unrepresented image input before contacting the provider` in `server/agent-runtime/native-provider-acceptance.test.ts`. Use the local HTTP provider fixture, a temporary `DATA_DIR`, the SQLite run store, a real OpenAI-compatible adapter, and an injected engine. Assert model → two capability/result rounds → final answer, persisted run/call state, existing event shape, exactly two capability invocations, and zero provider requests for the rejected image turn. Run the test process with a non-existent `PATH` and no MCP transports so no agent CLI can be discovered.

- [x] **Step 2: Run the test and confirm RED**

Run: `pnpm vitest run server/agent-runtime/native-provider-acceptance.test.ts`
Expected: the legacy loop reports `ok: false` for tool calls without mounted tools, and the image turn is not rejected before the provider.

- [x] **Step 3: Add the injectable AgentRuntime path**

Add optional `nativeAgentEngine?: AgentEngine` to `createOpenAIChatRuntime`; when present, mount the existing ChatToolSession, adapt it with `createChatCapabilitySession`, send the prepared turn/context, model reference, grant, and signal through `AgentEngine.run()`, and map normalized events to existing ProviderAdapter events. When absent, retain the current loop. Keep `ProviderAdapter` return types, turn/event IDs, cancellation, usage, and failure mapping stable. Do not change `server/index.ts` routing, add UI controls, change saved bot settings, or migrate other API/ACP/CLI drivers in this milestone.

- [x] **Step 4: Run focused compatibility and acceptance tests**

Run: `pnpm vitest run server/agent-runtime/ server/drivers/openai-chat-tools.test.ts server/drivers/openai-chat.test.ts server/drivers/openai-chat-protocol.test.ts server/drivers/chat-tool-approval.test.ts`
Expected: all selected tests pass; no live provider/API credential is used and no external agent CLI launches.

- [x] **Step 5: Run typecheck and inspect the final diff**

Run: `pnpm typecheck`
Expected: TypeScript build and server typecheck pass without diagnostics. Do not rerun the 1h+ repo-wide suite in this milestone; the existing local full-suite attempt is recorded as not green and should be triaged in its supported CI environment before canary.

- [x] **Step 6: Commit the milestone**

Commit with `feat: add native Agent Runtime ProviderAdapter path`.

## Completion gate

The milestone is complete only when all five tasks' focused tests and typecheck pass, the ProviderAdapter-level local-HTTP acceptance test shows ordered multi-step tool execution and zero agent-CLI launches, SQLite recovery marks uncertain calls fail-closed, and no existing bot/default configuration changes. The optional live API smoke, UI engine selector, other provider protocols, remaining capability families, canary, push, and deployment remain out of scope pending separate approval.

## Milestone status

Implemented and committed. Final focused verification after the review fix pass: 10 test files / 226 tests passed, `pnpm typecheck` passed. A fresh review found one Critical and nine Important issues; all were fixed in one test-first pass, with two Minor findings deferred (batch item-pending display and missing journal result summaries). Final fixes are in `ef8c19f`. The repo-wide `pnpm test` remains not green and was not rerun for this milestone.
