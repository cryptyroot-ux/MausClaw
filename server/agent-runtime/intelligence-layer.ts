// Intelligence Layer: composes Task Classifier + Model Router + Cost Estimator +
// Verifier + Budget Guard into a single entry point that the orchestrator calls
// before executing a plan. Gated behind a feature flag so it can be disabled
// without touching the base engine.
//
// Additive extension: MausClaw-Pivot's per-phase intelligence pipeline
// (classify → route → plan → execute → verify → done) with LLM planner,
// LLM verifier, budget guard, fallback chain, and per-phase streaming.

import type { ProviderModelRef } from "./contracts.ts";
import { type ComplexityLevel, type TaskType } from "./task-classifier.ts";
import { createModelRouter, type ModelTier, type RouteDecision, type TaskTypeRouteDecision } from "./model-router.ts";
import { estimateCost, type CostEstimate } from "./cost-estimator.ts";
import { runVerifyLoop, type VerifyLoopResult } from "./verifier.ts";
import { isIntelligenceEnabled } from "./feature-flag.ts";
import { classifyTask as classifyTaskPivot } from "./intelligence/task-classifier.ts";
import { Planner } from "./intelligence/planner.ts";
import { Executor } from "./intelligence/executor.ts";
import { Verifier } from "./intelligence/verifier.ts";
import { ModelRouter as PivotModelRouter } from "./routing/model-router.ts";
import { BudgetGuard } from "./routing/budget-guard.ts";
import { FallbackChain } from "./routing/fallback-chain.ts";
import type { Budget } from "./routing/types.ts";
import type { Plan, ExecutionResult } from "./intelligence/types.ts";

// ============================================================================
// Existing Layer 2 intelligence (unchanged, backward compatible)
// ============================================================================

export interface IntelligenceConfig {
  readonly enabled: boolean;
  readonly tiers: ModelTier;
  readonly overrides?: Partial<Record<ComplexityLevel, ReadonlyArray<ProviderModelRef>>>;
  readonly maxRetries?: number;
  readonly maxCostUsd?: number;
  /** Optional thread log sink for intelligence decisions. */
  readonly log?: (entry: { readonly kind: string; readonly detail: string }) => void;
  /** Optional Pivot-style model caller (prompt => string) for planner/verifier. */
  readonly modelCaller?: (prompt: string) => Promise<string>;
  /** Optional Pivot-style tool runner (step => unknown) for executor. */
  readonly toolRunner?: (step: unknown) => Promise<unknown>;
  /** Optional Pivot-style budget guard. */
  readonly budgetGuard?: BudgetGuard;
  /** Optional Pivot-style fallback chain. */
  readonly fallbackChain?: FallbackChain;
  /** Optional Pivot-style model router (rules + cost table). */
  readonly pivotModelRouter?: PivotModelRouter;
  /** Optional routing budget for Pivot model router. */
  readonly routingBudget?: Budget;
  /** Optional Pivot-style planner (overrides default LLM planner). */
  readonly planner?: Planner;
  /** Optional Pivot-style executor (overrides default LLM executor). */
  readonly executor?: Executor;
  /** Optional Pivot-style verifier (overrides default LLM verifier). */
  readonly verifier?: Verifier;
  /** Optional thread id for logging. */
  readonly threadId?: string;
}

export interface IntelligenceDecision {
  readonly complexity: ComplexityLevel;
  readonly taskType: TaskType;
  readonly route: RouteDecision;
  readonly taskTypeRoute: TaskTypeRouteDecision;
  readonly costEstimate: CostEstimate;
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface IntelligenceLayerStreamChunk {
  readonly phase: "classify" | "route" | "plan" | "execute" | "verify" | "done";
  readonly data?: unknown;
}

export interface IntelligenceLayerResult {
  completed: boolean;
  stepsCompleted: number;
  stepsFailed: number;
  error?: string;
  cost: number;
}

export function createIntelligenceLayer(config: IntelligenceConfig) {
  const router = createModelRouter({ tiers: config.tiers, overrides: config.overrides });

  return {
    enabled: config.enabled,

    decide(input: { text: string; messageCount?: number; toolCount?: number; hasImages?: boolean; hasCode?: boolean; messages: ReadonlyArray<{ content: string | null | undefined }>; primaryModel: ProviderModelRef }): IntelligenceDecision {
      if (!config.enabled) {
        return {
          complexity: "medium",
          taskType: "conversation" as TaskType,
          route: { complexity: "medium", tier: "standard", candidates: [input.primaryModel] },
          taskTypeRoute: { taskType: "conversation" as TaskType, tier: "standard", candidates: [input.primaryModel] },
          costEstimate: estimateCost({ messages: input.messages, model: input.primaryModel.modelId }),
          allowed: true,
        };
      }
      const route = router.route({
        text: input.text,
        messageCount: input.messageCount,
        toolCount: input.toolCount,
        hasImages: input.hasImages,
        hasCode: input.hasCode,
      });
      const taskTypeRoute = router.routeByTaskType(input.text);
      const effectiveRoute = taskTypeRoute.candidates.length > 0 ? taskTypeRoute : route;
      const candidate = effectiveRoute.candidates[0] ?? input.primaryModel;
      const costEstimate = estimateCost({ messages: input.messages, model: candidate.modelId });
      const allowed = config.maxCostUsd === undefined || costEstimate.estimatedCostUsd <= config.maxCostUsd;
      config.log?.({ kind: "intelligence.decide", detail: JSON.stringify({ complexity: route.complexity, taskType: taskTypeRoute.taskType, tier: effectiveRoute.tier, allowed, estimatedCostUsd: costEstimate.estimatedCostUsd }) });
      return {
        complexity: route.complexity,
        taskType: taskTypeRoute.taskType,
        route,
        taskTypeRoute,
        costEstimate,
        allowed,
        reason: allowed ? undefined : `Estimated cost ${costEstimate.estimatedCostUsd.toFixed(4)} exceeds budget ${config.maxCostUsd}`,
      };
    },

    async verify(_output: string, verifyFn: (o: string) => Promise<{ ok: boolean; feedback: string }>, execute: (attempt: number, feedback?: string) => Promise<string>): Promise<VerifyLoopResult> {
      if (!config.enabled) {
        const o = await execute(0);
        return { ok: true, attempts: 1, lastFeedback: "", outputs: [o] };
      }
      return runVerifyLoop(execute, { maxRetries: config.maxRetries ?? 2, verify: verifyFn });
    },

    // ========================================================================
    // Pivot-style per-phase intelligence pipeline with streaming
    // ========================================================================

    async *processStream(
      brief: string,
      threadId: string = config.threadId ?? "",
    ): AsyncGenerator<IntelligenceLayerStreamChunk, IntelligenceLayerResult> {
      const tid = threadId;
      const enabled = isIntelligenceEnabled(
        {
          intelligenceLayer: config.enabled ? true : undefined,
          intelligence: { enabled: config.enabled ? true : undefined },
        } as Record<string, unknown>,
      );

      if (!enabled) {
        const r: IntelligenceLayerResult = { completed: false, stepsCompleted: 0, stepsFailed: 0, error: "intelligence layer disabled", cost: 0 };
        yield { phase: "done", data: r };
        return r;
      }

      let cost = 0;
      let modelCaller = config.modelCaller;
      let toolRunner = config.toolRunner;
      let budgetGuard = config.budgetGuard ?? new BudgetGuard();
      let routingBudget = config.routingBudget ?? { maxCost: Number.POSITIVE_INFINITY };

      // Lazy build model caller from config if not provided (needs adapter + modelId; caller must be supplied).
      // Lazy build planner/executor/verifier if modelCaller/toolRunner available.
      let planner = config.planner;
      let executor = config.executor;
      let verifier = config.verifier;
      let pivotRouter = config.pivotModelRouter;

      let assignment: { primary?: { model: string; estimatedCost: number }; fallbacks?: ReadonlyArray<string>; reasoning?: string } | undefined;

      try {
        // 1. classify
        const taskType = classifyTaskPivot(brief);
        yield { phase: "classify", data: { taskType } };

        // 2. route
        if (pivotRouter) {
          try {
            assignment = pivotRouter.select(taskType, routingBudget);
            cost += assignment.primary?.estimatedCost ?? 0;
            const allowed = budgetGuard.check(assignment, tid);
            if (!allowed) {
              const r: IntelligenceLayerResult = { completed: false, stepsCompleted: 0, stepsFailed: 0, error: "budget exceeded", cost };
              yield { phase: "done", data: r };
              return r;
            }
            budgetGuard.record(assignment, tid);
          } catch {
            // routing failure is non-fatal; proceed without router assignment
          }
        }
        yield { phase: "route", data: { model: assignment?.primary?.model } };

        // 3. plan
        if (!planner && modelCaller) {
          planner = new Planner(modelCaller, {
            maxSteps: config.maxRetries,
            modelRouter: pivotRouter,
            budget: routingBudget,
          });
        }
        if (!planner) {
          throw new Error("No planner available");
        }
        const plan: Plan = await planner.plan(brief, taskType, tid);
        yield { phase: "plan", data: { planId: plan.id, steps: plan.steps.length } };

        // 4. execute
        if (!executor && toolRunner) {
          executor = new Executor(toolRunner, verifier);
        }
        if (verifier && toolRunner && !executor) {
          executor = new Executor(toolRunner, verifier);
        }
        if (!executor) {
          throw new Error("No executor available");
        }
        const execResult: ExecutionResult = await executor.execute(plan);
        yield { phase: "execute", data: { completedSteps: execResult.completedSteps, failedSteps: execResult.failedSteps } };

        // 5. verification logging
        for (const outcome of execResult.outcomes ?? execResult.steps ?? []) {
          const verification = (outcome as { verification?: { verified: boolean; confidence: number } }).verification;
          if (verification) {
            // no-op: verification already recorded by executor; hook available for logging
          }
        }
        yield { phase: "verify", data: {} };

        const planCost = typeof (plan as { metadata?: { estimatedCost?: number } }).metadata?.estimatedCost === "number"
          ? (plan as { metadata?: { estimatedCost?: number } }).metadata!.estimatedCost!
          : 0;
        if (planCost > 0) cost = planCost;

        const failed = execResult.failedSteps ?? 0;
        const completedSteps = execResult.completedSteps ?? 0;
        const success = execResult.success === true && failed === 0;

        // 6. fallback on failure
        if (!success && config.fallbackChain) {
          try {
            await config.fallbackChain.execute(assignment ?? "", [], { threadId: tid });
          } catch {
            // ignore fallback failures
          }
        }

        let error: string | undefined;
        if (!success) {
          const firstFailed = (execResult.outcomes ?? execResult.steps ?? []).find((o: any) => o?.status === "failed" || o?.ok === false);
          error = (firstFailed as any)?.error ?? "execution failed";
        }

        const r: IntelligenceLayerResult = {
          completed: success,
          stepsCompleted: completedSteps,
          stepsFailed: failed,
          error,
          cost,
        };
        yield { phase: "done", data: r };
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const r: IntelligenceLayerResult = {
          completed: false,
          stepsCompleted: 0,
          stepsFailed: 0,
          error: message,
          cost,
        };
        yield { phase: "done", data: r };
        return r;
      }
    },

    async process(brief: string, threadId: string = config.threadId ?? ""): Promise<IntelligenceLayerResult> {
      const gen = this.processStream(brief, threadId);
      let r: IntelligenceLayerResult | undefined;
      while (true) {
        const { value, done } = await gen.next();
        if (done) {
          r = value as IntelligenceLayerResult;
          break;
        }
      }
      return r!;
    },
  };
}