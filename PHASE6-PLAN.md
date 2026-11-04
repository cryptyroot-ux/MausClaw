# Phase 6 (M10) Implementation Plan

## M10 — Uncertain effects, durable recovery, verification, orchestration, budgets

### Work Items:
1. **Fix `recoverUnsettledOrchestratorPlans`** (message-db.ts) — Same pattern as M6:
   - Plans with unsettled steps (running/approval_required) → mark as `recovery_required`
   - Plans with ZERO steps → mark as `interrupted`
   - Plans with all settled steps (completed/failed) → leave untouched

2. **Orchestrator handles `recovery_required` from engine** (orchestrator.ts):
   - When engine run returns `recovery_required`, mark step as `recovery_required` (not `failed`)
   - Stop plan on `recovery_required` step (same as `failed`)

3. **Verification representation** (orchestrator.ts / intelligence-layer.ts):
   - When no verifier configured, step result should show `verification: { verified: false, reason: "not_run" }` not silently skipped
   - Negative verdict must not produce successful terminal receipt (already works via retry → fail)

4. **Budget accounting** (budget-guard.ts / intelligence-layer.ts):
   - Track all model calls: engine, verifier, compaction, orchestration
   - Identify unmetered categories

### Tests (RED → GREEN):
- message-db.test.ts: recoverUnsettledOrchestratorPlans distinguishes plans with/without active steps
- orchestrator.test.ts: engine recovery_required stops plan, marks step correctly
- orchestrator.test.ts: verification not-run represented in step result
- budget-guard.test.ts: tracks all model call categories

### Files to modify:
- server/message-db.ts (recoverUnsettledOrchestratorPlans)
- server/agent-runtime/orchestrator.ts (recovery_required handling, verification representation)
- server/agent-runtime/intelligence-layer.ts (verification, budget tracking)
- server/agent-runtime/routing/budget-guard.ts (category tracking)