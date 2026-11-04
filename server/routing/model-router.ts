// server/routing/model-router.ts

import type { TaskType } from "../intelligence/task-classifier.ts";
import type { Budget, ModelAssignment, ModelCost, RoutingRule } from "./types.ts";

export interface ModelRouterConfig {
  rules: Record<string, RoutingRule>;
  costTable: Record<string, ModelCost>;
  qualityScores?: Record<string, number>;
  scores?: Record<string, number>;
  quality?: Record<string, number>;
}

export class ModelRouter {
  private readonly rules: Record<string, RoutingRule>;
  private readonly costTable: Record<string, ModelCost>;
  private readonly qualityScores: Record<string, number> | undefined;

  constructor(config: ModelRouterConfig) {
    this.rules = config.rules;
    this.costTable = config.costTable;
    this.qualityScores = config.qualityScores ?? config.scores ?? config.quality;
    // M8: reject hard-coded cross-provider routes. Every rule must declare a
    // non-empty provider so fallbacks only select from configured providers.
    for (const [taskType, rule] of Object.entries(this.rules)) {
      if (!rule.provider || rule.provider.trim() === "") {
        throw new Error(`routing rule for "${taskType}" must declare a non-empty provider`);
      }
    }
  }

  select(taskType: TaskType, budget: Budget): ModelAssignment {
    const rule = this.rules[taskType] ?? this.rules.general;
    if (!rule) {
      throw new Error("No model fits budget");
    }

    const qualityMap: Record<string, number> = {};
    if (this.qualityScores) {
      Object.assign(qualityMap, this.qualityScores);
    }
    if (rule.qualityScores) {
      Object.assign(qualityMap, rule.qualityScores);
    }

    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const model of [rule.primary, ...rule.fallbacks]) {
      if (seen.has(model)) continue;
      seen.add(model);
      candidates.push(model);
    }

    const costOf = (model: string): number => {
      const cost = this.costTable[model];
      if (!cost) return Infinity;
      return cost.input + cost.output;
    };

    const qualityOf = (model: string, index: number): number => {
      if (Object.prototype.hasOwnProperty.call(qualityMap, model)) {
        return qualityMap[model] as number;
      }
      return candidates.length - index;
    };

    const viable = candidates.filter((model) => costOf(model) <= budget.maxCost);
    if (viable.length === 0) {
      throw new Error("No model fits budget");
    }

    const ranked = viable
      .map((model) => ({
        model,
        quality: qualityOf(model, candidates.indexOf(model)),
        index: candidates.indexOf(model),
      }))
      .sort((a, b) => b.quality - a.quality || a.index - b.index);

    const primaryModel = ranked[0].model;
    const fallbackModels = ranked.slice(1).map((entry) => entry.model);

    return {
      primary: {
        provider: rule.provider,
        model: primaryModel,
        estimatedCost: costOf(primaryModel),
      },
      fallbacks: fallbackModels,
      reasoning: `selected ${primaryModel} for ${taskType} within budget ${budget.maxCost}`,
    };
  }
}
