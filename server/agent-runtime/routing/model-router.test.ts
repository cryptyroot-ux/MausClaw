import { describe, it, expect } from "vitest";
import { ModelRouter } from "./model-router.ts";
import type { ModelCost, RoutingRule } from "./types.ts";
import type { TaskType } from "../intelligence/task-classifier.ts";

describe("ModelRouter", () => {
  const costTable: Record<string, ModelCost> = {
    "cheap-model": { input: 0.1, output: 0.2 },
    "standard-model": { input: 1.0, output: 2.0 },
    "premium-model": { input: 5.0, output: 10.0 },
  };

  const rules: Record<string, RoutingRule> = {
    coding: { primary: "premium-model", fallbacks: ["standard-model", "cheap-model"], provider: "anthropic" },
    general: { primary: "standard-model", fallbacks: ["cheap-model"], provider: "openai" },
  };

  it("selects primary model within budget", () => {
    const router = new ModelRouter({ rules, costTable });
    const assignment = router.select("coding", { maxCost: 20 });
    expect(assignment.primary.model).toBe("premium-model");
    expect(assignment.fallbacks).toContain("standard-model");
  });

  it("falls back when primary exceeds budget", () => {
    const router = new ModelRouter({ rules, costTable });
    const assignment = router.select("coding", { maxCost: 5 });
    expect(assignment.primary.model).toBe("standard-model");
  });

  it("throws when no model fits budget", () => {
    const router = new ModelRouter({ rules, costTable });
    expect(() => router.select("coding", { maxCost: 0.01 })).toThrow("No model fits budget");
  });

  it("uses general rule for unknown task type", () => {
    const router = new ModelRouter({ rules, costTable });
    const assignment = router.select("unknown" as TaskType, { maxCost: 20 });
    expect(assignment.primary.model).toBe("standard-model");
  });

  // M8: provider must be populated, never empty string
  it("populates provider from routing rule (not empty)", () => {
    const rulesWithProvider: Record<string, RoutingRule> = {
      coding: { primary: "premium-model", fallbacks: ["standard-model"], provider: "anthropic" },
      general: { primary: "standard-model", fallbacks: ["cheap-model"], provider: "openai" },
    };
    const router = new ModelRouter({ rules: rulesWithProvider, costTable });
    const assignment = router.select("coding", { maxCost: 20 });
    expect(assignment.primary.provider).toBe("anthropic");
    expect(assignment.primary.provider).not.toBe("");
  });

  it("rejects rule with empty provider (M8: hard-coded routes not allowed)", () => {
    const rulesWithEmptyProvider: Record<string, RoutingRule> = {
      coding: { primary: "premium-model", fallbacks: [], provider: "" },
    };
    expect(() => new ModelRouter({ rules: rulesWithEmptyProvider, costTable })).toThrow(/provider/);
  });
});
