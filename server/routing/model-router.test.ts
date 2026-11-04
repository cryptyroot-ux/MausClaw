// server/routing/model-router.test.ts
import { describe, it, expect } from "vitest";
import { ModelRouter } from "./model-router.ts";

describe("ModelRouter", () => {
  const router = new ModelRouter({
    rules: {
      coding: { primary: "claude-sonnet-4", fallbacks: ["gpt-4o", "llama-3.3-70b"], provider: "anthropic" },
      research: { primary: "gpt-4o", fallbacks: ["claude-sonnet-4"], provider: "openai" },
      general: { primary: "llama-3.3-70b", fallbacks: ["gpt-4o-mini"], provider: "meta" },
    },
    costTable: {
      "claude-sonnet-4": { input: 3, output: 15 },  // $/M tokens
      "gpt-4o": { input: 2.5, output: 10 },
      "llama-3.3-70b": { input: 0.1, output: 0.2 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
    },
  });

  it("selects primary model for coding task", () => {
    const assignment = router.select("coding", { maxCost: 100 });
    expect(assignment.primary.model).toBe("claude-sonnet-4");
  });

  it("falls back to cheaper model when budget exceeded", () => {
    const assignment = router.select("coding", { maxCost: 0.5 });
    expect(assignment.primary.model).toBe("llama-3.3-70b");
  });

  it("returns fallback chain", () => {
    const assignment = router.select("coding", { maxCost: 100 });
    expect(assignment.fallbacks).toContain("gpt-4o");
  });

  it("throws when no model fits budget", () => {
    expect(() => router.select("coding", { maxCost: 0.001 })).toThrow("No model fits budget");
  });

  // M8: provider must be populated, never empty string
  it("populates provider from routing rule (not empty)", () => {
    const assignment = router.select("coding", { maxCost: 100 });
    expect(assignment.primary.provider).toBe("anthropic");
    expect(assignment.primary.provider).not.toBe("");
  });
});