# MausClaw CLI-Free Agent Runtime — Acceptance Contract for Approval

**Status:** Draft for owner approval; this is a test contract, not a claim that the current prototype passes it.
**Design:** `docs/superpowers/specs/2026-10-26-mausclaw-native-agent-platform-design.md`.
**Scope:** prove MausClaw owns a multi-step API-model loop and can route only granted capabilities without launching an external agent CLI.

## Proof layers

### A. Required deterministic CI proof

- Run MausClaw in an isolated verification fixture with its own temporary `DATA_DIR`, home, ports, and test bot.
- Invoke the native runtime through the existing direct-API `ProviderAdapter.sendTurn` boundary used by `server/index.ts`. OpenAI-compatible turns carry `agentEngine:"mausclaw-native"`; external CLI/ACP engines are not registered or launched. The fixture may replace the capability session only inside its own injected engine.
- Use a local HTTP model API that records requests and returns scripted responses. No live provider, external network, user data, or provider credential is used.
- Use safe fixture-native capabilities and a local MCP fixture. Any file write is confined to the fixture's temporary directory.
- Restrict `PATH` to the test runtime and test shims. Record process launches and fail if an external agent CLI is invoked. The fixture may use only the explicitly declared local service processes needed by the test.
- Record provider/model IDs, request/response shapes, run events, capability-call states, and process-launch evidence. Redact prompts and all credential values from stored logs.

### B. Optional live API smoke

- Run only after the owner selects a provider/model and explicitly approves the live request.
- Use an already configured credential from the approved local credential source. Never print, persist, or include the credential in test artifacts.
- Use a disposable fixture bot and safe read-only or fixture-local capabilities, a strict cost/round/tool-call cap, and a timeout.
- Keep the same restricted `PATH` and process-launch assertions as Gate A.
- Treat this as separate evidence of one real provider/model integration. It does not replace the deterministic suite and does not establish compatibility for other providers or models.

## Required deterministic cases

| ID | Case | Pass condition |
|---|---|---|
| `ENGINE-LOOP` | Script three model rounds: call fixture capability A, receive its result, call capability B, receive its result, then return a final answer. | MausClaw records the ordered model → capability → result → model sequence; each call runs once; final state is completed with exact round/call counts. |
| `ENGINE-PORT` | Run the same Agent Runtime through the deterministic fake adapter and the OpenAI-compatible HTTP adapter. | The loop and capability policy are unchanged by adapter choice. The adapter emits normalized events and does not execute capabilities itself. |
| `MODEL-CAPABILITY` | Select models with differing tool, streaming, context, and image capability profiles, including unknown values; inject provider metadata, a versioned manifest entry, and an explicit custom-endpoint profile. | Unsupported or unknown requested features fail before a capability is advertised or invoked; name/URL guesses and side-effect-capable automatic probes are rejected; any fallback is explicit and separately asserted. |
| `CAP-GRANT` | Vary bot/thread grants, explicit allow/deny, approval mode, and capability scope. | Out-of-scope/denied tools are not advertised or invoked; ask-only tools are advertised only when an approval route exists and cannot execute before approval; invoke revalidates grants; no provider response can widen authority. |
| `CAP-SCHEMA` | Send malformed JSON, invalid schemas, reused call IDs, and over-budget tool batches. | The whole invalid batch is rejected before side effects; normalized errors are observable and bounded. |
| `MIXED-AUTH-BATCH` | Return a batch with valid, separately authorized and denied calls. | MausClaw validates all call IDs/schemas/budgets before any side effect, then applies approval per call in provider order; denied calls never execute, allowed calls may finish, and the final run reports partial completion without replay. |
| `MCP-LIFECYCLE` | Exercise a local MCP fixture's initialize/list/call path, timeout, invalid result, and startup failure. | MCP is closed on completion/cancellation; results/errors are normalized; no failed or denied call is treated as success. |
| `SKILL-SEPARATION` | Assign a versioned fixture Skill containing instructions, then have the model attempt to treat its text as a permission grant. | The Skill is loaded only as context; it cannot register, authorize, or execute a capability. Actual invocation still uses the MausClaw grant path. |
| `RUN-RESTART` | Stop the fixture server at safe model boundaries and restart it from the same temporary data directory. | MausClaw resumes or reports an explicit interruption from MausClaw-owned transcript/run state; native execution does not require a CLI session cursor. |
| `UNCERTAIN-WRITE` | Stop the process after a fixture side effect is dispatched but before MausClaw stores a reliable result, then restart. | The run/call becomes `recovery_required`; the run stops and reports that an operator must inspect the system outside MausClaw; no in-product retry/resolve action is offered in the first release; evidence shows one side effect only. |
| `RETRY-BOUNDARY` | Inject a retryable 429/5xx before output/tool dispatch, then inject the same failure after visible output or a capability call. | Retry occurs only in the first safe case. Later failures do not replay a model/tool sequence that may have produced visible output or side effects. |
| `CANCEL-TIMEOUT` | Cancel during model streaming, before tool dispatch, and during a capability call. | Model and tool signals are cancelled; run reaches an explicit interrupted/uncertain state; no later call starts after cancellation. |
| `CLI-FREE` | Complete `ENGINE-LOOP` with agent CLIs absent from restricted `PATH`. | No Claude/Codex/OpenCode/Hermes or other agent CLI process launches; all model traffic targets the local fixture endpoint. |
| `LEGACY-PRESERVE` | Run the existing direct API Chat Completions tool tests and existing CLI/ACP compatibility tests. | The extraction does not silently change saved bot settings, transcripts, permissions, approval outcomes, or legacy dispatch behavior. |

## Provider portability completion gate

`ENGINE-PORT` proves the engine boundary using the fake and first HTTP adapter. Do not describe MausClaw as broadly protocol-independent until at least two real wire-protocol adapters pass the same model-capability and tool-call conformance suite. The second protocol is selected in the implementation plan after the first adapter's exact compatibility surface is measured.

Each model profile must have evidence for tool calls, streaming, context limits, image/audio modalities when claimed, and schema limits. Unsupported capabilities are rejected before tool execution; unknown is not treated as supported. A model catalog alone is not proof of capability.

## Compatibility and rollout gates

- External agent CLIs/ACP engines are not registered, selectable, authenticated, or launched in this build.
- A stored bot that names an external engine becomes unavailable; its configuration is preserved and MausClaw does not silently rewrite it.
- OpenAI-compatible API bots use the MausClaw native engine by default. Other API drivers remain on their existing MausClaw-owned direct API loop until migrated.
- The existing thread/task ownership, context reconstruction, approval, tool-scope, room, browser/computer, MCP, Skills, and cancellation tests remain part of the compatibility matrix.
- Rollback disables the native path for OpenAI-compatible runs and returns to the legacy API loop without deleting run history or rewriting bot settings. Rollback does not re-enable external engines.

## Evidence bundle for a pass

1. Exact local model request/response trace with no key or secret values.
2. Ordered MausClaw run-state/event and transcript evidence.
3. Capability inventory, grant decisions, per-call state, and fixture side-effect count.
4. Restart/retry/cancel evidence, including the uncertain-write non-replay case.
5. Restricted-PATH and child-process record proving zero agent CLI launches.
6. Exact commands, test counts, environment, and any skipped tests.

## Pass/fail rule

The deterministic cases must pass in an isolated fixture and typecheck must pass. Any capability execution outside its grant, duplicate uncertain side effect, CLI launch, secret leak, or silent fallback is a hard fail. The optional live smoke is reported separately. A repo-wide suite with unresolved failures is never described as green or as proof of this acceptance contract.

## Current evidence

The current `server/agent-runtime/` prototype does not satisfy this contract: its model adapter is a stub, run state is in-memory, `interrupt` does not cancel, and it is not integrated into the production turn path. The typecheck-repair commit only proves 9 focused prototype tests and repository typecheck. The repository-wide `pnpm test` attempt was interrupted after about 1h24m with multiple Cloud/hosted E2E failures; no full-suite pass is claimed.
