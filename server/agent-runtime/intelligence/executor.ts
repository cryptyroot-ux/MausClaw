// Executor: runs plan steps in dependency order with an optional verifier.
// Additive port of MausClaw-Pivot's server/intelligence/executor.ts.
import type { Plan, PlanStep, VerificationResult } from "./types.ts";
import { Verifier as VerifierImpl } from "./verifier.ts";
import type { StepExecutionOutcome, ExecutionResult, StepExecutionStatus } from "./types.ts";

export type ToolRunner = (step: PlanStep) => Promise<unknown>;

export interface ExecutorStreamChunk {
  readonly phase: "execute" | "verify";
  readonly stepId: string;
  readonly delta?: string;
  readonly result?: ExecutionResult;
}

type VerifierLike = { verify: (step: PlanStep, threadId?: string) => Promise<VerificationResult> };

function resolveVerifier(candidate: unknown, fallback?: unknown): VerifierLike | undefined {
  const tryOne = (value: unknown): VerifierLike | undefined => {
    if (value == null) return undefined;
    if (typeof value === "function") {
      return new VerifierImpl(value as (prompt: string) => Promise<string>);
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.verify === "function") return obj as VerifierLike;
      if (typeof obj.modelCaller === "function") {
        return new VerifierImpl(obj.modelCaller as (prompt: string) => Promise<string>);
      }
      if (typeof obj.model === "function") {
        return new VerifierImpl(obj.model as (prompt: string) => Promise<string>);
      }
      if (obj.verifier != null) return tryOne(obj.verifier);
    }
    return undefined;
  };

  return tryOne(candidate) ?? tryOne(fallback);
}

export class Executor {
  private readonly toolRunner: ToolRunner;
  private readonly verifier: VerifierLike | undefined;

  constructor(
    toolRunner: ToolRunner,
    verifierOrOptions?: VerifierImpl | ((prompt: string) => Promise<string>) | Record<string, unknown>,
    options?: Record<string, unknown>,
  ) {
    this.toolRunner = toolRunner;
    this.verifier = resolveVerifier(verifierOrOptions, options);
  }

  async *executeStream(plan: Plan): AsyncGenerator<ExecutorStreamChunk, ExecutionResult> {
    plan.status = "executing";

    const originalIndex = new Map(plan.steps.map((step, index) => [step.id, index]));
    const sorted = this.topologicalSort(plan.steps);

    const status = new Map<string, StepExecutionStatus>();
    const outcomes: StepExecutionOutcome[] = [];

    let completedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

    for (const step of sorted) {
      const dependencies = Array.isArray(step.dependencies) ? step.dependencies : [];
      const unmet = dependencies.some((dep) => status.get(dep) !== "completed");

      if (unmet) {
        status.set(step.id, "skipped");
        skippedSteps += 1;
        outcomes.push(this.makeOutcome(step, "skipped", undefined, undefined, "unmet dependencies"));
        continue;
      }

      let toolResult: unknown;
      let failed = false;
      let error: string | undefined;

      try {
        const runnerResult = this.toolRunner(step);
        if (runnerResult && typeof runnerResult === "object" && Symbol.asyncIterator in runnerResult) {
          for await (const chunk of runnerResult as unknown as AsyncGenerator<{ delta?: string; [key: string]: any }>) {
            if (chunk.delta) {
              yield { phase: "execute", stepId: step.id, delta: chunk.delta } as ExecutorStreamChunk;
            }
          }
          toolResult = { ok: true };
        } else {
          toolResult = await runnerResult;
        }
        if (!this.isSuccess(toolResult)) {
          failed = true;
          error = this.extractError(toolResult);
        }
      } catch (err) {
        failed = true;
        toolResult = undefined;
        error = err instanceof Error ? err.message : String(err);
      }

      step.result = toolResult;

      if (failed) {
        status.set(step.id, "failed");
        failedSteps += 1;
        outcomes.push(this.makeOutcome(step, "failed", toolResult, undefined, error));
        continue;
      }

      let verification: VerificationResult | undefined;
      if (this.verifier) {
        try {
          verification = await this.verifier.verify(step, "");
        } catch {
          verification = { verified: false, evidence: "", confidence: 0 };
        }
        step.verified = verification.verified;
        if (!verification.verified) {
          failed = true;
        }
      }

      if (failed) {
        status.set(step.id, "failed");
        failedSteps += 1;
        outcomes.push(this.makeOutcome(step, "failed", toolResult, verification, "verification failed"));
        continue;
      }

      status.set(step.id, "completed");
      completedSteps += 1;
      outcomes.push(this.makeOutcome(step, "completed", toolResult, verification));
    }

    outcomes.sort((a, b) => (originalIndex.get(a.stepId) ?? 0) - (originalIndex.get(b.stepId) ?? 0));

    plan.status = failedSteps > 0 ? "failed" : "completed";

    const success = failedSteps === 0 && skippedSteps === 0;

    const result: ExecutionResult = {
      planId: plan.id,
      threadId: plan.threadId,
      completedSteps,
      failedSteps,
      skippedSteps,
      totalSteps: plan.steps.length,
      success,
      ok: success,
      outcomes,
      stepResults: outcomes,
      results: outcomes,
      steps: outcomes,
    };

    yield { phase: "execute", stepId: "", result } as ExecutorStreamChunk;
    return result;
  }

  async execute(plan: Plan): Promise<ExecutionResult> {
    plan.status = "executing";

    const originalIndex = new Map(plan.steps.map((step, index) => [step.id, index]));
    const sorted = this.topologicalSort(plan.steps);

    const status = new Map<string, StepExecutionStatus>();
    const outcomes: StepExecutionOutcome[] = [];

    let completedSteps = 0;
    let failedSteps = 0;
    let skippedSteps = 0;

    for (const step of sorted) {
      const dependencies = Array.isArray(step.dependencies) ? step.dependencies : [];
      const unmet = dependencies.some((dep) => status.get(dep) !== "completed");

      if (unmet) {
        status.set(step.id, "skipped");
        skippedSteps += 1;
        outcomes.push(this.makeOutcome(step, "skipped", undefined, undefined, "unmet dependencies"));
        continue;
      }

      let toolResult: unknown;
      let failed = false;
      let error: string | undefined;

      try {
        toolResult = await this.toolRunner(step);
        if (!this.isSuccess(toolResult)) {
          failed = true;
          error = this.extractError(toolResult);
        }
      } catch (err) {
        failed = true;
        toolResult = undefined;
        error = err instanceof Error ? err.message : String(err);
      }

      step.result = toolResult;

      if (failed) {
        status.set(step.id, "failed");
        failedSteps += 1;
        outcomes.push(this.makeOutcome(step, "failed", toolResult, undefined, error));
        continue;
      }

      let verification: VerificationResult | undefined;
      if (this.verifier) {
        try {
          verification = await this.verifier.verify(step, "");
        } catch {
          verification = { verified: false, evidence: "", confidence: 0 };
        }
        step.verified = verification.verified;
        if (!verification.verified) {
          failed = true;
        }
      }

      if (failed) {
        status.set(step.id, "failed");
        failedSteps += 1;
        outcomes.push(this.makeOutcome(step, "failed", toolResult, verification, "verification failed"));
        continue;
      }

      status.set(step.id, "completed");
      completedSteps += 1;
      outcomes.push(this.makeOutcome(step, "completed", toolResult, verification));
    }

    outcomes.sort((a, b) => (originalIndex.get(a.stepId) ?? 0) - (originalIndex.get(b.stepId) ?? 0));

    plan.status = failedSteps > 0 ? "failed" : "completed";

    const success = failedSteps === 0 && skippedSteps === 0;

    return {
      planId: plan.id,
      threadId: plan.threadId,
      completedSteps,
      failedSteps,
      skippedSteps,
      totalSteps: plan.steps.length,
      success,
      ok: success,
      outcomes,
      stepResults: outcomes,
      results: outcomes,
      steps: outcomes,
    };
  }

  private makeOutcome(
    step: PlanStep,
    status: StepExecutionStatus,
    result: unknown,
    verification: VerificationResult | undefined,
    error?: string,
  ): StepExecutionOutcome {
    return {
      stepId: step.id,
      id: step.id,
      status,
      ok: status === "completed",
      result,
      output: result,
      verification,
      verified: verification?.verified ?? (status === "completed" && !this.verifier ? step.verified : undefined),
      error,
      skippedReason: status === "skipped" ? error : undefined,
    };
  }

  private isSuccess(result: unknown): boolean {
    if (result == null) return true;
    if (typeof result === "boolean") return result;
    if (typeof result !== "object") return true;
    const obj = result as Record<string, unknown>;
    if (typeof obj.ok === "boolean") return obj.ok;
    if (typeof obj.success === "boolean") return obj.success;
    if (typeof obj.verified === "boolean") return obj.verified;
    if (obj.isError === true) return false;
    return true;
  }

  private extractError(result: unknown): string {
    if (result && typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (typeof obj.error === "string") return obj.error;
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.message === "string") return obj.message;
    }
    return "step failed";
  }

  private topologicalSort(steps: ReadonlyArray<PlanStep>): PlanStep[] {
    const index = new Map(steps.map((step, i) => [step.id, i]));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
      const deps = (step.dependencies ?? []).filter((dep) => index.has(dep));
      indegree.set(step.id, deps.length);
      for (const dep of deps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(step.id);
      }
    }

    const ready: string[] = steps
      .filter((step) => (indegree.get(step.id) ?? 0) === 0)
      .map((step) => step.id)
      .sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));

    const sortedIds: string[] = [];
    const remaining = new Set(steps.map((step) => step.id));

    while (ready.length > 0) {
      const id = ready.shift()!;
      if (!remaining.has(id)) continue;
      remaining.delete(id);
      sortedIds.push(id);

      const deps = dependents.get(id) ?? [];
      for (const depId of deps) {
        if (!remaining.has(depId)) continue;
        const next = (indegree.get(depId) ?? 0) - 1;
        indegree.set(depId, next);
        if (next === 0) {
          ready.push(depId);
          ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
        }
      }
    }

    // Append any remaining (cycles) in original order.
    for (const step of steps) {
      if (remaining.has(step.id)) {
        remaining.delete(step.id);
        sortedIds.push(step.id);
      }
    }

    const byId = new Map(steps.map((step) => [step.id, step]));
    return sortedIds.map((id) => byId.get(id)!).filter(Boolean);
  }
}
