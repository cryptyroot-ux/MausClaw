# MausClaw Platform Independence — Architecture Audit and Migration Plan

Date: 2026-10-27
Status: proposed direction, awaiting execution approval
Scope: separate the Agent Engine, LLM Provider/Model, and Capability System so MausClaw is a standalone agent
platform, not an application that rides an external agent engine.

## 1. Target

MausClaw must own the agent lifecycle. Three components must be separable and independently testable:

1. **Agent Engine** — the operational brain: turn admission, model rounds, tool-call orchestration, state,
   context, retry, cancellation, recovery, steering, budgets.
2. **LLM Provider / Model** — the intelligence: provider configuration, authentication, model catalog,
   and a protocol adapter for chat-completions, Responses, Anthropic Messages, Gemini, streaming, tool
   calling, and multimodal input. No provider owns the agent loop.
3. **Capability System** — what the agent can do: MCP servers, skills, native tools (browser, computer,
   files, data), execution sandboxes, approvals, scopes, failure handling, and tests.

The model is chosen independently of the engine. A driver describes a provider; it does not run a turn.
Adding a provider must not require adding an agent loop. Adding a capability must not require a driver.

Non-goals: external CLI/ACP engines are not supported in this build. Their code may remain in the tree,
but it must not be registered, selectable, or launched.

## 2. Current architecture (as-is)

```
ProviderRegistry
  └─ ProviderDriver.create()
       └─ ProviderInstance { models, adapter, auth, generateText }
            └─ ProviderAdapter.sendTurn(input)
                 └─ createOpenAIChatRuntime(...)          <-- driver owns the turn
                      ├─ mountChatTools(...)             <-- capability mounting in the driver
                      ├─ createChatToolApproval(...)     <-- approval in the driver
                      ├─ legacy loop (when no agentEngine flag)
                      └─ native branch
                           └─ AgentEngine.run()          <-- MausClaw engine is a subcomponent
                                ├─ ModelAdapter.generate()
                                └─ CapabilitySession.invoke()
```

The native engine already provides the loop, model adapter, capability bridge, SQLite journal,
compaction, tool-output retention, steering, retry, and recovery. But it is invoked *inside* the
driver, and the driver still owns turn admission, tool mounting, approvals, and the legacy loop.

## 3. Audit findings

| # | Finding | Evidence | Impact | Target |
|---|---|---|---|---|
| F1 | Driver owns the turn lifecycle | `ProviderAdapter.sendTurn` in `server/contracts.ts`; `createOpenAIChatRuntime` in `server/drivers/openai-chat.ts`; native branch calls `nativeEngine.run()` | The engine cannot be the platform boundary; every provider must re-implement or delegate turn ownership | `TurnRuntime` owns `sendTurn`; drivers expose a model gateway only |
| F2 | Provider/model and engine are coupled | `createNativeChatEngine` is constructed inside `openai-compat.ts`, `groq.ts`, `meta.ts`, `minimax.ts`, `mistral.ts`, `cerebras.ts`, `grok.ts`; `providerId` is the driver kind | Adding a provider means touching driver turn code; model selection is tied to instance/driver | `ModelGateway.resolve(providerModel)` independent of driver; provider catalog separate |
| F3 | Capability mounting lives in the driver | `mountChatTools(...)` and `createChatToolApproval(...)` in `openai-chat.ts`; skills injected through prompts; native tools mounted per integration | MCP, skills, and native tools have different lifecycles and no single grant/failure model | `CapabilityRuntime.mount(plan)` + `invoke` + `close`, one policy |
| F4 | One wire format | `server/agent-runtime/model-adapter.ts` implements OpenAI-compatible chat-completions only | Anthropic Messages, Gemini, Responses, and provider-specific tool/stream quirks are unsupported | Protocol adapters + capability detection/probing |
| F5 | Capabilities are static | `createNativeChatEngine` sets tools/imageInput from config predicates, not model discovery | Wrong claims (tools/images) cause failed turns; no fallback by capability | Per-model capability registry, probe/fallback |
| F6 | Skills are prompt assets, not a runtime capability | `server/skills.ts` lists/injects instructions; no execute/permission/failure contract | Skills cannot be tested or governed like tools | Skill provider in the capability runtime |
| F7 | External-engine remnants | CLI/ACP drivers remain in `server/drivers/`; `server/index.test.ts` is excluded because it drives fake CLIs | Risk of accidental registration/launch; tests diverge | Keep code but isolate it; no path to registry/launch; explicit tests |
| F8 | State split across layers | `message-db` (messages/agent runs), driver session state, `server/index.ts` turn state | Hard to reason about recovery; session-level checkpoint absent | Session store owned by the engine |
| F9 | Permission logic is spread | `chat-tool-approval`, tool scope, safety floor, MCP gate, driver approval modes | Policy can drift between paths | One capability policy evaluated by the runtime |
| F10 | No evaluation harness | Only fixtures; no SWE-bench/Terminal-Bench/internal task suite | Cannot prove “better than X” | Eval harness with cost/tokens/resolve rate |

## 4. Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│ TurnRuntime (MausClaw engine)                                     │
│  admission · rounds · state · context · retry · recovery     │
│  steering · budgets · compaction · journal · eval hooks      │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
     ┌──────────▼──────────┐        ┌──────────▼──────────────┐
     │ ModelGateway        │        │ CapabilityRuntime       │
     │ resolve(ref)        │        │ mount(plan)             │
     │ list models         │        │ invoke(call, grant)     │
     │ capabilities(model) │        │ close()                 │
     └──────────┬──────────┘        └──────────┬──────────────┘
                │                              │
   ┌────────────▼────────────┐     ┌───────────▼─────────────┐
   │ Protocol adapters       │     │ MCP providers           │
   │ chat-completions        │     │ Native tools            │
   │ Responses               │     │ Skills                  │
   │ Anthropic Messages      │     │ Browser / Computer      │
   │ Gemini                  │     │ Data / Apps             │
   └────────────┬────────────┘     └───────────┬─────────────┘
                │                              │
   ┌────────────▼────────────┐     ┌───────────▼─────────────┐
   │ Provider catalog        │     │ Capability policy       │
   │ config/auth/catalog     │     │ grants · approvals      │
   │ no turn loop            │     │ safety floor · scopes   │
   └─────────────────────────┘     └─────────────────────────┘
```

Key rule: **dependencies point inward**. A provider adapter knows only its wire protocol. A capability
provider knows only how to mount/invoke/close. The runtime composes them.

## 5. Migration phases

### Phase 0 — Freeze and characterize (1–2 days)

- Record the current native acceptance suite as the baseline: `server/agent-runtime`, `native-only`,
  `openai-tools`, `native-ui`, driver suites.
- Add a “no external process” assertion around the native path (sealed PATH).
- Document every current driver capability flag and where it is consumed.

Acceptance: baseline recorded; no code behaviour change.

### Phase 1 — Make TurnRuntime the owner (the critical inversion)

- Introduce `TurnRuntime.sendTurn(input)` as the top-level entry used by `server/index.ts`.
- Keep `ProviderInstance` for catalog/auth, but its `adapter` becomes a `ModelGateway` descriptor.
- Move turn admission, tool mounting, approval construction, and the native branch out of
  `openai-chat.ts` into the runtime.
- For compatibility, `openai-chat.ts` becomes a thin gateway that returns a `ModelAdapter`; the legacy
  loop is either deleted or kept behind an explicit compatibility flag, never the default.
- Characterize every existing native test; all must pass.

**Progress (2026-10-27, Phase 1b facade):** `NativeTurnRuntime` (`sendTurn`) now exists in
`server/agent-runtime/native-turn-runtime.ts` and is exposed on `ProviderInstance.nativeTurnRuntime`.
The seven API drivers wrap their `sendTurn` closure; `QuickModelFallback` and the room dispatch in
`server/index.ts` route through `nativeTurnRuntime` (fallback to `adapter.sendTurn`). `index.ts` no
longer calls `ProviderAdapter.sendTurn` directly (only type-only `Parameters<...>` references remain).
Verification: typecheck OK; agent-runtime 11 files / 67 tests; openai-chat 5 files / 207 tests;
native-only + openai-tools 4 tests; native-ui 1 test; lint OK. Commits: `11818f313` (facade) on top of
`7b85cb39e` (docs) on top of `c2607d28d` (capability routing).

Phase 1b step 3 (done, commit `6fc9dfc7d`): the entire turn cycle — shared state (`active`,
`listeners`, `emit`, `base`, `complete`, `messagesFor`, `sessionGrants`, `delivered`,
`reasoningReplayRejected`), admission, `mountChatTools`, `createChatToolApproval`, the native branch,
and the legacy loop — now lives in `server/agent-runtime/native-turn-runtime.ts`
(`createNativeTurnRuntime`). `server/drivers/openai-chat.ts` is a re-export shim. The driver is now a
model gateway only; no turn-cycle code remains in `server/drivers`. Verification: typecheck OK; lint OK;
agent-runtime 11 files / 67 tests; openai-chat shim 5 files / 207 tests; chat-size-limit; native-only +
openai-tools 4 tests; native-ui 1 test.

Phase 1b step 4 (deferred): retiring the legacy loop is NOT done yet. Removing it makes 40+ tests in
`openai-chat.test.ts` (rejected-key handling, key rejection, provider error classification) fail, because
those behaviors live in the legacy loop's `complete()` (`noteKeyRejected`, `rejectsKey`) and are not yet
handled by the native model adapter. To retire safely: (a) move key-rejection / provider-error
classification into `server/agent-runtime/model-adapter.ts` (and the Anthropic/Gemini/Responses adapters
in Phase 2), (b) update the affected tests to pass `agentEngine: "mausclaw-native"` (or keep a legacy suite
behind an explicit flag per audit §4). Until then the legacy loop stays as unreachable-in-production
code (API drivers always set `agentEngine: "mausclaw-native"` via `usesNativeAgentEngine`). Phase 2 is the
next phase.

Acceptance: `rg "nativeEngine.run" server/drivers` returns no driver-owned call; only `TurnRuntime`
invokes the engine. `server/index.ts` calls `TurnRuntime`, not `ProviderAdapter.sendTurn`.

### Phase 2 — Split the model gateway

- Define `ModelGateway` / `ModelAdapter` as the only provider-facing contract.
- Add protocol adapters: OpenAI chat-completions, OpenAI Responses, Anthropic Messages, Gemini.
- Add capability detection: declared catalog + probe + safe fallback (tools, images, streaming,
  context window, tool schema limit).
- Provider catalog holds config/auth/models; no loop.

Acceptance: a new provider can be added by implementing a catalog + adapter, with zero changes to the
runtime loop. Tests cover tool calling, streaming, images, context limits, and provider refusals.

### Phase 3 — Unify the capability runtime

- One `CapabilityProvider` interface: `list(plan)`, `mount`, `invoke`, `close`, `describe`.
- MCP servers, native tools, skills, browser/computer, and data connectors become providers.
- One policy: scopes, grants, approvals, safety floor, failure semantics.
- Skills become executable capabilities with lifecycle and tests, not only prompt text.

Acceptance: a turn that uses MCP + a native tool + a skill runs through the same mount/invoke/close
path; denial/failure tests exist per provider type.

### Phase 4 — Retire legacy paths and external-engine coupling

- Remove the legacy driver loop from the default path.
- Keep external CLI/ACP code quarantined; assert the registry never exposes it and no launch path exists.
- Update or delete tests that only make sense for external engines; keep a legacy suite behind an
  explicit flag.

Acceptance: `supportedAgentDrivers` contains only API providers; a sealed-PATH test completes a task;
no child process is spawned.

### Phase 5 — Prove independence and measure

- Independence test: no CLI installed, `PATH=/nonexistent`, API provider only; run a task with MCP,
  a skill, and a native tool; assert completion, `agent_runs`, no child process.
- Eval harness: internal tasks + SWE-bench Verified + Terminal-Bench subset; metrics: resolve rate,
  cost, tokens, wall time, tool calls, compactions, retries, human interventions.
- Only then make comparative claims.

Acceptance: reproducible eval report, not vendor claims.

## 6. Independence proof (must be a test, not a statement)

```sh
PATH=/nonexistent-native-agent-path pnpm exec vitest run server/native-only.e2e.test.ts
```

The fixture already launches a real MausClaw server, a loopback model provider, a real MCP server, and a
real approval card. Extend it to assert:

- no external engine binary is available (`claude`, `codex`, `opencode`, `hermes`, `pi`, `antigravity`);
- the turn completes with `agent_runs` completed;
- the MCP tool executed and the artifact exists;
- no child process was launched by the engine (process audit hook).

## 7. Risks and controls

- **Big-bang risk.** Phase 1 touches the hottest path. Mitigate with characterization tests and a
  compatibility facade; keep the old `sendTurn` until the new runtime passes the same suite.
- **Provider quirks.** Do not pretend all models are compatible; encode capabilities and fail closed.
- **Capability regressions.** Move one provider type at a time (MCP first, native tools next, skills
  last), each with its own tests.
- **Test drift.** External-engine suites are not the oracle for a native-only build; keep them behind
  an explicit flag and add native equivalents.
- **No live smoke without approval.** Deterministic local acceptance first.

## 8. Immediate next slice

Phase 1, smallest safe step:

1. Add `TurnRuntime` with a `sendTurn` facade that delegates to the current native path.
2. Route `server/index.ts` through it for the seven API drivers.
3. Move `mountChatTools` + `createChatToolApproval` + the native branch from `openai-chat.ts` into the
   runtime behind the same tests.
4. Keep the legacy driver loop unreachable for API drivers; delete it only after the suite is green.

This preserves the working engine while correcting the ownership boundary. It is the difference
between “MausClaw has a native loop inside a driver” and “MausClaw is a native agent platform with replaceable
providers and capabilities.”

Phase 4 (done, acceptance met): supportedAgentDrivers contains only API providers (engine-support.test.ts green, including anthropic/gemini/openai-responses); sealed-PATH test (PATH=/nonexistent-native-agent-path) passes native-only.e2e.test.ts; no agent-engine child process is spawned by the native loop. External CLI/ACP code remains quarantined in server/drivers (not registered, not launched).

Phase 4 cleanup (partial): key-rejection marking (noteKeyRejected) has been moved into all four model adapters (OpenAI, Anthropic, Gemini, Responses) so the native path now marks rejected keys. The legacy driver loop remains (reachable in tests) because migrating 40+ openai-chat.test.ts cases to the native path is high-risk; deferred. generateText helper now routes through the adapter for non-OpenAI providers (Phase 2 follow-up).

Upstream check (2026-10-28): fetched origin/main (v0.1.129, 40+ commits since base bd569fb78). Reviewed all: only `0cd63a7db` (Gemini tool calls stream whole with id and no index) was relevant — applied to model-adapter.ts and openai-chat-protocol.ts. Other commits are UI/feature improvements (bot-apps tool grants, tool-receipts stale, i18n, desktop update, LM Studio catalog) — not critical for MausClaw native engine. No security fixes requiring cherry-pick.

Phase 5 (done): independence proof = native-only.e2e.test.ts (sealed PATH, no external engine process, agent_runs completed, MCP tool executed, artifact created). Eval report = evals/runners/run-evals.ts produces reproducible JSON report with resolve rate, model rounds, tool calls, wall time, request count, compactions, recovery_required (latest: 100% resolve, 1/1 task). External benchmarks (SWE-bench Verified, Terminal-Bench, CodeClash, ProgramBench) remain for future work; the harness skeleton exists under evals/.

Phase B/C/D progress (2026-10-28):
- Tool search (deferred MCP tool discovery) — done.
- Hooks (PreToolUse/PostToolUse/PreCompact) — done.
- Concurrent read-only tools — done.
- Background compaction precompute (OpenCode-style) — done.
- Native file tools (read/edit/write/glob/grep) — done.
- Native shell (bash) with sandbox modes (read-only/workspace-write/full) — done.
- Native git operations (status/diff/log/add/commit/branch/checkout/init) — done.
- Worktree isolation (worktree-add/remove/list) — done.
- Native web (fetch/search) — done.
- Capability runtime (CompositeCapabilityRuntime + CapabilityProvider + SessionCapabilityProvider + SkillCapabilityProvider) — done.
- 4 protocol adapters (OpenAI, Anthropic, Gemini, Responses) — done.
- Capability probe (heuristic) + live probe (probeLive) — done.
- Checkpoints before mutating tools + run.checkpoint_available event — done.
- Fallback provider chains (try next on terminal failure) — done.

Deferred (large/external):
- Session tree (Pi-style JSONL tree, branch summary) — large data model change.
- Retire legacy loop (migrate 40+ openai-chat.test.ts to native path) — high-risk.
- Live capability probe testing — needs real API keys.
- External benchmarks (SWE-bench, Terminal-Bench, CodeClash, ProgramBench) — needs datasets/network/Docker.
