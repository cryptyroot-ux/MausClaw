// Planner: decomposes a goal into structured steps via an LLM model caller,
// validating the JSON output with a zod-free schema check.
// Additive port of MausClaw-Pivot's server/intelligence/planner.ts.
import { randomUUID } from "node:crypto";
import { extractJson } from "../extract-json.ts";
import type { TaskType } from "./task-classifier.ts";
import type { Plan, PlanStep, PlanStepType } from "./types.ts";
import type { ModelRouter } from "../routing/model-router.ts";
import type { Budget } from "../routing/types.ts";

export interface PlannerOptions {
  readonly maxSteps?: number;
  readonly modelRouter?: ModelRouter;
  readonly budget?: Budget;
}

const STEP_TYPES = ["tool", "think", "delegate", "verify"] as const;

const parsedPlanSchema = (v: unknown): v is { steps: ReadonlyArray<unknown> } =>
  !!v && typeof v === "object" && Array.isArray((v as { steps?: unknown }).steps);

export class Planner {
  private readonly modelCaller: (prompt: string) => Promise<string>;
  private readonly maxSteps: number;
  private readonly modelRouter: ModelRouter | undefined;
  private readonly budget: Budget;

  constructor(modelCaller: (prompt: string) => Promise<string>, options: PlannerOptions = {}) {
    this.modelCaller = modelCaller;
    this.maxSteps = Number.isFinite(options.maxSteps) ? (options.maxSteps as number) : Number.POSITIVE_INFINITY;
    this.modelRouter = options.modelRouter;
    this.budget = options.budget ?? { maxCost: Number.POSITIVE_INFINITY };
  }

  async plan(goal: string, taskType: TaskType, threadId: string = ""): Promise<Plan> {
    const prompt = [
      "You are a planning agent. Generate a structured plan as JSON.",
      `Goal: ${goal}`,
      `Task type: ${taskType}`,
      "Return an object with a \"steps\" array. Each step must have: id, description, type (tool|think|delegate|verify), expectedTools (string[]), dependencies (string[] of step ids), successCriteria (string).",
      "Do not include any other text.",
    ].join("\n");

    const raw = await this.modelCaller(prompt);

    let parsed: unknown;
    try {
      parsed = extractJson(raw, "plan");
    } catch {
      throw new Error("Invalid plan");
    }

    if (!parsedPlanSchema(parsed)) {
      throw new Error("Invalid plan");
    }

    let stepsRaw = parsed.steps as ReadonlyArray<Record<string, unknown>>;
    if (Number.isFinite(this.maxSteps) && stepsRaw.length > this.maxSteps) {
      stepsRaw = stepsRaw.slice(0, this.maxSteps);
    }

    const steps: PlanStep[] = stepsRaw.map((step) => ({
      id: String(step.id ?? ""),
      description: String(step.description ?? ""),
      type: (STEP_TYPES as ReadonlyArray<string>).includes(String(step.type)) ? (step.type as PlanStepType) : "tool",
      assignedAgent: step.assignedAgent as string | undefined,
      dependencies: Array.isArray(step.dependencies) ? (step.dependencies as ReadonlyArray<string>) : [],
      expectedTools: Array.isArray(step.expectedTools) ? (step.expectedTools as ReadonlyArray<string>) : [],
      successCriteria: String(step.successCriteria ?? ""),
      verified: false,
    }));

    const modelAssignments: Record<string, { primary: { provider: string; model: string; estimatedCost: number }; fallbacks: ReadonlyArray<string>; reasoning?: string }> = {};
    let estimatedCost = 0;
    if (this.modelRouter) {
      for (const step of steps) {
        const assignment = this.modelRouter.select(taskType, this.budget);
        modelAssignments[step.id] = assignment;
        estimatedCost += assignment.primary.estimatedCost;
      }
    }

    const requiredCapabilities = Array.from(
      new Set(steps.flatMap((step) => step.expectedTools)),
    );

    const plan: Plan = {
      id: randomUUID(),
      threadId,
      goal,
      steps,
      metadata: {
        estimatedCost,
        estimatedDuration: 0,
        requiredCapabilities,
        modelAssignments: modelAssignments as Record<string, import("../routing/types.ts").ModelAssignment>,
      },
      status: "pending",
    };

    return plan;
  }
}
