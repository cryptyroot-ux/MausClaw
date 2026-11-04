import { randomUUID } from "node:crypto";

import { generatePlan as genPlan } from "./plan-generator.ts";
import { planExecutionWaves } from "./swarm.ts";
import type {
  AgentEngine,
  AgentEvent,
  AgentRunRequest,
  AgentRunStatus,
  ModelMessage,
  Orchestrator,
  OrchestratorContext,
  OrchestratorStore,
  OrchestrationEvent,
  PlanId,
  PlanResult,
  PlanStep,
  StepId,
  StepRecord,
  StepStatus,
} from "./contracts.ts";

/** Builds the message list for an engine run, injecting context variables as a leading system message. */
function buildMessagesWithContext(step: PlanStep, contextVariables: ReadonlyMap<string, string>): ReadonlyArray<ModelMessage> {
  const contextLines: string[] = [];
  for (const [key, value] of contextVariables) {
    contextLines.push(`${key}: ${value}`);
  }

  const prefix = contextLines.length > 0 ? `Context from prior steps:\n${contextLines.join("\n")}\n\n` : "";

  return [{ role: "system", content: prefix + step.text }];
}

type Gate = { readonly resolve: () => void; readonly reject: (reason: string) => void };

export function createOrchestrator(dependencies: {
  readonly engine: AgentEngine;
  readonly store: OrchestratorStore;
  readonly intelligence?: {
    readonly enabled: boolean;
    readonly decide: (input: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean; messages: ReadonlyArray<{ content: string | null | undefined }>; primaryModel: import("./contracts.ts").ProviderModelRef }) => { readonly allowed: boolean; readonly reason?: string; readonly route: { readonly candidates: ReadonlyArray<import("./contracts.ts").ProviderModelRef> } };
    readonly verify?: (output: string, step?: { successCriteria?: string; description?: string; text?: string; id?: string }) => Promise<{ ok: boolean; feedback: string }> | { ok: boolean; feedback: string };
  };
  readonly swarm?: {
    readonly enabled: boolean;
  };
}): Orchestrator {
  const listeners = new Map<string, Set<(event: OrchestrationEvent) => void>>();
  const active = new Map<string, {
    readonly planId: PlanId;
    readonly controller: AbortController;
    readonly steps: ReadonlyArray<PlanStep>;
    readonly contextVariables: Map<string, string>;
    readonly context: OrchestratorContext;
  }>();
  const planApprovalGate = new Map<string, Gate | undefined>();
  const stepApprovalGate = new Map<string, Gate | undefined>();

  const emit = (planId: string, event: OrchestrationEvent) => {
    for (const listener of Array.from(listeners.get(planId) ?? [])) listener(event);
  };

  const recordStep = (
    planId: string,
    step: PlanStep,
    status: StepStatus,
    result?: PlanResult,
  ): void => {
    const existing = dependencies.store.getStep(step.id);
    if (existing) {
      dependencies.store.updateStepStatus(step.id, status, Date.now(), result);
    } else {
      dependencies.store.createStep({
        stepId: step.id,
        planId,
        status,
        result,
        ...(status !== "pending" ? { startedAt: Date.now() } : {}),
        ...(status === "completed" || status === "failed" || status === "skipped" ? { completedAt: Date.now() } : {}),
      });
    }
  };

  async function runPlanLoop(planId: string): Promise<void> {
    try {
      const activePlan = active.get(planId);
      if (!activePlan) return;
      const { steps, contextVariables, context, controller } = activePlan;

      emit(planId, { type: "plan.started", planId, stepCount: steps.length });

      // Plan-level approval gate.
      if (context.approvalMode === "ask") {
        emit(planId, { type: "plan.approval_required", planId });
        await new Promise<void>((resolve, reject) => {
          planApprovalGate.set(planId, { resolve, reject });
        });
        planApprovalGate.delete(planId);
      }

      // Swarm mode: group steps into dependency waves for parallel execution.
      const useSwarm = dependencies.swarm?.enabled ?? false;
      const waves = useSwarm
        ? planExecutionWaves(steps as any)
        : steps.map((s) => [s]);

      for (const wave of waves) {
        if (controller.signal.aborted) {
          dependencies.store.updatePlanStatus(planId, "interrupted", Date.now());
          emit(planId, { type: "plan.interrupted", planId });
          return;
        }

        // Execute all steps in this wave in parallel.
        const waveResults = await Promise.all(wave.map(async (step) => {
          // Dependency check.
          if (step.dependsOn?.some((dep) => {
            const depStep = dependencies.store.getStep(dep);
            return !depStep || depStep.status !== "completed";
          })) {
            recordStep(planId, step, "skipped", {
              stepId: step.id,
              runId: "",
              status: "skipped",
              error: "dependency not completed",
            });
            return { step, result: { stepId: step.id, runId: "", status: "skipped" as const, error: "dependency not completed" } };
          }

          // Step-level approval gate.
          const stepApproval = step.approval ?? context.approvalMode;
          if (stepApproval === "ask") {
            recordStep(planId, step, "approval_required");
            emit(planId, { type: "step.approval_required", planId, stepId: step.id });
            await new Promise<void>((resolve, reject) => {
              stepApprovalGate.set(planId, { resolve, reject });
            });
            stepApprovalGate.delete(planId);
          }

          recordStep(planId, step, "running");
          emit(planId, { type: "step.started", planId, stepId: step.id });

          // Intelligence Layer.
          let providerModel = step.providerModel;
          if (dependencies.intelligence?.enabled) {
            const decision = dependencies.intelligence.decide({
              text: step.text,
              messages: buildMessagesWithContext(step, contextVariables).map((m) => ({ content: typeof m.content === "string" ? m.content : null })),
              primaryModel: step.providerModel,
            });
            if (decision.route.candidates.length > 0) {
              providerModel = decision.route.candidates[0]!;
            }
            if (!decision.allowed) {
              const failResult: PlanResult = { stepId: step.id, runId: "", status: "failed", error: decision.reason ?? "budget_exceeded" };
              recordStep(planId, step, "failed", failResult);
              emit(planId, { type: "step.failed", planId, stepId: step.id, error: decision.reason ?? "budget_exceeded" });
              return { step, result: failResult };
            }
          }

          // Self-correcting execution loop.
          const maxRetries = dependencies.intelligence?.enabled ? 2 : 0;
          let attempt = 0;
          let stepResult: PlanResult | undefined;
          let retryFeedback: string | undefined;

          while (attempt <= maxRetries) {
            const stepText = retryFeedback ? `${step.text}\n\nCorrection feedback: ${retryFeedback}` : step.text;
            const stepMessages = buildMessagesWithContext({ ...step, text: stepText }, contextVariables);

            const engineRequest: AgentRunRequest = {
              botId: step.grant.botId,
              threadId: step.grant.threadId,
              text: stepText,
              messages: stepMessages,
              providerModel,
              grant: step.grant,
              capabilities: step.capabilities,
              signal: controller.signal,
              ...(step.budget ? { budget: step.budget } : {}),
            };

            const { runId, done: runDone } = await dependencies.engine.run(engineRequest);

            let stepOutput = "";
            const unsubscribe = dependencies.engine.onEvent(engineRequest.threadId, (event: AgentEvent) => {
              if (event.type === "model.delta") {
                stepOutput += event.delta;
              }
            });

            await runDone;
            unsubscribe();

            const runRecord = dependencies.engine.getState(runId);
            const runStatus: AgentRunStatus = runRecord?.status ?? "failed";
            const stepStatus: StepStatus = runStatus === "completed" ? "completed" : runStatus === "recovery_required" ? "recovery_required" : "failed";
            stepResult = {
              stepId: step.id,
              runId,
              status: stepStatus,
              output: stepOutput.trim() || undefined,
              error: runStatus === "failed" ? runRecord?.failureCode : undefined,
              verification:
                runStatus === "completed" && dependencies.intelligence?.verify
                  ? { verified: true, reason: "verified" }
                  : { verified: false, reason: "not_run" },
              modelRounds: runRecord?.modelRounds,
              toolCalls: runRecord?.toolCalls,
            };

            if (stepResult.status === "failed") break;

            if (stepResult.status === "recovery_required") break;

            if (dependencies.intelligence?.verify && stepResult.output) {
              const verification = await dependencies.intelligence.verify(stepResult.output, step);
              stepResult.verification = { verified: verification.ok, reason: verification.ok ? "verified" : "feedback" };
              if (!verification.ok) {
                retryFeedback = verification.feedback;
                attempt++;
                emit(planId, { type: "step.retry", planId, stepId: step.id, attempt, feedback: retryFeedback });
                continue;
              }
            }
            break;
          }

          if (!stepResult) {
            stepResult = { stepId: step.id, runId: "", status: "failed", error: "no_result" };
          }

          // If verification was enabled and the last attempt was rejected,
          // the step ultimately fails (all retries exhausted).
          if (dependencies.intelligence?.verify && stepResult.output && stepResult.verification?.verified === false) {
            stepResult.status = "failed";
            stepResult.error = stepResult.error ?? "verification failed";
          }

          if (stepResult.output) {
            contextVariables.set(`step_${step.id}_output`, stepResult.output);
            emit(planId, { type: "context.variable.set", planId, key: `step_${step.id}_output`, value: stepResult.output });
          }

          recordStep(planId, step, stepResult.status, stepResult);
          if (stepResult.status === "completed") {
            emit(planId, { type: "step.completed", planId, stepId: step.id, runId: stepResult.runId });
          } else {
            emit(planId, { type: "step.failed", planId, stepId: step.id, error: stepResult.error ?? "unknown" });
          }

          return { step, result: stepResult };
        }));

        // Check for failures and conflicts.
        const failedStep = waveResults.find((r) => r.result.status === "failed" || r.result.status === "recovery_required");
        if (failedStep) {
          const finalStatus = failedStep.result.status === "recovery_required" ? "recovery_required" : "failed";
          dependencies.store.updatePlanStatus(planId, finalStatus, Date.now());
          emit(planId, { type: "plan.failed", planId, error: failedStep.result.error ?? "step failed" });
          return;
        }

        // Swarm consensus: detect conflicts and resolve.
        if (useSwarm && waveResults.length > 1) {
          const { detectConflicts, resolveConsensus } = await import("./swarm.ts");
          const conflicts = detectConflicts(waveResults.map((r) => r.result));
          if (conflicts.length > 0) {
            emit(planId, { type: "plan.conflicts", planId, conflicts } as OrchestrationEvent);
          }
          const consensus = resolveConsensus(waveResults.map((r) => r.result));
          if (consensus) {
            contextVariables.set(`wave_${wave.map((s) => s.id).join("_")}_consensus`, consensus);
          }
        }
      }

      dependencies.store.updatePlanStatus(planId, "completed", Date.now());
      emit(planId, { type: "plan.completed", planId });
    } catch (error) {
      dependencies.store.updatePlanStatus(planId, "failed", Date.now());
      emit(planId, { type: "plan.failed", planId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      active.delete(planId);
      planApprovalGate.delete(planId);
      stepApprovalGate.delete(planId);
    }
  }

  function runPlan(steps: readonly PlanStep[], context: OrchestratorContext): { planId: PlanId; done: Promise<void> } {
    const planId = context.planId ?? randomUUID();
    const controller = new AbortController();
    const contextVariables = new Map(context.contextVariables);

    active.set(planId, { planId, controller, steps, contextVariables, context });

    dependencies.store.createPlan({
      planId,
      status: "running",
      steps: steps.map((s) => s.id),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextVariables,
    });

    const done = runPlanLoop(planId);

    return { planId, done };
  }

  function getPlanResults(planId: PlanId): readonly StepRecord[] | undefined {
    if (!dependencies.store.getPlan(planId)) return undefined;
    return dependencies.store.listSteps(planId);
  }

  function interrupt(planId: PlanId): void {
    active.get(planId)?.controller.abort();
  }

  function approve(planId: PlanId, _stepId?: StepId): void {
    const planGate = planApprovalGate.get(planId);
    if (planGate) {
      planGate.resolve();
      planApprovalGate.delete(planId);
      return;
    }
    const stepGate = stepApprovalGate.get(planId);
    if (stepGate) {
      stepGate.resolve();
      stepApprovalGate.delete(planId);
    }
  }

  function reject(planId: PlanId, _stepId?: StepId, reason?: string): void {
    const message = reason ?? "rejected";
    const planGate = planApprovalGate.get(planId);
    if (planGate) {
      planGate.reject(message);
      planApprovalGate.delete(planId);
    }
    const stepGate = stepApprovalGate.get(planId);
    if (stepGate) {
      stepGate.reject(message);
      stepApprovalGate.delete(planId);
    }
    active.get(planId)?.controller.abort(new DOMException(message, "AbortError"));
  }

  function onEvent(planId: string, listener: (event: OrchestrationEvent) => void): () => void {
    let set = listeners.get(planId);
    if (!set) {
      set = new Set();
      listeners.set(planId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(planId);
    };
  }

  const generatePlan = (input: { readonly task: string; readonly providerModel: import("./contracts.ts").ProviderModelRef; readonly grant: import("./contracts.ts").CapabilityGrant; readonly capabilities: import("./contracts.ts").CapabilitySession; readonly maxSteps?: number }): readonly PlanStep[] => {
    return genPlan(input);
  };

  return { engineId: dependencies.engine.engineId, runPlan, generatePlan, getPlanResults, interrupt, approve, reject, onEvent };
}
