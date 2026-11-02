import { describe, it, expect, beforeEach } from "vitest";
import {
  contextWindowFor,
  compactBudget,
  learnContextWindow,
  shouldCompact,
  threadTokens,
} from "./context-budget.ts";
import { countTokens } from "../drivers/tokenizer.ts";
import type { CapabilityLimit } from "./contracts.ts";

const known: CapabilityLimit = { status: "known", value: 128_000 };
const unknown: CapabilityLimit = { status: "unknown" };

function resetOverflow(modelId: string) {
  learnContextWindow(modelId, contextWindowFor(modelId), { overflow: false });
}

describe("contextWindowFor", () => {
  it("returns the known window for known model families", () => {
    for (const model of [
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.5",
      "gpt-5",
      "gpt-6",
      "o1",
      "o5",
      "o9",
      "chatgpt-4o",
      "codex",
    ]) {
      expect(contextWindowFor(model)).toBe(128_000);
    }
  });

  it("ignores provider prefixes and case", () => {
    expect(contextWindowFor("openai/gpt-4o")).toBe(128_000);
    expect(contextWindowFor("GPT-5")).toBe(128_000);
  });

  it("returns the 128000 default for unknown models", () => {
    expect(contextWindowFor("claude-3-opus")).toBe(128_000);
    expect(contextWindowFor("llama-3.1-70b")).toBe(128_000);
    expect(contextWindowFor("no-such-model")).toBe(128_000);
  });
});

describe("compactBudget", () => {
  it("returns 25% of a known window", () => {
    expect(compactBudget({ status: "known", value: 100_000 })).toBe(25_000);
    expect(compactBudget({ status: "known", value: 128_000 })).toBe(32_000);
  });

  it("clamps to [8000, 32000]", () => {
    expect(compactBudget({ status: "known", value: 20_000 })).toBe(8_000);
    expect(compactBudget({ status: "known", value: 200_000 })).toBe(32_000);
    expect(compactBudget({ status: "known", value: 32_000 })).toBe(8_000);
    expect(compactBudget({ status: "known", value: 128_001 })).toBe(32_000);
  });

  it("uses the default window for unknown limits", () => {
    expect(compactBudget(unknown)).toBe(32_000);
  });
});

describe("learnContextWindow", () => {
  beforeEach(() => {
    resetOverflow("gpt-4o");
  });

  it("is stable when there is no overflow", () => {
    expect(learnContextWindow("gpt-4o", 128_000, { overflow: false })).toBe(128_000);
    expect(learnContextWindow("gpt-4o", 96_000, { overflow: false })).toBe(96_000);
  });

  it("does not shrink after a single overflow", () => {
    expect(learnContextWindow("gpt-4o", 128_000, { overflow: true })).toBe(128_000);
  });

  it("shrinks downward after repeated overflow", () => {
    learnContextWindow("gpt-4o", 128_000, { overflow: true });
    expect(learnContextWindow("gpt-4o", 128_000, { overflow: true })).toBe(96_000);
  });

  it("is stable at the new window once overflow stops", () => {
    learnContextWindow("gpt-4o", 128_000, { overflow: true });
    learnContextWindow("gpt-4o", 128_000, { overflow: true }); // -> 96000
    expect(learnContextWindow("gpt-4o", 96_000, { overflow: false })).toBe(96_000);
    expect(learnContextWindow("gpt-4o", 96_000, { overflow: false })).toBe(96_000);
  });

  it("resets the streak after a non-overflow observation", () => {
    learnContextWindow("gpt-4o", 128_000, { overflow: true });
    learnContextWindow("gpt-4o", 128_000, { overflow: false });
    expect(learnContextWindow("gpt-4o", 128_000, { overflow: true })).toBe(128_000);
  });

  it("tracks overflow streaks per model independently", () => {
    learnContextWindow("gpt-4o", 128_000, { overflow: true });
    expect(learnContextWindow("claude-3-opus", 128_000, { overflow: true })).toBe(128_000);
    expect(learnContextWindow("gpt-4o", 128_000, { overflow: true })).toBe(96_000);
  });

  it("never shrinks below the floor under repeated overflow", () => {
    let window = 128_000;
    for (let i = 0; i < 50; i++) {
      window = learnContextWindow("gpt-4o", window, { overflow: true });
    }
    expect(window).toBeGreaterThanOrEqual(8_192);
    expect(window).toBeLessThan(128_000);
  });
});

describe("shouldCompact", () => {
  it("triggers at max(50% of window, window - 15% reserve) for known windows", () => {
    // reserve = max(16000, 0.15 * 128000) = 19200; trigger = max(64000, 108800) = 108800
    expect(shouldCompact(108_800, known)).toBe(false);
    expect(shouldCompact(108_801, known)).toBe(true);
    expect(shouldCompact(50_000, known)).toBe(false);
  });

  it("uses the default window for unknown limits", () => {
    expect(shouldCompact(108_800, unknown)).toBe(false);
    expect(shouldCompact(108_801, unknown)).toBe(true);
  });

  it("applies the 16k reserve floor for small windows", () => {
    const small: CapabilityLimit = { status: "known", value: 20_000 };
    // reserve = max(16000, 3000) = 16000; trigger = max(10000, 4000) = 10000
    expect(shouldCompact(10_000, small)).toBe(false);
    expect(shouldCompact(10_001, small)).toBe(true);
  });

  it("always triggers above the reserve floor window", () => {
    const tiny: CapabilityLimit = { status: "known", value: 24_000 };
    // reserve = 16000; trigger = max(12000, 8000) = 12000
    expect(shouldCompact(12_001, tiny)).toBe(true);
  });
});

describe("threadTokens", () => {
  it("counts zero tokens for an empty thread", () => {
    expect(threadTokens([], "gpt-4o")).toBe(0);
  });

  it("counts tokens, not bytes", () => {
    const texts = ["hello world", "how are you"];
    expect(threadTokens(texts, "gpt-4o")).toBe(
      countTokens("hello world", "gpt-4o") + countTokens("how are you", "gpt-4o"),
    );
  });

  it("uses fewer tokens than bytes for multibyte text", () => {
    const emojis = "🚀🚀🚀";
    expect(threadTokens([emojis], "gpt-4o")).toBeLessThan(emojis.length);
  });

  it("is model-aware", () => {
    const text = "hello world";
    expect(threadTokens([text], "gpt-4o")).toBe(threadTokens([text], "gpt-4o"));
    expect(threadTokens([text], "unknown-model")).toBeGreaterThan(0);
  });
});
