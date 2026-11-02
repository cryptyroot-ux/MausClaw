# MausClaw Native Agent Platform — Design for Approval

**Status:** Draft for owner approval; no migration implementation is authorized by this document alone.
**Source baseline:** `main` `0d8eacc65cd3b783a0d28d019d39e6367780b911`; compare tag `v0.1.127` `f474951879559714de819897673d832afaf310e5`.
**Audit:** `/tmp/opencode/MausClaw-native-runtime-audit/report/architecture-audit.md`.
**Acceptance contract:** `docs/superpowers/specs/2026-10-26-mausclaw-cli-free-acceptance-contract.md`.

## Intent

Make MausClaw own the agent loop and run lifecycle. MausClaw selects a model, builds and manages context, interprets model output, runs approved capabilities, persists state, and decides whether to continue, retry, interrupt, or recover. API-model tasks must not require an external agent CLI.

The engine, provider/model transport, and capability execution are separate MausClaw-owned boundaries. “GrokBot-like” means MausClaw owns its engine; this is not a request to copy another product.

## Owner requirements

- **Agent Engine first:** MausClaw owns model-step orchestration, tool dispatch, state/context, cancellation, retry, and recovery.
- **Provider/model independent:** a bot's model choice is separate from engine selection. Compatibility and capabilities are per model, not assumed from a provider name.
- **Capability Runtime:** MausClaw owns discovery/loading, assignment, grants, authorization, execution, timeouts, result/error normalization, and audit behavior for executable capabilities.
- **Skills stay distinct:** a Skill is an assigned/versioned instruction asset. It does not grant or execute capabilities.
- **CLI-free proof:** MausClaw completes a multi-step API-model task with no external agent CLI available or launched.
- **Native-only build:** external CLI/ACP agent engines are not supported or launched in this build; API model providers remain.

## Current source constraints

- `server/drivers/openai-chat.ts` already contains an MausClaw-owned API loop, including streamed content, structured tool calls, 64-round/200-call bounds, per-turn MCP mounting, approval checks, retry guards, and event emission. It is still tied to Chat Completions messages and transport.
- `ProviderAdapter` combines driver identity, model catalog, session behavior, install metadata, and turn execution. Several API drivers share the Chat Completions loop; ACP/CLI drivers delegate their inner model/tool loop to the external engine.
- `server/index.ts` owns turn admission, bot/thread and sender identity, approval selection, transcript/context assembly, task bookkeeping, and event delivery. The extracted engine must preserve these outer safety gates rather than bypass them.
- `server/runtime/runtime.ts` is the assignment/delegation runtime, not the per-turn model/tool loop. The new Agent Runtime remains in a distinct `server/agent-runtime/` module.
- `server/message-db.ts` already provides a private SQLite/WAL message store, transactional writes, and command receipts. `server/store.ts` keeps bot/group configuration in JSON and persists task summaries/cursors there. High-churn per-model-step state should not be added to `bots.json` or `groups.json`.
- Existing local API/MCP tests already provide a deterministic HTTP provider fixture and isolated MCP fixtures. `server/verification-fixture.e2e.test.ts` exercises an isolated server with a restricted CLI environment.

## Approaches considered

1. **Extract and generalize the existing API loop in-process — selected.** Introduce an MausClaw Agent Runtime around the existing API loop, establish provider/model and capability ports, and migrate in slices. This preserves tested behavior and avoids a second process boundary.
2. **Rewrite every driver and loop at once — rejected.** This combines engine extraction, protocol migration, permissions, and data compatibility into one high-risk change and discards existing retry/side-effect protections before parity is shown.
3. **Create a sidecar agent service — rejected.** It adds IPC, process lifecycle, and state ownership boundaries while MausClaw still has to enforce its grants and persist its transcripts.

The user confirmed approach 1 and chose deterministic mock-API acceptance plus an optional, explicitly approved live API smoke test.

## Target architecture

### 1. Agent Runtime — operational owner

The server constructs a trusted `RunRequest` after its existing authentication, thread admission, context, and approval checks. The request carries bot/thread/run identity, user input and prepared MausClaw context, selected `{providerId, modelId}`, a bounded capability grant, run budgets, and cancellation.

The MausClaw runtime owns the per-turn state machine:

1. Create/load the run and bind it to the thread's active-turn claim.
2. Ask the `ModelAdapterRegistry` for the adapter and the selected model's declared capabilities.
3. Reject unsupported request modes before sending a model request or exposing tools.
4. Send one model step and normalize content, reasoning, tool-call, usage, completion, and error events.
5. Prevalidate every tool-call ID, schema, and aggregate budget before any call executes; then authorize/approve each valid call in provider order.
6. Invoke through `CapabilityRuntime`, append the normalized result to the model context, then continue or finish.
7. Persist terminal, interrupted, or recovery-required state and report it through MausClaw's existing event/transcript path.

`ContextBuilder` remains an MausClaw port. The first extraction reuses existing context and compaction behavior; later slices move shared context-window decisions behind the port. The engine owns when another model step occurs, but does not duplicate identity, admission, or policy logic from `server/index.ts`.

### 2. Model Adapter — intelligence transport

The runtime resolves adapters by provider ID; it never embeds provider wire-format logic. A model adapter owns authentication lookup, discovery, request/response encoding, streaming frame parsing, usage, and provider error classification. It never invokes tools and never owns run state.

Capabilities are model-specific. The model profile must distinguish supported, unsupported, and unknown for structured tool calls, parallel calls, streaming, context/input/output limits, and modalities such as image/audio. Unknown is not silently treated as supported. If a request needs an unsupported/unknown feature, the runtime must reject it or use an explicit, tested fallback before capability execution.

Capability evidence is explicit and traceable: use trustworthy provider metadata where available, a versioned MausClaw model manifest for known model IDs, or an operator-declared profile for a custom endpoint. Do not infer support from model-name substrings or from OpenAI-compatible URL shape. Do not send an automatic tool-call probe to discover support; a probe could execute or disclose a capability request. Unknown remains unknown until configured or verified.

The first adapter wraps the existing OpenAI-compatible Chat Completions transport. Other protocols are added as adapters with their own conformance tests; do not claim protocol portability from an interface alone.

### 3. Capability Runtime — MausClaw execution and policy

The runtime owns one `CapabilityRuntime` boundary for executable tools. Before a run, MausClaw opens a per-run `CapabilitySession` already scoped to the bot, thread, and grant. The Agent Runtime receives that session, which lists descriptors, prevalidates a whole tool-call batch, invokes approved calls, and closes its transports when the run completes, fails, or is cancelled. A descriptor includes stable ID/version, kind, schema, required grants, risk/side-effect class, availability, timeout, and result budget. Listing is scoped to the bot, thread, current approval, and policy. Invocation revalidates those facts at execution time; visibility in a model request is not authorization.

MCP transports, native MausClaw tools, and browser/computer operations adapt into this boundary while retaining their existing isolation and ownership checks. Skills load separately as versioned context assets. A Skill cannot grant permissions, register an executable capability, or bypass a capability's schema/approval checks.

### 4. Durable run and side-effect state

Persist run metadata and transitions in SQLite beside the existing transcript store, using migrations in `server/message-db.ts`; keep stable bot settings in the existing registry. The thread transcript remains the canonical user-visible history. Do not persist duplicate full prompts or raw credentials in the run journal.

Use explicit states at minimum: `queued`, `running`, `waiting`, `completed`, `failed`, `interrupted`, and `recovery_required`. Persist a capability-call identity/status before dispatch and its result afterward. If a process stops after a side effect may have started but before a reliable result is committed, mark that call/run uncertain. Never replay it automatically. Recovery inspects or reports the uncertain operation before any continuation.

**Owner decision for the first release:** fail closed. A `recovery_required` run stops and reports that the operator must inspect the affected system outside MausClaw. The first release has no in-product confirm/abandon/retry action for uncertain side effects. It must not resume that run or replay its call automatically. A later user-started run is a new task, not an implicit resolution of the old one.

Retry a model request only when MausClaw can prove it is safe: before visible output and before any capability may have executed, or after an adapter proves a pre-request refusal. Cancellation propagates through model and capability signals. Idempotency receipts may be used where a capability provides them; a call ID alone is not proof that an external side effect did not happen.

For a model-returned batch, parse and validate every call ID, argument schema, and aggregate budget before the first side effect. Then authorize/approve calls individually in provider order, preserving current per-call approval semantics: a denied call never executes, while a separate authorized call may execute. If any call fails or is denied, report partial completion explicitly and do not retry the batch or replay calls that already ran.

### 5. This build: native-only, no external engines

This MausClaw build does **not** support external agent engines. Claude Code, Codex, OpenCode, Hermes, Pi, Antigravity, custom ACP, and the other CLI/ACP-backed engines remain in the source tree but are removed from the provider registry. They are never selectable, authenticated, or launched by this build. Existing bot records that still point at one become unavailable with their stored configuration preserved; MausClaw does not silently rewrite a bot to another engine.

API model providers remain supported. The OpenAI-compatible API driver routes every turn through the MausClaw Agent Runtime. Other API drivers keep their existing MausClaw-owned direct API loop until they are migrated; that loop is not an external engine. The old Chat Completions loop remains only as an internal compatibility path for non-migrated API drivers and focused regression tests, not as a user-selectable external engine.

No new bot defaults, data migration, UI engine selector, live canary, push, or deployment is included in this milestone. The transport adapter still exposes only text input; image input is rejected and image-returning tools fail closed until multimodal transport is added.

## Migration phases and gates

1. **Baseline and contract tests:** pin direct API loop, tool/approval behavior, retry boundaries, cancellation, transcript/context, MCP, and Skills assignment. Record failures by exact suite and environment; do not treat today's interrupted repo-wide run as green.
2. **Ports and deterministic fixture:** finalize `AgentEngine`, model capabilities/events, capability descriptors/results, and run-store contracts. Add a local HTTP provider fixture and fake capabilities before moving the production loop.
3. **In-process extraction:** route the existing direct API loop through the MausClaw Agent Runtime with behavior parity. Keep the old dispatch path available behind an opt-in gate and add rollback.
4. **Durable state and recovery:** add SQLite run/call journal and crash/cancellation/retry handling. Prove uncertain writes are not replayed.
5. **Provider/model separation:** use the first OpenAI-compatible adapter, then add adapters incrementally. Prove the same engine works with distinct adapter implementations and accurately blocks unsupported model features.
6. **Capability unification:** move existing API loop tools/MCP/native tools behind the shared executor; adapt browser/computer without weakening their current controls. Keep Skills loading a separate context path.
7. **CLI-free acceptance:** pass the deterministic API fixture and process-spawn gates in an isolated MausClaw fixture. Run the optional live API smoke only with an owner-selected, already-configured provider/model and explicit approval.
8. **Canary:** opt in a disposable bot/provider, compare behavior, validate rollback and compatibility, then request approval for any broader rollout. No install, migration of live data, production change, push, or deploy is included here.

Each phase must have a plan and tests after this design is approved. The first implementation plan will detail only the smallest end-to-end milestone that proves an MausClaw-owned multi-step API loop, persisted run state, capability grant enforcement, and the deterministic CLI-free fixture. Later phase plans are written after the prior gate passes. Do not implement multiple phases as one change.

## Acceptance and verification policy

The detailed CLI-free cases and evidence are in `2026-10-26-mausclaw-cli-free-acceptance-contract.md`. The required CI proof uses local deterministic services and no live credentials. A live API smoke is a separate, optional release-evidence gate: it is never run without explicit authorization, uses a configured key without printing it, has a spend limit, and runs only in an isolated fixture with safe test capabilities.

Current local evidence is limited: the prototype's focused tests pass 9/9 and `pnpm typecheck` passes. The full `pnpm test` run was stopped by user approval after about 1h24m and accumulated failures across Cloud/hosted E2E suites; it is not green and does not qualify this migration. Before any canary, run the relevant targeted suites in their supported fixture/CI environment and classify full-suite failures against the baseline.

## Non-goals and anti-goals

- Do not register, authenticate, or launch an external agent CLI/ACP engine in this build.
- Do not require an agent CLI for an API-model bot to run natively.
- Do not assume provider/model capabilities from names, endpoint compatibility, or catalog presence.
- Do not expose model-visible tools that the bot cannot invoke under current grants and approval policy.
- Do not turn Skills into executable tools or allow Skill text to grant authority.
- Do not automatically replay an uncertain side effect after a restart or retry.
- Do not run a live model, install MausClaw, migrate live user data, change defaults, push, or deploy without a separate explicit approval.

## Decisions recorded and implementation choices

- Selected: in-process extraction/generalization of the existing MausClaw API loop.
- Selected: deterministic mock API acceptance is mandatory; live provider smoke is optional and explicitly authorized.
- Selected: uncertain side effects fail closed in the first release; operator resolution remains out-of-band.
- Builder call: prevalidate all batch IDs/schemas/budgets before executing; authorize each valid call individually in provider order to preserve current approval behavior and make partial completion explicit.
- Proposed: run journal in the existing private SQLite message database; do not put per-step state in `bots.json`/`groups.json`.
- Proposed: native engine stays opt-in until canary acceptance; existing bots and defaults remain unchanged.
- Builder call: first milestone uses test-fixture-only AgentEngine injection through the ProviderAdapter boundary; no production dispatch change, user-facing engine-selection UI, or data migration is included.
- Left to the implementation plan after owner approval: exact SQLite migration tables, event mapping, adapter conformance matrix, per-phase rollback detail, and which configured API provider/model is used for the optional live smoke.
