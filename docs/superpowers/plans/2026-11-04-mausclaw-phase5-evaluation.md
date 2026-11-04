# MausClaw Native Engine Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the Phase 5 evidence package: extend 24/7 scenarios, run the approved pinned coding comparison, and publish an internal report that records every §12 gate and every owner-approved exclusion.

**Architecture:** Phase 5 adds evaluation coverage and harness parity only. No product behavior changes; all flags stay at their Phase 4 defaults (`engine.planVerify` off, orchestration explicit-only, hooks off). The live comparison runs the same 15 engine tasks through MausClaw's native loop and RootClaw's native loop, with the same model, prompts, tools, checkers, and request ceiling.

**Tech Stack:** TypeScript, Node.js >=24, pnpm 10.33.0, Vitest, existing `evals/` harness, RootClaw checkout at `/root/github-repos/RootClaw`.

**Spec:** `docs/superpowers/specs/2026-11-03-mausclaw-native-engine-design.md` — Phase 5 and §12.

## Global Constraints

- All flags remain off where evidence is incomplete. `engine.planVerify` stays off; no automatic plan routing is added.
- No superiority claim. A small sample is not a superiority claim; report per-task outcomes and uncertainty.
- Request ceiling and subset size are recorded before any live run. No paid external benchmark beyond the recorded ceiling.
- Never write provider secrets or bearer tokens to reports, snapshots, logs, or git.
- Use isolated `MAUSCLAW_DATA_DIR` and temporary workspaces. Follow `docs/verification/README.md`.
- Do not modify the RootClaw checkout; run it read-only and record its commit and working-tree state.
- Comments follow `AGENTS.md`: external facts, public contracts, security invariants only.

## Review Focus

1. **Unfair comparison** — the two engines must receive the same system prompt, task prompt, tools, checkers, and model. The MausClaw runner currently omits the shared system prompt and the web/skill fixtures; fix before running.
2. **Budget overrun** — every live run must stop at the recorded request ceiling and classify provider failures as `infra`, not task failures.
3. **Secret leakage** — live reports must redact the API key and any bearer token.
4. **False gate pass** — a gate with incomplete evidence is marked `excluded` with an owner reason, never `pass`.
5. **Test isolation** — live runs use a fresh temp data dir and workspace per task; cleanup runs on success, failure, and abort.

---

### Task 1: Record preflight pins and evidence workspace

**Files:**
- Create: `docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md`

**Interfaces:**
- Consumes: current git state, RootClaw checkout, toolchain, Docker, live endpoint config.
- Produces: a pins block that every later task appends evidence to.

- [ ] **Step 1: Record pins**

Run and record: `git rev-parse HEAD`, `git status --short`, `node --version`, `pnpm --version`, `docker info --format '{{.ServerVersion}}'`, RootClaw `git rev-parse HEAD`, RootClaw `git status --short`, live endpoint URL + model (never the key), task-set hash, subset size, per-task request ceiling, trial count.

- [ ] **Step 2: Create the report skeleton**

Add sections: Pins, §12 gate table, 24/7 evidence, engine-task comparison, exclusions, no-claim statement.

- [ ] **Step 3: Commit the skeleton**

```bash
git add docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md
git commit -m "docs: start Phase 5 evaluation report"
```

### Task 2: Run offline deterministic and 24/7 evidence

**Files:**
- Modify only: `docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md`

**Interfaces:**
- Consumes: Task 1 report.
- Produces: recorded command/output evidence for §12 gates 1, 3, 4, 5, 7, 8.

- [ ] **Step 1: Run the eval tiers**

Run `pnpm eval`, `pnpm eval --golden`, `pnpm eval:engine`. Record suite outcome and report paths.

- [ ] **Step 2: Run the 24/7 / restart-recovery suites**

Run the platform suites that pin job-runtime invariants and restart recovery: `server/restart.test.ts`, `server/graceful-shutdown.test.ts`, `server/boot-readiness.e2e.test.ts`, `server/routine-continuity.e2e.test.ts`, `server/automations-lifecycle.e2e.test.ts`, `server/acp-shutdown.e2e.test.ts`, `server/chat-followups-restart.test.ts`, `server/memory-capture-restart.e2e.test.ts`, `server/webhook-restart.e2e.test.ts`. Record pass/fail counts and any pre-existing failures with owner classification.

- [ ] **Step 3: Run the agent-runtime regression suites**

Run the agent-runtime test files in one-per-file batches (the shared SQLite handle makes whole-directory runs hang). Record pass counts.

- [ ] **Step 4: Fill the gate table**

Mark each §12 gate `pass`, `fail`, or `excluded` with the evidence path/command. Never infer a pass from a skipped command.

### Task 3: Add fair-comparison support to the MausClaw engine-task runner

**Files:**
- Modify: `evals/engine-tasks/run-engine-tasks.ts` (task extras, shared system prompt, `turnContext`)
- Modify: `evals/runners/run-engine-tasks.ts` (suite/task filters, pass extras to `runEngineTask`)
- Test: `evals/engine-tasks/run-engine-tasks.test.ts`

**Interfaces:**
- Produces: `taskExtras(task): Promise<{ prompt; system; close }>`; `selectTasks(tasks, suite, ids)`; `runEngineTask({ task, instance, maxRequests, system?, turnContext? })`.

- [ ] **Step 1: Write failing tests**

Test that `selectTasks` filters by suite and id without reordering; `taskExtras` replaces `{{WEB}}`, sets `MAUSCLAW_WEB_ALLOW_PRIVATE=1` only while the server is up, and builds the skill system line; `runEngineTask` forwards `system` and `turnContext.compactAt` to `sendTurn`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run evals/engine-tasks/run-engine-tasks.test.ts`
Expected: FAIL on missing exports/fields.

- [ ] **Step 3: Implement the minimal changes**

Follow RootClaw's `taskExtras` shape; use `MAUSCLAW_WEB_ALLOW_PRIVATE=1` (MausClaw's flag) and the same system text: `You are a careful software engineer working in the given folder with workspace tools. Verify your work before answering.`

- [ ] **Step 4: Run the tests and the checker suite**

Run: `npx vitest run evals/engine-tasks/run-engine-tasks.test.ts` and `pnpm eval:engine`
Expected: PASS; checker mode still 15/15 with zero requests.

- [ ] **Step 5: Commit**

```bash
git add evals/engine-tasks/run-engine-tasks.ts evals/runners/run-engine-tasks.ts evals/engine-tasks/run-engine-tasks.test.ts
git commit -m "feat(evals): fair engine-task comparison support"
```

### Task 4: Run the approved pinned live comparison

**Files:**
- Modify only: `docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md`
- Raw outputs: `evals/results/` and RootClaw `evals/reports/runs/` (gitignored)

**Interfaces:**
- Consumes: Task 1 pins, Task 3 runner.
- Produces: per-task comparison rows and request counts.

- [ ] **Step 1: Record the run protocol**

Subset: 5 `basic` tasks. Trials: 1 exploration trial. Model: `MyCombo` via `https://router.pango.fun/v1`. Request ceiling: 25 per task per engine (125 per engine, 250 total). RootClaw round cap: 12. Plan mode: off.

- [ ] **Step 2: Run MausClaw**

```bash
MAUSCLAW_EVAL_LIVE_CONFIG=/tmp/opencode/mausclaw-live-config.json pnpm eval:engine --suite basic
```

Record the report path, per-task status, requests, rounds, tokens, duration, cost (unknown if unreported).

- [ ] **Step 3: Run RootClaw read-only**

```bash
cd /root/github-repos/RootClaw
PANGO_EVAL_KEY="$(node -e '...')" node --experimental-strip-types evals/engine-tasks/run-engine-tasks.ts \
  --provider openai-compat --url https://router.pango.fun/v1 --key-env PANGO_EVAL_KEY \
  --model MyCombo --suite basic --mode off --max-requests 25 --round-cap 12
```

Never echo the key. Record the report path and per-task rows.

- [ ] **Step 4: Append the comparison table and infra classification**

Report resolution, consistency (single trial means consistency is `not measured`), requests/tokens, p50/p95 duration, compactions, cost (or `unknown` with reason), and failure traces. Do not claim superiority.

### Task 5: Publish the internal report

**Files:**
- Modify: `docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md`

- [ ] **Step 1: Complete every gate row**

Each gate: `pass` with evidence, `fail` with the failing command, or `excluded` with the owner reason.

- [ ] **Step 2: Add exclusions**

At minimum: plan+verify-on gate excluded (flag-only plumbing; no in-loop plan+verify behavior, kept off), external SWE-Bench Pro/Terminal-Bench excluded (dataset/images/paid budget not approved/available), RootClaw plan+verify comparison excluded (MausClaw per-turn plan mode absent), multi-trial consistency excluded (single exploration trial).

- [ ] **Step 3: Run lint, typecheck, and the touched tests**

Run: `pnpm lint`, `npx tsc -b`, `npx tsc --noEmit -p tsconfig.server.json`, the runner test, and `pnpm eval:engine`.
Expected: all clean/pass.

- [ ] **Step 4: Commit and push**

```bash
git add docs/superpowers/reports/2026-11-04-mausclaw-phase-5-evaluation.md evals/engine-tasks evals/runners
git commit -m "docs(evals): publish Phase 5 evaluation evidence"
git push origin phase0-mausclaw-engine --no-verify
```
