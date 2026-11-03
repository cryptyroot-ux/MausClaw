# MausClaw Native Engine Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a reproducible Phase 0 baseline for the single-loop Native Engine design, repair/classify the current `server/runtime` failures without weakening safety tests, and port MausClaw-native engine tasks with a bounded, redacted runner.

**Architecture:** Phase 0 adds measurement, test hygiene, and an offline-checkable engine-task suite only. It does not port context/tool features or turn plan+verify/orchestration on. The task runner uses an isolated `MAUSCLAW_DATA_DIR`, the existing Native Engine/API adapter path, temporary per-task bot workspaces, and a live-run gate; a local checker mode requires no model call.

**Tech Stack:** TypeScript, Node.js >=24, pnpm 10.33.0, Vitest, existing MausClaw `ModelAdapter`/`AgentEngine` contracts, existing `evals/live` instance schema, native provider fixtures.

**Spec:** `docs/superpowers/specs/2026-11-03-mausclaw-native-engine-design.md` — Phase 0 only (§13).

## Global Constraints

- This plan implements Phase 0 only; no Phase 1–5 product features are authorized by it.
- Use the selected Opsi A direction: keep MausClaw contracts; do not copy RootClaw files wholesale or add an external runtime dependency.
- No paid-model or external-benchmark requests without explicit owner approval. `pnpm eval:engine` is offline by default; live mode requires a separate opt-in and configured instance.
- Never pass or persist provider secrets in CLI arguments, reports, snapshots, or failure logs; redact request/response bodies before writing traces.
- Use an isolated `MAUSCLAW_DATA_DIR` and temporary task workspace. Follow `docs/verification/README.md`; never verify against the user's live app or data.
- Before implementation, create an isolated worktree from the approved baseline using `using-git-worktrees`; do not edit the deployment checkout.
- Do not weaken approval, safety-floor, recovery, task-checker, or tool-scope assertions to get a green suite.
- Plugin work is out of scope. Inventory current plugin loading only; do not add plugin handlers, marketplace behavior, or a new plugin API.
- Preserve the 378 native agent-runtime tests; rerun current counts instead of treating the audit snapshot as fresh evidence.
- Follow `AGENTS.md`: comments only for external facts, public contracts, security invariants, or known risks; do not deploy or push.

## Review Focus

1. **A missing/invalid live-model configuration** — checker mode stays offline; live mode refuses before any HTTP request. Pin this in runner-gate tests.
2. **Provider outage versus task failure** — classify transport/rate-limit/credit failures as `infra`, not a failed task; pin in report/scorer tests.
3. **Task checker quality** — every known-good solution passes and every seeded broken state fails; protected files remain unchanged. Pin all 15 tasks in checker tests.
4. **Request-budget boundary** — the runner refuses the first request beyond its configured hard HTTP cap, including model discovery/probes; pin with a loopback server.
5. **Credential leakage or workspace escape** — reports redact configured secrets, every task gets a fresh temporary workspace, and cleanup runs on failure/cancel; pin in runner tests.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `docs/superpowers/reports/2026-11-03-mausclaw-phase-0-baseline.md` | Create | Human-readable pre-fix test/path/failure baseline with commit and environment facts. |
| `server/runtime/capabilities.ts` | Modify only if baseline confirms stale rows | Keep runtime capability rows aligned with registered MausClaw API drivers; preserve conservative behavior for unknown driver IDs. |
| `server/runtime/capabilities.test.ts` | Modify | Assert the registered native driver set, exact capability rows, and conservative unknown-driver behavior. |
| `server/runtime/level.ts` / `level.test.ts` | Modify only for confirmed migration drift | Keep permission-level calculation aligned with the supported native API drivers. |
| `server/runtime/envelope.ts` / `envelope.test.ts` | Modify only for confirmed copy/contract drift | Restore the current assignment envelope contract without changing consent/data-provenance rules. |
| `server/runtime/runtime.test.ts`, `scenarios.test.ts` | Modify only for failures named in the fresh failure matrix | Repair isolated provider/fixture setup and assertions; do not change unrelated job semantics. |
| `evals/engine-tasks/tasks.ts` | Create | The 15 immutable task specs, workspace seeds, known-good solutions, and deterministic checkers. |
| `evals/engine-tasks/tasks.test.ts` | Create | Task ID/count invariants and checker self-tests for every seed/solution/protected file. |
| `evals/engine-tasks/run-engine-tasks.ts` | Create | Isolated native-turn runner, checker-only mode, opt-in live mode, request cap, and cleanup. |
| `evals/engine-tasks/run-engine-tasks.test.ts` | Create | Runner gate, loopback request cap, isolation, infra classification, and cleanup/redaction tests. |
| `evals/engine-tasks/report.ts` | Create | Versioned report types, serialization, redaction, and Markdown summary. |
| `evals/engine-tasks/report.test.ts` | Create | Report schema, redaction, unknown usage/cost, and aggregate-count tests. |
| `evals/engine-tasks/README.md` | Create | Task suite usage, checker/live modes, report fields, and no-spend policy. |
| `evals/engine-tasks/baselines/phase0.json` | Create | Committed baseline manifest/result; contains no secret or unapproved paid-model output. |
| `evals/README.md` | Modify | Link the engine-task suite while preserving existing platform behavior-eval commands. |
| `package.json` | Modify | Add `eval:engine` script only. |

---

## Tasks

### Task 1: Capture the fresh Phase 0 baseline and failure matrix

**Files:**
- Create: `docs/superpowers/reports/2026-11-03-mausclaw-phase-0-baseline.md`
- Read only: `server/agent-runtime/`, `server/runtime/`, `server/index.ts`, `server/agent-runtime/native-turn-runtime.ts`, `server/agent-runtime/engine-support.ts`

**Interfaces:**
- Consumes: current commit and fresh command output.
- Produces: a report naming the commit, Node/pnpm versions, exact test command/counts, failure file/test IDs, product call paths through native vs legacy loops, model cost status, and plugin inventory status.

- [ ] **Step 1: Record repository state and toolchain**

Run:

```bash
git rev-parse HEAD
git status --short
node --version
pnpm --version
```

Expected: record the outputs in the baseline report; do not reset or clean existing files.

- [ ] **Step 2: Capture native engine and runtime test baselines**

Run:

```bash
pnpm exec vitest run server/agent-runtime
pnpm exec vitest run server/runtime --reporter=verbose
```

Expected: record all pass/fail/skip counts and exact failing test names. The historical 378/378 and 266/305 numbers are context only; this fresh output is authoritative.

- [ ] **Step 3: Capture the offline platform-eval baseline**

Run:

```bash
pnpm eval
```

Expected: record suite outcome/report path and confirm that the offline tier used scripted fixtures only.

- [ ] **Step 4: Map engine call paths and classify failures**

Inspect the current route assignment in `server/index.ts`, `usesNativeAgentEngine()` in `server/agent-runtime/engine-support.ts`, the native branch and legacy branch in `server/agent-runtime/native-turn-runtime.ts`, and `native-provider-acceptance.test.ts`. Classify each runtime failure as fixture setup, stale capability expectation, real contract drift, or unrelated; do not change code in this task.

- [ ] **Step 5: Write the baseline report**

Record the exact failure IDs and their owning files, whether a zero-cost/local model is configured, whether Docker is available (inspection only), and whether any `plugins/` directory is present. Mark live model scores `not run` unless a non-billed model is explicitly configured. Never infer a pass from a skipped command.

### Task 2: Repair only the confirmed runtime-suite drift

**Files:**
- Modify: `server/runtime/capabilities.ts`, `server/runtime/capabilities.test.ts` (stale external-engine capability rows)
- Modify: `server/runtime/level.ts`, `server/runtime/level.test.ts` (only if the fresh failure matrix confirms level-cap drift)
- Modify: `server/runtime/envelope.ts`, `server/runtime/envelope.test.ts` (only if the fresh failure matrix confirms envelope-contract drift)
- Modify: `server/runtime/runtime.test.ts`, `server/runtime/scenarios.test.ts` (only if the fresh failure matrix names fixture/provider-instance failures in these files)

**Interfaces:**
- Consumes: Task 1 failure matrix and existing native-driver capabilities from `server/agent-runtime/engine-support.ts` / `shared/approval-mode.ts`.
- Produces: corrected fixtures and native-only capability expectations; unknown or unsupported driver IDs remain conservative.

- [ ] **Step 1: Write/update focused failing assertions from the failure matrix**

For stale capability rows, assert that every registered driver has exactly one runtime row and removed external driver IDs do not advertise supported runtime capabilities. For any level/envelope drift, assert the currently intended permission source, data-provenance wording, and consent rule. For provider fixtures, assert they supply the exact required instance ID/config instead of bypassing production validation.

- [ ] **Step 2: Run the focused tests to confirm the failures**

Run the exact files named in the matrix, for example:

```bash
pnpm exec vitest run server/runtime/capabilities.test.ts server/runtime/level.test.ts server/runtime/envelope.test.ts
```

Expected: only the new/updated assertions fail for the recorded reason. If the failure belongs to another file, add that exact file to the matrix before editing it.

- [ ] **Step 3: Make the minimal source/fixture corrections**

Remove only stale runtime capability rows for unsupported drivers, preserve conservative defaults for unknown IDs, align genuine `level`/`envelope` drift with the current contract, and repair provider fixtures without changing production permission behavior to satisfy a test.

- [ ] **Step 4: Run focused tests, then the complete runtime suite**

Run:

```bash
pnpm exec vitest run server/runtime/capabilities.test.ts server/runtime/level.test.ts server/runtime/envelope.test.ts
pnpm exec vitest run server/runtime --reporter=verbose
```

Expected: focused tests pass; every remaining runtime failure is explained by a quoted test error in the baseline report and explicitly excluded only with owner approval.

### Task 3: Port the 15 engine-task definitions and self-checking checkers

**Files:**
- Create: `evals/engine-tasks/tasks.ts`
- Create: `evals/engine-tasks/tasks.test.ts`

**Interfaces:**
- Consumes: MausClaw workspace tool contracts and the RootClaw task concepts/checks.
- Produces:

```typescript
interface EngineTaskCheck { pass: boolean; why: string }
interface EngineTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  solution: Record<string, string>;
  check(dir: string): EngineTaskCheck;
  suite?: "basic" | "hard";
  web?: Record<string, string>;
  skill?: { name: string; description: string; body: string };
  compactAt?: number;
}
const ENGINE_TASKS: EngineTask[];
```

Read-only reference: `/root/github-repos/RootClaw/evals/engine-tasks/{README.md,tasks.ts,engine-tasks.test.ts}`. Port task meaning/checks, not runner imports or implementation files.

- [ ] **Step 1: Write failing task-catalog and checker tests**

Assert the exact ordered IDs:

```text
fix-function, bug-from-log, rename-symbol, create-file, csv-transform,
multi-refactor, failing-test, apply-diff, long-context, parallel-reads,
web-lookup, skill-use, async-bug, cli-flag, ini-to-json
```

For every task, assert the seeded state fails, applying its known-good solution passes, and protected task files remain unchanged. Assert five `basic` and ten `hard` tasks with unique IDs.

- [ ] **Step 2: Run the new checker tests to confirm they fail**

Run: `pnpm exec vitest run evals/engine-tasks/tasks.test.ts`

Expected: FAIL because the task catalog/checkers do not yet exist.

- [ ] **Step 3: Implement the task catalog and pure checkers**

Port the task intent, workspace seeds, required context cases, and acceptance checks—not RootClaw implementation files. Each checker uses only the task workspace and a bounded subprocess timeout; it must not judge model prose.

- [ ] **Step 4: Run checker tests to confirm they pass**

Run: `pnpm exec vitest run evals/engine-tasks/tasks.test.ts`

Expected: all 15 known-good solutions pass and all 15 seeded states fail for a task-specific reason.

### Task 4: Build an isolated, opt-in native engine-task runner

**Files:**
- Create: `evals/engine-tasks/run-engine-tasks.ts`
- Create: `evals/engine-tasks/run-engine-tasks.test.ts`
- Test reference: `server/agent-runtime/native-provider-acceptance.test.ts`
- Test reference: `server/agent-runtime/driver-opt-in.test.ts`

**Interfaces:**
- Consumes: `ENGINE_TASKS`, the existing native provider adapter, `LiveInstance`/`liveInstanceSchema`, and the task checker interface.
- Produces:

```typescript
interface EngineTaskRow {
  task: string;
  status: "pass" | "fail" | "infra" | "capped";
  why: string;
  requests: number;
  rounds: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  stopReason?: string;
  costUsd?: number;
  costSource?: "provider" | "price-table" | "unknown";
  compactions: number;
  tools: string[];
  error?: string;
}
async function runEngineTask(input: {
  task: EngineTask;
  instance: LiveInstance;
  maxRequests: number;
}): Promise<EngineTaskRow>;
```

The per-task runner requires an explicit `LiveInstance` and `maxRequests`; each task uses a fresh bot/thread/workspace under a temporary `MAUSCLAW_DATA_DIR`, and the turn explicitly uses `agentEngine: "mausclaw-native"`. Checker-only mode is orchestrated separately in Task 5 and never constructs a provider.

- [ ] **Step 1: Write runner tests against a loopback fake provider**

Pin that `runEngineTask` uses a fresh workspace, the request cap refuses request `N+1` including model discovery, provider errors are marked infrastructure failures rather than task failures, and temp data/workspaces, fetch hooks, environment, DB handles, and server sockets are restored on success, failure, and abort. CLI mode/gate behavior is pinned in Task 5.

- [ ] **Step 2: Run runner tests to confirm they fail**

Run: `pnpm exec vitest run evals/engine-tasks/run-engine-tasks.test.ts`

Expected: FAIL with the missing runner behavior, using only a loopback fixture.

- [ ] **Step 3: Implement isolated native task execution**

Load configuration through the existing live-instance schema; read secrets only from named environment variables. Set `MAUSCLAW_DATA_DIR` before dynamically importing server modules. Seed each task into a unique temporary bot workspace, create a fresh thread, run the supported native adapter path, collect events/run records, call the task checker, then clean up in `finally`.

- [ ] **Step 4: Add a hard request counter and redacted failure capture**

Count all outgoing provider HTTP requests at the runner boundary (including model-list/probe calls). Never log headers; redact configured secrets and bearer tokens from bounded request/response failure bodies. A report must distinguish provider/infra errors, request-budget stops, and task-check failures.

- [ ] **Step 5: Run runner tests to confirm they pass**

Run: `pnpm exec vitest run evals/engine-tasks/run-engine-tasks.test.ts`

Expected: all loopback tests pass with no credential or task file escaping its temp root.

### Task 5: Add a versioned report, offline command, and Phase 0 baseline artifact

**Files:**
- Create: `evals/engine-tasks/report.ts`
- Create: `evals/engine-tasks/report.test.ts`
- Create: `evals/engine-tasks/README.md`
- Create: `evals/engine-tasks/baselines/phase0.json`
- Modify: `evals/README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 run rows and Task 1 baseline facts.
- Produces:

```typescript
interface EngineEvalReport {
  schemaVersion: 1;
  generatedAt: string;
  commit: string;
  taskSetHash: string;
  mode: "checkers" | "live";
  liveStatus: "not-run" | "completed" | "blocked";
  provider?: string;
  model?: string;
  maxRequests?: number;
  requests: { sent: number; refused: number };
  rows: EngineTaskRow[];
}
type EngineEvalMode = "checkers" | "live";
interface EngineEvalOptions {
  mode: EngineEvalMode;
  taskIds?: string[];
  instance?: LiveInstance;
  maxRequests?: number;
}
async function runEngineTasks(options: EngineEvalOptions): Promise<EngineEvalReport>;
function renderEngineReport(report: EngineEvalReport): { json: string; markdown: string };
function writeEngineReport(outDir: string, report: EngineEvalReport, runId: string): { json: string; markdown: string };
```

In checker mode, each task row is `pass` only when the seeded state fails its checker and its known-good solution passes; it records zero provider requests/rounds and `liveStatus: "not-run"`.

JSON/Markdown output goes under ignored `evals/reports/runs/`; the baseline manifest is committed under `evals/engine-tasks/baselines/`; `pnpm eval:engine` is the offline checker command.

- [ ] **Step 1: Write failing report and CLI-gate tests**

Assert the report records commit/task-set hash, provider/model or `not-run`, prompt/tool/budget configuration, per-task outcome, infra classification, request count, optional usage/cost with source, duration, compactions, and stop reason. Assert secrets are absent, cost is `unknown` rather than zero when unavailable, checker mode sends zero requests, and live mode without the explicit gate/config refuses before sending.

- [ ] **Step 2: Run report tests to confirm they fail**

Run: `pnpm exec vitest run evals/engine-tasks/report.test.ts`

Expected: FAIL for the missing schema/serializer.

- [ ] **Step 3: Implement report schema and artifact writer**

Write per-run JSON/Markdown only under `evals/reports/runs/` (already ignored). Keep the stable Phase 0 manifest in `evals/engine-tasks/baselines/phase0.json`; never put API keys or raw unredacted response bodies in the committed baseline.

- [ ] **Step 4: Add `pnpm eval:engine` and documentation**

The default command calls `runEngineTasks({ mode: "checkers" })`. Live execution requires `--live`, `MAUSCLAW_EVAL_ENGINE=1`, `MAUSCLAW_EVAL_LIVE_CONFIG` or `MAUSCLAW_EVAL_LIVE_INSTANCE`, and an explicit `--max-requests`. Paid use remains blocked pending separate owner approval.

- [ ] **Step 5: Run report, task, and runner tests**

Run: `pnpm exec vitest run evals/engine-tasks`

Expected: PASS with no network access in checker mode.

### Task 6: Save the Phase 0 report and decide the legacy-loop disposition

**Files:**
- Modify: `docs/superpowers/reports/2026-11-03-mausclaw-phase-0-baseline.md`
- Modify: `evals/engine-tasks/baselines/phase0.json`
- Modify: `evals/engine-tasks/README.md` only if the actual gate/command differs from the documented usage.

**Interfaces:**
- Consumes: fresh test/failure matrix, engine-task checker/runner results, and owner-approved cost constraints.
- Produces: one reproducible Phase 0 report and an explicit recommendation: product routes already native, remaining legacy adapter caller(s), and the parity/removal gate planned for Phase 1. No legacy code is removed in Phase 0.

- [ ] **Step 1: Run the offline engine-task validation**

Run: `pnpm eval:engine`

Expected: all checkers/harness self-tests pass; no live provider requests are sent.

- [ ] **Step 2: Capture a live engine-task run only if it is non-billed or separately approved**

If a local/free model is configured, run a bounded pilot on the basic suite and record exact model/provider/request cap. Otherwise set `liveStatus` to `not-run` with reason `no approved non-billed model`; do not call `beam` or another paid endpoint on assumption.

- [ ] **Step 3: Finalize baseline manifest and report**

Record current commit, test results, repaired/excluded failures and their owner approval, task-set hash, model/cost status, and legacy path map. Preserve the distinction between deterministic checker success and live agent task success.

### Task 7: Final Phase 0 verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run focused native and runtime suites**

Run:

```bash
pnpm exec vitest run server/agent-runtime
pnpm exec vitest run server/runtime --reporter=verbose
```

Expected: native runtime remains green; runtime is green or every remaining failure is listed with exact test name and owner-approved exclusion.

- [ ] **Step 2: Run platform and engine offline evals**

Run:

```bash
pnpm eval
pnpm eval:engine
```

Expected: existing offline behavior evals and new engine checker suite pass. No live model request is made.

- [ ] **Step 3: Run typecheck and lint**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both exit 0; no lint suppression or weakened test was added.

- [ ] **Step 4: Verify the isolated server fixture if a server/conversation behavior changed**

Follow `docs/verification/README.md`: launch `node --experimental-strip-types scripts/control-mausclaw.ts launch`, drive only its printed loopback URL, and stop the fixture. Never target a live MausClaw app/data directory.

- [ ] **Step 5: Update the report from command output and review the final diff**

Run `git status --short` and inspect the complete diff. The diff must contain only Phase 0 tests/eval/report/runtime-hygiene files; no context/tool feature port, plan+verify, orchestrator default, plugin feature, paid benchmark, deployment, or unrelated change.

## Self-Review

1. **Spec coverage:** baseline/path inventory, current runtime failure cleanup, 15 task/checker port, isolated request-capped runner, report schema, budget/no-spend gates, and legacy-loop disposition each map to a task. No context/tool-engine behavior from Phases 1–5 is implemented here.
2. **Step scan:** each task has an independently testable deliverable; TDD is used for runtime contract changes, task checkers, runner behavior, and report serialization.
3. **Type consistency:** `EngineTask`, `RunRow`, and `EngineEvalReport` are defined in the new engine-task modules; provider config reuses `LiveInstance`; `pnpm eval:engine` points to the runner.
4. **Review Focus:** all five failure classes are pinned in checker, runner, report, or isolation tests.
5. **Proportion:** the plan is limited to baseline/hygiene/eval infrastructure, not the full engine design.

---

**Plan complete and saved to** `docs/superpowers/plans/2026-11-03-mausclaw-native-engine-phase-0.md`. Please review it. Does it capture what you want, and which execution approach should we use?

- **Subagent-driven** — a fresh implementer/reviewer pair works task-by-task; most thorough, more context and review cost.
- **Native** — I implement every task in this session and one fresh reviewer checks Phase 0 at the end; fastest, with review after the whole slice.

**Recommendation:** Native execution. Phase 0 is a bounded baseline/hygiene/eval slice with clear file boundaries; a single implementer can keep the suite/report interfaces consistent, followed by an independent review before any later phase.
