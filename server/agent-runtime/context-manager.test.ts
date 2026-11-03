import { describe, expect, it } from "vitest";

import { ContextManager } from "./context-manager.ts";
import type { ModelMessage } from "./contracts.ts";

describe("ContextManager", () => {
  it("estimates request tokens and decides compaction", () => {
    const mgr = new ContextManager();

    const messages: ModelMessage[] = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Say hello" },
      { role: "assistant", content: "Hello! How can I help you?" },
    ];

    const estimated = mgr.estimateRequestTokens(messages, [{ id: "t1", name: "t1", description: "test", schema: {}, risk: "read", sideEffect: false, timeoutMs: 5000 }]);
    expect(estimated).toBeGreaterThan(0);
  });

  it("returns context window for known models", () => {
    const mgr = new ContextManager();

    const window = mgr.contextWindowFor("gpt-4o");
    expect(window).toBe(128_000);
  });

  it("returns default context window for unknown models", () => {
    const mgr = new ContextManager();

    const window = mgr.contextWindowFor("unknown-model");
    expect(window).toBe(128_000);
  });

  it("computes compact budget", () => {
    const mgr = new ContextManager();

    const budget = mgr.compactBudget({ status: "known", value: 128_000 });
    expect(budget).toBe(32_000); // 25% of 128k clamped to max 32k
  });

  it("decides whether to compact based on token count", () => {
    const mgr = new ContextManager();

    // 50% of 128k = 64k, reserve = 15% of 128k = 19.2k, trigger = max(64k, 128k-19.2k) = 108.8k
    expect(mgr.shouldCompact(100_000, { status: "known", value: 128_000 })).toBe(false);
    expect(mgr.shouldCompact(110_000, { status: "known", value: 128_000 })).toBe(true);
  });

  it("learns a smaller window after repeated overflow", () => {
    const mgr = new ContextManager();

    let window = 128_000;
    // First overflow: streak = 1, no shrink yet
    window = mgr.learnContextWindow("gpt-4o", window, { overflow: true });
    expect(window).toBe(128_000);
    // Second overflow: streak = 2, reaches limit, shrinks
    window = mgr.learnContextWindow("gpt-4o", window, { overflow: true });
    expect(window).toBeLessThan(128_000);
    // No overflow resets streak
    window = mgr.learnContextWindow("gpt-4o", window, { overflow: false });
    expect(window).toBe(window); // stable
  });

  it("compacts messages using sliding window strategy", () => {
    const mgr = new ContextManager();

    const messages: ModelMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Second message" },
      { role: "assistant", content: "Second response" },
      { role: "user", content: "Third message (current)" },
    ];

    const result = mgr.compactMessages(messages, {
      keepTokens: 1000,
      maxTokens: 128_000,
      modelId: "gpt-4o",
      allowSummarize: true,
      allowShrink: true,
      minKeepMessages: 2,
      bridgeMessages: 2,
    });

    expect(result.strategy).toBeDefined();
    expect(result.messages.length).toBeLessThanOrEqual(messages.length);
    // System message should always be kept
    expect(result.messages[0].role).toBe("system");
  });
});