# MausClaw Native-Only Runtime Production Enablement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the MausClaw Agent Runtime the default loop for OpenAI-compatible API bots while disabling external agent engines in this build.

**Architecture:** External CLI/ACP drivers remain in the tree but are removed from the provider registry and never launched. API model providers remain supported. `OpenAICompatDriver` builds the native engine and uses it for every turn; `server/index.ts` marks every OpenAI-compatible turn with `agentEngine:"mausclaw-native"`. Other API drivers keep their existing MausClaw-owned direct API loop until migrated.

**Spec:**
- `docs/superpowers/specs/2026-10-26-mausclaw-native-agent-platform-design.md`
- `docs/superpowers/specs/2026-10-26-mausclaw-cli-free-acceptance-contract.md`

## Global Constraints

- No external agent engine may be registered, selectable, or launched in this build.
- Default behavior for API-model bots stays available; OpenAI-compatible bots use the native loop.
- Image input remains rejected and image tool results fail closed.
- No live API smoke, canary, push, or deployment without separate approval.
- Full repository suite remains not green; use focused suites, lint, and typecheck.

## Review Focus

- Stored bots pointing at an external engine must become unavailable, not silently launch a CLI.
- The registry must not expose external engines through `/api/instances` or onboarding.
- An OpenAI-compatible turn must use the native engine and persist an `agent_runs` row.
- A non-OpenAI-compatible API driver must remain on its existing MausClaw-owned loop.

---

### Task 1: Engine support policy

**Files:**
- Create: `server/agent-runtime/engine-support.ts`
- Create: `server/agent-runtime/engine-support.test.ts`

**Interfaces:**
- `isExternalAgentEngine(driverKind: string): boolean`
- `supportedAgentDrivers<T extends { readonly driverKind: string }>(drivers: readonly T[]): readonly T[]`

- [x] Test external CLI/ACP kinds as unsupported and API providers as supported.
- [x] Confirm RED, implement, confirm GREEN.

### Task 2: Registry and per-turn selection

**Files:**
- Modify: `server/index.ts`
- Modify: `server/contracts.ts`
- Modify: `server/drivers/openai-chat.ts`
- Modify: `server/drivers/openai-compat.ts`
- Modify: `server/agent-runtime/model-adapter.ts`
- Test: `server/agent-runtime/driver-opt-in.test.ts`

- [x] Filter `BUILT_IN_DRIVERS` through `supportedAgentDrivers` at registry construction.
- [x] Add `SendTurnInput.agentEngine?: "mausclaw-native"`.
- [x] Mark direct and room OpenAI-compatible turns with `agentEngine:"mausclaw-native"`.
- [x] Build the native engine inside `OpenAICompatDriver` and use it only when the turn carries the flag.
- [x] Add an integration test with a real OpenAI-compatible HTTP fixture and a real MCP tool, asserting native execution and legacy fallback.

### Task 3: Verification

- [x] Run `pnpm vitest run server/agent-runtime/ server/drivers/openai-chat-tools.test.ts server/drivers/openai-chat.test.ts server/drivers/openai-chat-protocol.test.ts server/drivers/chat-tool-approval.test.ts` → 12 files / 230 tests passed.
- [x] Run `pnpm typecheck` and `pnpm lint` → passed.
- [x] Run the full isolated server fixture `server/native-only.e2e.test.ts` → 1/1 passed: real loopback provider, real MCP tool, real approval card, settled turn, artifact written, `agent_runs` completed with 2 rounds/1 call, and `claude` not available.
- [x] Commit locally.
- [x] Report full-suite status as not green; push only with approval.

### Task 4: Upstream catch-up and native completion

- [x] Merge upstream `origin/main` at `83f4b19bf` (143 commits) into the native branch; resolve the `openai-chat.ts` turn-entry conflict by keeping both `native` and `ending`.
- [x] Add `nudgeAnnouncedAction` parity to the native loop, sharing `announcesAction` through `server/agent-runtime/announcement.ts`.
- [x] Add native steering: `AgentEngine.steer(runId, text)` queues a user correction for the next model round, never mid-tool-batch, and refuses only after the run stops taking rounds. The driver forwards `steer(threadId)` to the live run and queues text that arrives before the run id exists.
- [x] Add the optional-tool downgrade: a provider that rejects the whole `tools` parameter (400/422) gets one retry without tools when every offered tool is optional (the built-in question tool). Turns with a required tool fail closed.
- [x] Add request-size recovery: the adapter reports `request_too_large` with the encoded size; the runtime retries twice with a reduced history (older messages omitted, images replaced by text, tool outputs shortened), then fails with that code.
- [x] Add summarization compaction: near the context budget (or on overflow) the engine asks the same adapter to summarize older history, keeps ~20k recent tokens and all system messages, never starts the kept slice with an orphan tool result, records each compaction in `agent_compactions`, and emits `run.compacted`. A failed summary leaves the original history for the shrink fallback.
- [x] Add budget caps: `SendTurnInput.budget` / `AgentRunRequest.budget` (`maxTokens`, `maxCostUsd`, `maxWallTimeMs`); the run throws `budget_exhausted` when exceeded, with wall-time checked at the top of each round and token/cost checked after each usage report.
- [x] Make every API driver native: `openai-compat`, `grok`, `groq`, `meta`, `minimax`, `mistral`, `cerebras`; `server/drivers/native-engine.ts` builds their adapter/engine, and `server/index.ts` marks their turns with `agentEngine:"mausclaw-native"`.
- [x] Add multimodal input: neutral `ModelContentPart` (`text`/`image`), user image parts, and tool-result images returned to vision models. Text-only models still refuse tool images.
- [x] Rewrite `server/openai-tools.e2e.test.ts` request scoping so a chief incident turn on the same loopback provider cannot change a scenario's counts; it passes for all three drivers.
- [x] Add `server/native-ui.e2e.test.ts`: the real renderer sends a turn to a loopback native provider, shows the reply, and `agent_runs` records one completed run.
- [x] Add `MAUSCLAW_UI_NATIVE_URL`/`MAUSCLAW_UI_NATIVE_KEY`/`MAUSCLAW_UI_NATIVE_MODEL` to the UI launcher so the fixture no longer depends on fake Claude.
- [x] Exclude `server/index.test.ts` from the native default suite: it drives the removed Claude/Codex CLI fixtures on every turn. Run it with `MAUSCLAW_LEGACY_ENGINE_TESTS=1` only in an engine-enabled checkout.

**Verification:** `server/agent-runtime` 8 files / 46 tests; driver suites 8 files / 143 tests; `native-only` + `openai-tools` 4 tests; `native-ui` 1 test; typecheck and lint pass.
