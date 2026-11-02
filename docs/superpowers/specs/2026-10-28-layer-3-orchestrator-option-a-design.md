# Layer 3 Orchestrator — Option A Design

**Status:** Draft for approval; no implementation authorized by this document alone.  
**Decision:** Option A — Orchestration layer sits **above** the Agent Engine (`Orchestrator.runPlan()` calls `AgentEngine.run()`), not inside it.  
**Date:** 2026-10-28  
**Branch:** `feature/native-agent-engine`

---

## 0. Intent

MausClaw already has a native Agent Engine (Layer 1) that owns a single turn: admission, model rounds, tool orchestration, compaction, retry/recovery, and budget. Layer 3 adds **multi-step orchestration**: plan multiple steps, execute each via the existing engine, carry context/results between steps, and support approval gates at plan and step level.

This is **not** replacing the engine. The engine stays a single-turn executor. A new `Orchestrator` layer sits on top, coordinating many engine runs into one plan.

This matches the industry pattern seen in OpenAI Swarm and oh-my-claudecode: an orchestrator loop above individual agent calls, with agent handoff and shared context variables.

---

## 1. Architecture Decision: Option A

| Question | Decision |
|----------|----------|
| **Primitive** | Orchestrator above engine — new `Orchestrator.runPlan()` calls existing `AgentEngine.run()` per step. |
| **Engine change** | None. `AgentEngine.run()` and `AgentRunRequest` unchanged. |
| **Contract freeze** | Safe — only ADD new types/files (`Orchestrator`, `PlanStep`, `PlanResult`, `OrchestratorStore`). No existing types renamed or removed. |
| **State** | New `OrchestratorStore` (SQLite, same run journal pattern) for plan state; run-level state stays in `run-store.ts`. |
| **Capabilities** | Reuse existing `CapabilityProvider` / `CapabilitySession` per step. No new `AgentProvider`. |
| **Approval** | Gates at both plan level (before first step) and step level (before each step). |
| **Observability** | New `OrchestrationEvent` stream, separate from `AgentEvent`. |

### Why not Option B

Option B (orchestration inside engine via extended `AgentRunRequest`) would require:
- Modifying `AgentRunRequest` — violates contract freeze.
- Coupling multi-turn planning logic into the single-turn engine loop — harder to test, higher risk.
- No clean industry precedent; OpenAI Swarm and oh-my-claudecode both use orchestrator-above-agent.

---

## 2. Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Orchestrator (Layer 3)                   │
│  runPlan(steps) → for each step: engine.run()               │
│  - Plan state (pending/running/completed/failed)            │
│  - Approval gates (plan-level + step-level)                 │
│  - Context variables carried between steps                  │
│  - Step dependency (DAG)                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────────────┐
│              Agent Engine (Layer 1)                         │
│  run(request) → single turn: model rounds, tools, compaction│
│  - run-store.ts (SQLite run journal)                        │
└──────────────────────┬──────────────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────────────┐
│          LLM Provider / Model (Layer 2)                     │
│  ModelAdapter: catalog, auth, protocol                      │
└──────────────────────┴──────────────────────────────────────┘
                       │ calls
┌──────────────────────▼──────────────────────────────────────┐
│            Capability System (Layer 3)                      │
│  CompositeCapabilityRuntime: MCP, native, skills, browser   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Contracts

New types in `server/agent-runtime/contracts.ts` (additive only):

```typescript
export type PlanId = string;
export type StepId = string;

export type PlanStatus = "pending" | "running" | "completed" | "failed" | "interrupted";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "approval_required";

export interface PlanStep {
  readonly id: StepId;
  readonly text: string;                       // user instruction for this step
  readonly providerModel: ProviderModelRef;    // which model to use
  readonly grant: CapabilityGrant;             // permissions for this step
  readonly capabilities: CapabilitySession;    // capabilities available to this step
  readonly dependsOn?: ReadonlyArray<StepId>;  // DAG dependencies (future)
  readonly approval?: "auto" | "ask";          // override plan-level approval for this step
  readonly budget?: {                          // step-level budget override
    readonly maxTokens?: number;
    readonly maxCostUsd?: number;
    readonly maxWallTimeMs?: number;
    readonly maxModelRounds?: number;
  };
}

export interface PlanResult {
  readonly stepId: StepId;
  readonly runId: string;
  readonly status: StepStatus;
  readonly output?: string;      // final assistant text from engine run
  readonly error?: string;
  readonly modelRounds?: number;
  readonly toolCalls?: number;
}

export interface OrchestratorContext {
  readonly planId: PlanId;
  readonly contextVariables: ReadonlyMap<string, string>;  // shared between steps
  readonly signal: AbortSignal;
  readonly approvalMode: "ask" | "auto-edits" | "approve-for-me" | "full";
}

export interface OrchestratorStore {
  createPlan(record: PlanRecord): void;
  getPlan(planId: PlanId): PlanRecord | undefined;
  updatePlanStatus(planId: PlanId, status: PlanStatus, updatedAt: number): boolean;
  createStep(record: StepRecord): void;
  getStep(stepId: StepId): StepRecord | undefined;
  updateStepStatus(stepId: StepId, status: StepStatus, updatedAt: number, result?: PlanResult): boolean;
  listSteps(planId: PlanId): StepRecord[];
}

export interface PlanRecord {
  readonly planId: PlanId;
  readonly status: PlanStatus;
  readonly steps: ReadonlyArray<StepId>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contextVariables: ReadonlyMap<string, string>;
}

export interface StepRecord {
  readonly stepId: StepId;
  readonly planId: PlanId;
  readonly status: StepStatus;
  readonly result?: PlanResult;
  readonly startedAt?: number;
  readonly completedAt?: number;
}
```

New `Orchestrator` interface:

```typescript
export interface Orchestrator {
  /** Create and start executing a plan. Returns immediately; use `done` promise to await completion. */
  runPlan(steps: readonly PlanStep[], context: OrchestratorContext): { planId: PlanId; done: Promise<void> };
  /** Get results for all steps of a plan. */
  getPlanResults(planId: PlanId): readonly StepRecord[] | undefined;
  /** Interrupt a running plan. */
  interrupt(planId: PlanId): void;
}
```

---

## 4. Orchestrator Logic

`server/agent-runtime/orchestrator.ts`

```typescript
export function createOrchestrator(dependencies: {
  readonly engine: AgentEngine;
  readonly store: OrchestratorStore;
}): Orchestrator {
  const active = new Map<string, { controller: AbortController; planId: string }>();

  async function runPlan(steps, context): Promise<{ planId, done }> {
    const planId = randomUUID();
    const controller = new AbortController();
    active.set(planId, { controller, planId });

    // Plan-level approval gate
    if (context.approvalMode === "ask") {
      // emit OrchestrationEvent "plan.approval_required", wait for user signal
    }

    const planRecord: PlanRecord = { planId, status: "running", steps: steps.map(s => s.id), createdAt: Date.now(), updatedAt: Date.now(), contextVariables: new Map(context.contextVariables) };
    dependencies.store.createPlan(planRecord);

    const done = (async () => {
      try {
        const contextVars = new Map(context.contextVariables);
        for (const step of steps) {
          if (controller.signal.aborted) break;

          // Step dependency check (future DAG support)
          if (step.dependsOn?.some(dep => stepStatus(dep) !== "completed")) {
            await recordStep(step, planId, "skipped", { status: "skipped", error: "dependency not completed" });
            continue;
          }

          // Step-level approval gate
          const stepApproval = step.approval ?? context.approvalMode;
          if (stepApproval === "ask") {
            await recordStep(step, planId, "approval_required");
            // emit OrchestrationEvent "step.approval_required", wait for user signal
            // if rejected, mark step failed and continue/break
          }

          await recordStep(step, planId, "running");

          // Build engine request from step, injecting context variables into messages
          const engineRequest: AgentRunRequest = {
            botId: step.grant.botId,
            threadId: step.grant.threadId,
            text: step.text,
            messages: buildMessagesWithContext(step, contextVars),
            providerModel: step.providerModel,
            grant: step.grant,
            capabilities: step.capabilities,
            signal: controller.signal,
            ...(step.budget ? { budget: step.budget } : {}),
          };

          const { runId, done: runDone } = dependencies.engine.run(engineRequest);
          await runDone;

          const runRecord = store.getRun(runId);
          const stepResult: PlanResult = {
            stepId: step.id,
            runId,
            status: runRecord.status === "completed" ? "completed" : "failed",
            output: extractFinalText(runRecord),   // from events
            error: runRecord.failureCode,
            modelRounds: runRecord.modelRounds,
            toolCalls: runRecord.toolCalls,
          };

          // Carry output into context variables for next step
          if (stepResult.output) contextVars.set(`step_${step.id}_output`, stepResult.output);

          await recordStep(step, planId, stepResult.status, stepResult);

          if (stepResult.status === "failed") break; // or continue based on policy
        }

        dependencies.store.updatePlanStatus(planId, "completed", Date.now());
      } catch {
        dependencies.store.updatePlanStatus(planId, "failed", Date.now());
      } finally {
        active.delete(planId);
      }
    })();

    return { planId, done: done.then(() => {}) };
  }

  return { runPlan, getPlanResults, interrupt };
}
```

---

## 5. State Management

### Where plan state lives

**New `OrchestratorStore` backed by SQLite**, following the same pattern as `run-store.ts`:

- File: `server/agent-runtime/orchestrator-store.ts`
- Table: `orchestrator_plans` (planId PK, status, steps JSON, createdAt, updatedAt, contextVariables JSON)
- Table: `orchestrator_steps` (stepId PK, planId FK, status, result JSON, startedAt, completedAt)

Why SQLite:
- Consistent with run journal (already SQLite via `createSqliteAgentRunStore`).
- Crash recovery: interrupted plans can be resumed on restart (`recoverUnsettledPlans`).
- No new infrastructure dependency.

Why a separate store (not `run-store.ts` extension):
- Plans are a different entity from runs; keeping them separate avoids coupling.
- Contract freeze: `AgentRunStore` unchanged.

### Run-level state

Stays in `run-store.ts` (existing). Each step creates one `AgentRunRecord`. The orchestrator references runIds but does not duplicate run state.

---

## 6. Approval Model

Two levels:

| Level | When | What happens |
|-------|------|--------------|
| **Plan-level** | Before first step executes | `OrchestrationEvent "plan.approval_required"` emitted; orchestrator waits for approval signal. |
| **Step-level** | Before each step (if `approval === "ask"` or plan-level `approvalMode === "ask"`) | `OrchestrationEvent "step.approval_required"` emitted; orchestrator waits. |

Approval flow:
1. Orchestrator emits event, sets step status to `approval_required`.
2. External actor (UI / human / API) calls `orchestrator.approve(planId, stepId)` or `orchestrator.reject(planId, stepId)`.
3. If approved: step proceeds to `running`, engine.run() called.
4. If rejected: step marked `failed` with error `"rejected"`; plan continues to next step or stops (configurable).

For `approvalMode: "full"` or `"auto-edits"`: no gates, all steps run automatically.

---

## 7. Observability

New event stream separate from `AgentEvent`:

```typescript
export type OrchestrationEvent =
  | { readonly type: "plan.started"; readonly planId: PlanId; readonly stepCount: number }
  | { readonly type: "plan.completed"; readonly planId: PlanId }
  | { readonly type: "plan.failed"; readonly planId: PlanId; readonly error: string }
  | { readonly type: "plan.interrupted"; readonly planId: PlanId }
  | { readonly type: "step.started"; readonly planId: PlanId; readonly stepId: StepId }
  | { readonly type: "step.completed"; readonly planId: PlanId; readonly stepId: StepId; readonly runId: string }
  | { readonly type: "step.failed"; readonly planId: PlanId; readonly stepId: StepId; readonly error: string }
  | { readonly type: "step.approval_required"; readonly planId: PlanId; readonly stepId: StepId }
  | { readonly type: "plan.approval_required"; readonly planId: PlanId }
  | { readonly type: "context.variable.set"; readonly planId: PlanId; readonly key: string };
```

`Orchestrator.onEvent(planId, listener)` — same pattern as `engine.onEvent(threadId, listener)`.

---

## 8. Implementation Plan (Slices)

| Slice | Description | Effort | Risk |
|-------|-------------|--------|------|
| 1 | Add `PlanStep`, `PlanResult`, `OrchestratorContext`, `OrchestratorStore` types to contracts.ts | Small | Low |
| 2 | Create `orchestrator-store.ts` (SQLite) | Medium | Low |
| 3 | Create `orchestrator.ts` with `runPlan()` (sequential steps, no DAG yet) | Medium | Low |
| 4 | Add approval gates (plan + step level) | Medium | Low |
| 5 | Add context variable carrying between steps | Small | Low |
| 6 | Add `OrchestrationEvent` stream + `onEvent` | Small | Low |
| 7 | Tests: orchestrator.test.ts (plan execution, approval, context carry, failure stop) | Medium | Low |
| 8 | DAG step dependencies (`dependsOn`) | Medium | Medium |

**Recommended first slice:** #1–#3 (basic sequential plan execution), then #4 (approval), then #7 (tests).

---

## 9. Contract Freeze Checklist

| Existing Type | Status | Notes |
|--------------|--------|-------|
| `ModelCapabilities` | Unchanged | Additive only |
| `CapabilitySession` | Unchanged | Reused per step |
| `CapabilityProvider` | Unchanged | Reused per step |
| `ProviderInstance` | Unchanged | |
| `SendTurnInput` | Unchanged | |
| `AgentRunRequest` | Unchanged | Engine request built from step, not extended |
| `AgentEngine` | Unchanged | `run()` signature unchanged |
| `ModelAdapter` | Unchanged | |
| `BotRecord.toolScope` | Unchanged | Additive only |
| `ThreadState` fields | Unchanged | Additive only |

No existing types renamed or removed. All new types are additive.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Plan state drift from run state | Plan store references runIds; run state is source of truth in run-store. Plan store only mirrors status. |
| Long-running plans blocking thread | `runPlan()` returns immediately with `done` promise; runs are async. |
| Approval deadlock (no one approves) | Caller must supply approval signal; orchestrator does not auto-approve. |
| Context variable collision | Keys namespaced per step (`step_<id>_output`). Caller responsible for unique keys. |

---

## 11. Open Questions (for owner approval)

1. **DAG execution**: Should `dependsOn` be implemented in slice 1, or deferred to a later slice? (Recommended: defer to slice 8.)
2. **Plan resumption**: Should interrupted plans be auto-resumed on orchestrator restart? (Recommended: yes, via `recoverUnsettledPlans()`.)
3. **Step failure policy**: Should a failed step stop the whole plan, or continue with remaining steps? (Recommended: stop on failure, configurable via `stopOnFailure` option.)
4. **Event naming**: Should `OrchestrationEvent` extend `AgentEvent` union, or stay separate? (Recommended: separate, to keep engine events clean.)

---

## 12. References

- OpenAI Swarm (orchestrator above agent): https://github.com/openai/swarm
- oh-my-claudecode (multi-agent layer above Claude Code): https://github.com/Yeachan-Heo/oh-my-claudecode
- MausClaw-CLAW-PROJECT-STATUS.md: Layer 3 design phase, discussion required → resolved by this document (Option A).
- Existing contracts: `server/agent-runtime/contracts.ts`
- Existing engine: `server/agent-runtime/runtime.ts` (`createAgentEngine`)
- Existing run store: `server/agent-runtime/run-store.ts` (`createSqliteAgentRunStore`)
