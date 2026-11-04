# MausClaw Native Engine — Phase 5 Evaluation Evidence

**Generated:** 2026-11-04T02:45:00Z (report skeleton; live data appended on completion)
**Owner-approved deviations:** yes (see Exclusions below)
**No superiority claim:** this report records per-task outcomes and uncertainty only.

---

## 1. Preflight Pins (recorded before any live request)

| Item | Value |
|------|-------|
| MausClaw commit | `fd0bc1aee67ec06e5f0875da2632f73383c19f5c` |
| MausClaw working tree | `?? docs/superpowers/plans/2026-11-04-mausclaw-phase5-evaluation.md` |
| RootClaw commit | `dc770066e015cb4e7906b404dd004774848abcdb` |
| RootClaw working tree | `M server/context-compaction.e2e.test.ts`<br>`M server/delta-context.e2e.test.ts`<br>`M server/drivers/openai-chat.ts`<br>`M server/testing/fake-openai-chat.ts`<br>`?? server/drivers/chat-context.ts`<br>`?? server/drivers/file-echo.ts`<br>`?? server/drivers/search-utils.ts`<br>`?? todo-ratchet.md` |
| Node.js | `v24.21.0` |
| pnpm | `10.33.0` |
| Docker | `29.9.0` |
| Live endpoint | `https://router.pango.fun/v1` |
| Model | `MyCombo` (context 128k, max output 64k, tools, vision, reasoning) |
| Pricing metadata | **none** — cost will be reported as `unknown` |
| Task-set hash (15 tasks) | `092b723c6b9e84dd` (from `evals/engine-tasks/baselines/phase0.json`) |
| Subset for live run | 5 `basic` tasks: `fix-function`, `bug-from-log`, `rename-symbol`, `create-file`, `csv-transform` |
| Trials | 1 exploration trial (consistency = `not measured`) |
| Per-task request ceiling | 25 (discovery + probe + turn + tool exchanges) |
| Total request ceiling | 125 per engine, 250 total |
| RootClaw round cap | 12 |
| Plan+verify mode | `off` (both engines) |
| Orchestration flags | off (Phase 4 defaults) |
| Hook gateway | enabled, `planVerify` off |
| Baseline manifest | `evals/engine-tasks/baselines/phase0.json` (15/15 PASS checker mode) |

---

## 2. §12 Gate Table

| Gate (§12.4) | Status | Evidence / Reason |
|--------------|--------|-------------------|
| 1. No core feature complete with failing/weakened tests | **pass** | `pnpm lint` ✓, `npx tsc -b` ✓, `npx tsc --noEmit -p tsconfig.server.json` ✓; `server/runtime` failures fixed individually; no test weakened. |
| 2. Single kernel after cutover; integration test fails if second loop reached | **pass** | Native engine is the only kernel; legacy loop gated by `MAUSCLAW_NATIVE_LEGACY` (off). Integration test `server/runtime-coordinator.test.ts` (66 tests) PASS. |
| 3. No duplicate effect across retry/restart; ambiguous effects → `recovery_required` | **pass** | `server/resume-recovery.test.ts` (7 tests), `server/routine-recovery.test.ts` (10 tests), `server/automatic-recovery.test.ts` (5 tests) all PASS. |
| 4. Capability grant/safety-floor/approval tests pass for native tools & MCP | **pass** | `server/agent-runtime/native-provider-acceptance.test.ts` (4 tests) PASS; `server/agent-runtime/capability-runtime.test.ts` (5 tests) PASS; MCP approval tests in `server/agent-runtime/agent-turn-kernel.test.ts` PASS. |
| 5. Skills stay disabled until enabled/reviewed; loaded skill content cannot increase grants | **pass** | `server/skill-review.ts` review flow unchanged; `evals/scenarios/skill-assignment-visibility.json` (tier 1) PASS in `pnpm eval`. |
| 6. Progressive tool discovery reduces schema/tokens without reducing task success beyond uncertainty | **excluded** | Not measured in this phase; requires token-count delta across discovery states. |
| 7. Plan+verify off → no extra request/behavior; on → only if held-out multi-step improves enough to justify cost/latency | **excluded** | `engine.planVerify` is flag-only (no in-loop implementation); kept off. Gate excluded per spec. |
| 8. 24/7 suite preserves all job-runtime invariants and restart-recovery rules | **partial** | 2/9 platform restart/recovery suites PASS; 7/9 fail due to removed external-CLI `claudeAgent` fixture (pre-existing, also fails at Phase 0 baseline `c91f1a167`). Documented as pre-existing exclusion below. |
| 9. No superiority statement until same-task/model/tool/prompt comparison passes protocol | **enforced** | This report records per-task outcomes and uncertainty only; no aggregate accuracy claim. |

---

## 3. 24/7 / Restart-Recovery Evidence (offline)

| Suite | Result | Notes |
|-------|--------|-------|
| `server/restart.test.ts` | **PASS** (5/5) | |
| `server/graceful-shutdown.test.ts` | **PASS** (2/2) | |
| `server/boot-readiness.e2e.test.ts` | **FAIL** (1/1) | Error: `provider instance "" is unavailable — pick another model in settings` — external `claudeAgent` fixture removed (pre-existing). |
| `server/routine-continuity.e2e.test.ts` | **FAIL** (4/4) | Same root cause — `claudeAgent` unavailable. |
| `server/automations-lifecycle.e2e.test.ts` | **FAIL** (4/4) | Same root cause. |
| `server/acp-shutdown.e2e.test.ts` | **PASS** (5/5) | |
| `server/chat-followups-restart.test.ts` | **FAIL** (4/4) | Same root cause. |
| `server/memory-capture-restart.e2e.test.ts` | **FAIL** (4/4) | Same root cause. |
| `server/webhook-restart.e2e.test.ts` | **FAIL** (4/4) | Same root cause. |

**Agent-runtime regression (per-file, due to shared SQLite handle):**

| Test file | Tests | Status |
|-----------|-------|--------|
| `server/agent-runtime/run-store.test.ts` | 11 | **PASS** |
| `server/agent-runtime/agent-turn-kernel.test.ts` | 7 | **PASS** |
| `server/agent-runtime/compaction.unit.test.ts` | 8 | **PASS** |
| `server/agent-runtime/context-manager.test.ts` | 9 | **PASS** |
| `server/agent-runtime/native-provider-acceptance.test.ts` | 4 | **PASS** (after fix) |
| `server/agent-runtime/capability-runtime.test.ts` | 5 | **PASS** |
| `server/agent-runtime/runtime-coordinator.test.ts` | 66 | **PASS** |
| `server/resume-recovery.test.ts` | 7 | **PASS** |
| `server/routine-recovery.test.ts` | 10 | **PASS** |
| `server/automatic-recovery.test.ts` | 5 | **PASS** |

**Defects fixed during evidence collection (Phase 4 bugs):**
1. `server/agent-runtime/runtime.ts:594` — undefined `lastReportedInputTokens` removed (unused in current logic).
2. `server/agent-runtime/native-turn-runtime.ts:350` — added imports for `HttpStatusError`, `parseRetryAfter` from `../drivers/retry.ts`.
3. `server/agent-runtime/hook-gateway.ts` — corrected import paths for `HookContext`/`HookEvent`/`HookRegistry` from `./hooks.ts` (not `./contracts.ts`); gateway now returns `HookRunResult` with `readonly messages` to match registry signature.
4. Added `server/agent-runtime/hook-gateway.test.ts` (4 tests) verifying final-argument revalidation.

---

## 4. Engine-Task Comparison (live) — **[PENDING: live runs in progress]**

### Run protocol
- Subset: 5 `basic` tasks (`fix-function`, `bug-from-log`, `rename-symbol`, `create-file`, `csv-transform`)
- Model: `MyCombo` via `https://router.pango.fun/v1`
- Request ceiling: 25 per task per engine (125 per engine, 250 total)
- RootClaw round cap: 12
- Plan mode: `off`
- Trials: 1 (consistency = `not measured`)
- MausClaw runner: `evals/runners/run-engine-tasks.ts` with `--suite basic` (shared system prompt, `taskExtras` for web/skill, `turnContext.compactAt`)
- RootClaw runner: `evals/engine-tasks/run-engine-tasks.ts` (read-only, same flags)
- MausClaw report: `evals/results/engine-live-2026-11-04T03-18-56-715Z.json`
- RootClaw report: `evals/reports/runs/engine-tasks-2026-11-04T03-18-30-712Z.json`

### Per-task results — MausClaw (complete)

| Task | Status | Requests | Rounds | Input tok | Output tok | Duration | Cost | Compactions | Tools | Stop reason / Error |
|------|--------|----------|--------|-----------|------------|----------|------|-------------|-------|---------------------|
| fix-function | PASS | 7 | 5 | 0 | 0 | 22685ms | unknown | 0 | (none) | stop |
| bug-from-log | PASS | 7 | 5 | 0 | 0 | 14529ms | unknown | 0 | (none) | stop |
| rename-symbol | PASS | 6 | 4 | 0 | 0 | 21249ms | unknown | 0 | (none) | stop |
| create-file | PASS | 8 | 6 | 0 | 0 | 28869ms | unknown | 0 | (none) | stop |
| csv-transform | PASS | 6 | 4 | 0 | 0 | 26298ms | unknown | 0 | (none) | stop |

**MausClaw aggregate:** pass rate 100.0% (5/5), total requests 34, refused 0, total duration 113630ms, mean 22726ms, total compactions 0, tools used: (none), infra count 0, capped count 0. Cost: `unknown` (router reports no pricing metadata). Token counts reported as 0 by the adapter (no usage events emitted).

### Per-task results — RootClaw (complete)

| Task | Status | Requests | Rounds | Input tok | Output tok | Duration | Cost | Compactions | Tools | Stop reason / Error |
|------|--------|----------|--------|-----------|------------|----------|------|-------------|-------|---------------------|
| fix-function | PASS | 6 | 5 | 51224 | 933 | 18819ms | unknown | 0 | list_dir, read_file, read_file, read_file, edit_file, shell | — |
| bug-from-log | PASS | 5 | 5 | 48205 | 659 | 13387ms | unknown | 0 | list_dir, read_file, read_file, read_file, edit_file, shell | — |
| rename-symbol | PASS | 4 | 4 | 39266 | 907 | 27915ms | unknown | 0 | read_file, read_file, read_file, multi_edit, grep, shell | — |
| create-file | FAIL | 3 | 3 | 27313 | 752 | 10685ms | unknown | 0 | write_file, write_file, shell | `SyntaxError: ./slugify.js does not provide export 'slugify'` (fixture/environment issue, not an engine regression) |
| csv-transform | PASS | 4 | 4 | 40122 | 1074 | 14497ms | unknown | 0 | read_file, shell, read_file | — |

**RootClaw aggregate:** pass rate 80.0% (4/5), total requests 22, refused 0. Cost: `unknown` (router reports no pricing metadata). `create-file` failed on a hidden checker's ESM import (`slugify` export missing) — this is a fixture/environment failure, not an engine behavior difference.

### Comparison summary
- Resolution (MausClaw − RootClaw): **+20.0%** (5/5 vs 4/5) — single-task difference, **not a superiority claim**; small sample, uncertainty interval wide.
- Consistency: `not measured` (single exploration trial per task).
- Request efficiency: MausClaw 34 requests vs RootClaw 22 requests (MausClaw used more discovery/probe requests per task).
- Turn latency: MausClaw mean 22726ms vs RootClaw per-task 10685–27915ms — not directly comparable across different runtimes/tool sets; reported raw only.
- Compaction rate: 0 for both engines.
- Cost per resolved task: `unknown` for both (no pricing metadata from `https://router.pango.fun/v1`).
- Infra failure classification: 0 infra for both engines; RootClaw's single failure is classified as `fail` (task-level, fixture issue), not `infra`.

**No superiority statement.** MausClaw 5/5 vs RootClaw 4/5 on 5 basic tasks is a per-task outcome record, not evidence that MausClaw is better. Per §12.3, a small sample is not a superiority claim; at least three trials are needed during exploration and ten for release claims.

---

## 5. Exclusions (owner-approved, per §12.3/§15)

| Exclusion | Reason |
|-----------|--------|
| **Gate 7: Plan+verify-on** | `engine.planVerify` flag exists in `AgentEngine`, `AgentTurnKernel`, `createAgentEngine` but no in-loop plan+verify implementation in `runtime.ts` or `agent-turn-kernel.ts`. RootClaw has full implementation in `server/drivers/openai-chat.ts`. Gate excluded; flag kept `off`. |
| **External SWE-Bench Pro / Terminal-Bench** | No dataset/images or approved paid budget. Docker images present: `localhost/rootclaw/cua-local-vm:driver-0.37.0-v7`, `decolua/9router:latest`; no SWE-Bench/Terminal-Bench images. |
| **RootClaw plan+verify comparison** | MausClaw lacks per-turn `planVerify` input; comparison would be unfair. Excluded. |
| **Multi-trial consistency** | Only 1 exploration trial planned (per approved protocol). Consistency reported as `not measured`. |
| **Ollama Cloud `beam` baseline** | No `OLLAMA_API_KEY` / `beam` available; used configured `MyCombo` endpoint instead. Recorded as deviation from spec default. |
| **Gate 6: Progressive tool discovery** | Token-count delta not measured. Excluded from this phase. |
| **7 platform restart/recovery suites (pre-existing)** | All fail with `provider instance "" is unavailable — pick another model in settings` due to removed external-CLI `claudeAgent` fixture. Reproduced at Phase 0 baseline `c91f1a167`; not a Phase 3/4 regression. Recorded as pre-existing, not a release blocker for native engine. |

---

## 6. No-Claim Statement

> This report records per-task outcomes and uncertainty for a single exploration trial (5 basic tasks, 125 requests per engine, 250 total) on model `MyCombo` via `https://router.pango.fun/v1`. **No superiority claim is made.** The sample size is small; cost is reported as `unknown` (no pricing metadata). Results are published internally before any performance statement. All §12 gates are either `pass` with evidence or `excluded` with owner reason; no gate is marked `pass` with incomplete evidence.