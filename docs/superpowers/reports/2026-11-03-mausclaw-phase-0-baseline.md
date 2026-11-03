# MausClaw Native Engine — Phase 0 Baseline

**Date:** 2026-11-03
**Base commit:** `13b2f274b94f29c1ebb3ff89593e2733c0dd1e8e`
**Branch / worktree:** `phase0-mausclaw-engine` at `/tmp/opencode/mausclaw-phase0-worktree`
**Scope:** Phase 0 only. No live/paid model run, benchmark run, or plugin expansion is included.

The base commit is the merge point. The worktree contains the Phase 0 repairs described below; those changes were uncommitted when this baseline was captured.

## Environment

| Item | Value |
|---|---|
| Node.js | `v24.21.0` |
| pnpm | `10.33.0` |
| Docker | `29.9.0`, build `f415da8` (inspection only, no container run) |
| Test runner | Vitest `4.1.11` |
| Installed plugin directory | none (`plugins/` does not exist) |
| Paid model budget used | zero |

`git status --short` at capture time listed the Phase 0 plan/spec as untracked and the repaired test/source files as modified. No production deployment checkout was changed.

## Commands and current results

```bash
pnpm exec vitest run server/agent-runtime
pnpm exec vitest run server/runtime --reporter=verbose
pnpm eval
```

| Command | Result |
|---|---|
| `server/agent-runtime` | **36 files, 378 passed, 0 failed** |
| `server/runtime` | **11 files (8 passed, 3 skipped), 263 passed, 25 skipped, 0 failed (288 tests)** |
| `pnpm eval` | **1/1 resolved** (`native-text-reply`), status `settled`, 1 model round, 0 tool calls, 2 requests, 1055 ms |

The `server/runtime` filter also selects the three top-level runtime e2e files (`runtime-coordination`, `runtime-paths`, `runtime-roots`). All three are now skipped; see “Legacy e2e disposition”.

The fresh pre-repair run was:

```text
Test Files  9 failed | 2 passed (11)
Tests       38 failed | 266 passed | 1 skipped (305)
```

The drop from 305 to 288 tests is expected: `capabilities.test.ts` generates one test per engine row, and the 17 stale external-engine rows were removed.

## Pre-repair failure matrix

### Unit failures (14)

These were repaired because the runtime contract still advertised engines that are no longer registered.

| File | Test | Quoted failure | Classification |
|---|---|---|---|
| `server/runtime/capabilities.test.ts` | `engineCapabilities > has a row for every registered driver, and no row without a driver` | expected engine set to match `BUILT_IN_DRIVERS` | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > claudeAgent` | expected row for removed external driver | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > qwenAgent` | expected row for removed external driver | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > codex` | expected row for removed external driver | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > cursorAgent` | expected row for removed external driver | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > antigravityAgent` | expected row for removed external driver | stale capability row |
| `server/runtime/capabilities.test.ts` | `engineCapabilities > geminiAgent` | expected row for removed external driver | stale capability row |
| `server/runtime/level.test.ts` | `assignmentLevel > is max(own, inherited) in the order ask < edits < auto < full` | `expected 'ask' to be 'edits'` / `levelSource: 'engine_cap'` | stale external-driver fixture |
| `server/runtime/level.test.ts` | `assignmentLevel > engine cap > steps an inherited level down to the highest one the engine runs` | `expected 'ask' to be 'auto'` | stale external-driver fixture |
| `server/runtime/level.test.ts` | `assignmentLevel > engine cap > says engine_cap whenever the cap lowered the inherited level, down to own included` | `expected 'ask' to be 'edits'` | stale external-driver fixture |
| `server/runtime/envelope.test.ts` | `escapeEnvelope > turns an imitation of the opening marker into a parenthesis, in any bracket form or case` | old-brand Cyrillic lookalike `ОМВ` no longer matched the current marker | stale brand fixture |
| `server/runtime/runtime.test.ts` | `Runtime: one tree, one lane > runs a child, reports it once, then wakes the root with the settled children in one resume turn` | expected `level: 'auto'`, received `level: 'ask'`, `levelSource: 'engine_cap'` | stale external-driver fixture |
| `server/runtime/scenarios.test.ts` | `§3 one level rule > S25 a Chief at full with a person origin lifts the child to full on every engine; outside lineage inherits nothing` | expected `level: 'edits'`, received `level: 'ask'`, `levelSource: 'engine_cap'` | stale external-driver fixture |
| `server/runtime-coordinator.test.ts` | `RuntimeCoordinator: the requesting turn and its tree > hands the host the requester's node, whose parents lead up the chain, and records the Chief level it passes on` | expected `level: 'auto'`, received `level: 'ask'`, `levelSource: 'engine_cap'` | stale external-driver fixture |

### Legacy e2e failures (24)

All 24 are in three files that launch the verification server with `scripted: true`:

- `server/runtime-coordination.e2e.test.ts` — 5 tests
- `server/runtime-paths.e2e.test.ts` — 5 tests
- `server/runtime-roots.e2e.test.ts` — 14 tests

The fixture writes `FAKE_CLAUDE_ROOM_PLAN` and relies on the removed external Claude CLI engine (`scripts/control-mausclaw.ts:317`). Without that engine the bots have no native model selection, so the server rejects the first turn. The common error is:

```text
{"error":"provider instance \"\" is unavailable — pick another model in settings"}: expected 409 to be less than 300
```

`T6` instead ran 64 model rounds of `agents_list_bots` and failed as `provider_error`, because the old room-plan script does not match the native loop:

```text
root failed (provider_error): Stopped after 64 model rounds. Before it stopped it made 64 tool calls: agents_list_bots ×64.
```

Exact failing test names:

**`server/runtime-coordination.e2e.test.ts`**

- `S1 assigns a teammate under the envelope and resumes the Chief once with the report`
- `S2 parks a teammate on NEEDS INPUT, passes her question to the Chief once, carries the person's answer into her next turn, and resumes the Chief with the result`
- `S2b resumes the Chief once with a parked question, keeps one question chip across a restart and names the parked thread as waiting on the person`
- `S3 runs a cut teammate turn again once after a restart and resumes the Chief with the report`
- `S4 cancels queued work and the Chief's record when the person stops the conversation, and resumes nothing`

**`server/runtime-paths.e2e.test.ts`**

- `R1 a routine run coordinates a teammate, waits, and completes through a routine resume turn`
- `R3 a consultation reaches a teammate without waiting and resumes the asker with the answer`
- `R4 a one-way notice opens a notify child in a new thread and never resumes the sender`
- `R5 an external runtime delegates, long-polls assignment_status for the settled child, and is never woken`
- `R6 a restart while a routine's teammate runs reruns the teammate once and the run still completes`

**`server/runtime-roots.e2e.test.ts`**

- `T1 records a person's turn as a root that runs and completes`
- `T2 parks the root on a credential card and runs it again with the provided line`
- `T3 parks the root on connector cards and runs it again once when both connect`
- `T5 reruns a person's cut turn once after a restart, with the restart note first and the resuming chip`
- `T6 continues a person's step-capped turn in place on the same root`
- `T8 Stop while parked on a credential card cancels the root and stops the card; a key provided afterwards is saved but starts nothing`
- `T8 Stop while parked on connector cards cancels the root and stops the cards; connecting afterwards is kept but starts nothing`
- `T8 Stop while parked on a sign-in card cancels the root and stops the card; Cancel afterwards is saved but starts nothing`
- `T9 parks the root on a sign-in card and runs it again with the signed-in line on Done`
- `T10 parks a teammate's turn on its credential card, tells the Chief at once, and the key answers the teammate`
- `T11 does not rerun a cut turn that already pushed: the root ends with what it did, said once`
- `T12 a turn the watchdog stops after it posted a credential card fails as stalled and stops the card`
- `T12 a turn the watchdog stops after it posted connector cards fails as stalled and stops the cards`
- `T12 a turn the watchdog stops after it posted a sign-in card fails as stalled and stops the card`

`T7 queues a root on the computer seat at the wait ceiling and continues it when the seat frees` was already platform-skipped (`itHost`, Linux) and is not counted among the 24.

## Legacy e2e disposition

On 2026-11-03 the owner approved excluding the 24 legacy external-engine tests for Phase 0, with the requirement that they be documented and ported later. The three files now use `legacyIt = it.skip` for those 24 tests and carry this pointer:

```text
// Skipped until the external-Claude fixture is ported to the native loopback provider; see docs/superpowers/reports/2026-11-03-mausclaw-phase-0-baseline.md.
```

They are not product assertions removed from the test suite; they are fixtures that cannot construct a native turn. Phase 1 should port them to the native loopback provider used by `server/native-only.e2e.test.ts` and re-enable them. `T7` keeps its existing platform gate.

## Product call-path map

Only native API drivers are registered in `server/drivers/builtIn.ts`:

`openai-compat`, `anthropic`, `gemini`, `grok`, `openai-responses`, `groq`, `meta`, `minimax`, `mistral`, `cerebras`.

`server/agent-runtime/engine-support.ts` returns `true` for exactly those ten driver kinds and marks them `mausclaw-native`.

The direct-turn path in `server/index.ts:8612` and the room-turn path in `server/index.ts:10557` both attach:

```ts
...(usesNativeAgentEngine(instance.driverKind) ? { agentEngine: "mausclaw-native" as const } : {})
```

`server/agent-runtime/native-turn-runtime.ts` then chooses:

- `:593` — when `nativeAgentEngine` is present and `agentEngine === "mausclaw-native"`, it runs `runNativeTurn`.
- `:632` — otherwise it runs the older chat-completions loop in the same file.

Every registered product driver takes the native branch, so the legacy branch is unreachable from the current provider fleet. The removed CLI/ACP drivers are the only callers the legacy branch was built around; they are not registered.

Acceptance evidence for the native path:

- `server/agent-runtime/native-provider-acceptance.test.ts` forces `PATH=/nonexistent-native-agent-path`, completes two tool rounds through `createOpenAIChatRuntime`, and asserts `modelRounds: 3`, `toolCalls: 2`.
- `server/native-only.e2e.test.ts` launches a real isolated server, runs an OpenAI-compatible bot through the native loop, approval, and an injected MCP tool, and passes.

## Offline platform-eval baseline

`pnpm eval` uses a loopback OpenAI-compatible provider and the isolated verification server. No external CLI or real provider is involved.

Pre-repair progression:

1. `model instance not found: openaiCompat` — the verification fixture only declared the removed `claude` instance, so the OpenAI-compatible instance was absent.
2. After adding `openaiCompat` to `scripts/control-mausclaw.ts`, the eval reached the provider but the turn failed with `unsupported_capability`: the fake provider answered the live tools probe (`Use the noop tool.`) with plain text, so the model was marked as not supporting structured tool calls.
3. The eval fixture now answers the `noop` probe with a `tool_calls` delta and otherwise returns the task reply, matching `server/native-only.e2e.test.ts`.

Final report: `evals/results/2026-11-03T13-08-38-336Z.json`

```json
{
  "id": "native-text-reply",
  "resolved": true,
  "status": "settled",
  "modelRounds": 1,
  "toolCalls": 0,
  "wallTimeMs": 1055,
  "requestCount": 2,
  "compactions": 0,
  "recoveryRequired": false
}
```

The task budget is `maxTokens: 100000`, `maxWallTimeMs: 60000`; the provider is a synthetic loopback and the run cost is zero. No live model score was produced, so live model scores remain **not run**.

## Native engine-task eval (`pnpm eval:engine`)

The new offline engine-task suite (15 tasks: 5 `basic`, 10 `hard`) runs in checker mode by default — zero provider requests, no LiveInstance constructed, fresh temp workspace per task, cleanup in `finally`.

    pnpm eval:engine   # mode: checkers | liveStatus: not-run | 15/15 pass | requests sent: 0

Result (`evals/results/engine-checkers-<timestamp>.json`, gitignored):

| Suite | Total | Pass | Fail | Infra | Capped | Requests |
|---|---|---|---|---|---|---|
| basic | 5 | 5 | 0 | 0 | 0 | 0 |
| hard | 10 | 10 | 0 | 0 | 0 | 0 |
| **all** | **15** | **15** | **0** | **0** | **0** | **0** |

Commit `13b2f274b94f29c1ebb3ff89593e2733c0dd1e8e`, task-set hash `092b723c6b9e84dd`. Committed baseline manifest:
`evals/engine-tasks/baselines/phase0.json` (no secrets, no live model output).

Live mode is opt-in (`MAUSCLAW_EVAL_LIVE_INSTANCE` or `MAUSCLAW_EVAL_LIVE_CONFIG`) and remains blocked pending separate owner approval; the runner refuses before any HTTP request when neither is set.

## Legacy loop disposition (Phase 0 recommendation)

Product routes are already native: every registered driver in `server/drivers/builtIn.ts` is marked `mausclaw-native`, and both turn paths in `server/index.ts` attach `agentEngine: "mausclaw-native"` for them. The legacy chat-completions loop in `native-turn-runtime.ts:632` is unreachable from the current provider fleet — the removed CLI/ACP drivers were its only callers, and none are registered.

Recommendation: do not remove legacy code in Phase 0. Keep the legacy branch present but unreachable, and plan a Phase 1 parity/removal gate: port the 24 skipped legacy e2e tests to the native loopback fixture (re-enable them), then retire or gate the legacy chat loop once parity is proven on identical tasks/model/tool set/grants/system prompt.

## Repairs applied in this baseline

- `server/runtime/capabilities.ts` — removed the 17 stale external-engine rows; the table now matches the ten registered native API drivers. Unknown driver IDs still fall back conservatively.
- `server/runtime/capabilities.test.ts` — expected table reduced to the registered drivers.
- `server/runtime/level.test.ts` — native `openai-compat`/`gemini` fixtures; unsupported inherited levels now expect `ask`/`engine_cap`.
- `server/runtime/runtime.test.ts` — child fixture uses `openai-compat`; full/chief expectations.
- `server/runtime/scenarios.test.ts` — S25 migrated to native engines; unsupported level caps to `ask`/`engine_cap`.
- `server/runtime-coordinator.test.ts` — `openai-compat`; full/chief expectation.
- `server/runtime/envelope.test.ts` — current-brand Cyrillic lookalike `МausClaw` replaces the old `ОМВ` fixture.
- `server/peer-provenance.ts` — deduplicated `HEADER_WORDS` to `new Set(["mausclaw"])`.
- `scripts/control-mausclaw.ts` — verification fixture now declares `openaiCompat: { driver: "openai-compat" }`.
- `evals/runners/run-evals.ts` — fake provider answers the `noop` capability probe with a structured tool call.
- `server/runtime-coordination.e2e.test.ts`, `server/runtime-paths.e2e.test.ts`, `server/runtime-roots.e2e.test.ts` — 24 legacy tests skipped with owner approval and the report pointer above.

No approval, safety-floor, recovery, task-checker, or tool-scope assertion was weakened to make these tests pass.

## Plugin inventory

`server/agent-runtime/plugin-loader.ts` exists and can load manifests from configured search paths, but no `plugins/` directory is present and no plugin is registered in this baseline. Plugin expansion remains out of scope for the native engine v1; the existing Skills, MCP, native tools, and capability runtime are the supported extension surface.

## Open items

- Port the 24 skipped legacy e2e tests to the native loopback fixture and re-enable them.
- Run live/paid engine-task measurements only after explicit owner approval; the Phase 0 runner and baseline are offline by default.
- Retire or gate the legacy chat loop in `native-turn-runtime.ts:632` after Phase 0 parity work; it is currently unreachable from registered product drivers.
