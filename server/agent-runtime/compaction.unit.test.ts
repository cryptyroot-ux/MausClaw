import { describe, it, expect, beforeEach } from "vitest";
import {
  compactMessages,
  compactionTrigger,
  planRecovery,
  estimateMessagesTokens,
  type CompactionOptions,
} from "./compaction.ts";
import type { ModelMessage } from "./contracts.ts";
import {
  contextWindowFor,
  learnContextWindow,
} from "./context-budget.ts";

function resetOverflow(modelId: string) {
  learnContextWindow(modelId, contextWindowFor(modelId), { overflow: false });
}

function variedMessage(index: number, chars: number): ModelMessage {
  const filler = "alpha beta gamma delta epsilon zeta eta theta ".repeat(Math.ceil(chars / 32));
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn-${index} ${filler.slice(0, chars)}`,
  };
}

function totalTokens(messages: readonly ModelMessage[], modelId?: string): number {
  return estimateMessagesTokens(messages, modelId);
}

const baseOptions: CompactionOptions = {
  keepTokens: 32_000,
  maxTokens: 128_000,
  modelId: "gpt-4o",
  allowShrink: false,
  allowSummarize: false,
  minKeepMessages: 2,
  bridgeMessages: 2,
};

describe("compactionTrigger", () => {
  const window = 128_000;
  // reserve = max(16000, floor(128000 * 0.15)) = 19200;
  // base = max(floor(128000 / 2), 128000 - 19200) = max(64000, 108800) = 108800
  const normal = 108_800;

  it("keeps the normal trigger at healthy headroom (>= 0.3, including > 0.7)", () => {
    expect(compactionTrigger(0.3, window)).toBe(normal);
    expect(compactionTrigger(0.5, window)).toBe(normal);
    expect(compactionTrigger(0.7, window)).toBe(normal);
    expect(compactionTrigger(1.0, window)).toBe(normal);
  });

  it("lowers the trigger under memory pressure (headroom < 0.3)", () => {
    const pressured = compactionTrigger(0.1, window);
    expect(pressured).toBeGreaterThan(0);
    expect(pressured).toBeLessThan(normal);
  });

  it("scales the trigger linearly with headroom below 0.3", () => {
    expect(compactionTrigger(0.15, window)).toBe(Math.floor(normal * 0.5));
    expect(compactionTrigger(0.0, window)).toBe(0);
  });

  it("never returns a negative trigger", () => {
    expect(compactionTrigger(0.05, window)).toBeGreaterThanOrEqual(0);
    expect(compactionTrigger(0.29, window)).toBeGreaterThan(compactionTrigger(0.1, window));
  });
});

describe("adaptive keepTokens (model-aware)", () => {
  beforeEach(() => {
    resetOverflow("gpt-4o");
  });

  it("derives keepTokens from the model window instead of the passed value", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 100; i++) messages.push(variedMessage(i, 1500));
    const total = totalTokens(messages, "gpt-4o");

    // gpt-4o window = 128000, compactBudget => 32000. total sits between them.
    expect(total).toBeGreaterThan(32_000);
    expect(total).toBeLessThan(90_000);

    // With modelId, the adaptive budget (~32k) forces compaction.
    const adaptive = compactMessages(messages, {
      ...baseOptions,
      keepTokens: 90_000,
    });
    expect(adaptive.strategy).not.toBe("none");

    // Without modelId, the large configured budget means no compaction.
    const plain = compactMessages(messages, {
      keepTokens: 90_000,
      maxTokens: 128_000,
      allowShrink: false,
      allowSummarize: false,
      minKeepMessages: 2,
      bridgeMessages: 2,
    });
    expect(plain.strategy).toBe("none");
  });

  it("keeps the compaction result within the adaptive budget", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 100; i++) messages.push(variedMessage(i, 1500));
    const result = compactMessages(messages, {
      ...baseOptions,
      keepTokens: 90_000,
    });
    const kept = totalTokens(result.messages, "gpt-4o");
    expect(kept).toBeLessThanOrEqual(33_000);
  });

  it("lowers the effective window after repeated overflow", () => {
    const messages: ModelMessage[] = [];
    for (let i = 0; i < 100; i++) messages.push(variedMessage(i, 1500));
    const opts: CompactionOptions = {
      ...baseOptions,
      keepTokens: 30_000,
    };
    const first = compactMessages(messages, opts);
    const second = compactMessages(messages, opts);
    // Second overflow streak shrank the window (128k -> 96k => budget 24k),
    // so the second compaction keeps no more than the first.
    const firstKept = totalTokens(first.messages, "gpt-4o");
    const secondKept = totalTokens(second.messages, "gpt-4o");
    expect(secondKept).toBeLessThanOrEqual(firstKept + 200);
    expect(secondKept).toBeLessThanOrEqual(26_000);
  });
});

describe("shrink tier", () => {
  // lastUser + one huge tool output in the bridge, other messages dropped;
  // keeps the kept body over budget so the shrink tier is reached.
  const toolOutput = Array.from({ length: 100 }, (_, i) =>
    `line ${i}: ${"segment content heresegment content here".repeat(2)}`,
  ).join("\n");
  const baseMessages: ModelMessage[] = [
    { role: "user", content: "small opener" },
    { role: "assistant", content: "", toolCalls: [{ name: "t", id: "c1", arguments: {} }] },
    { role: "tool", toolCallId: "c1", content: toolOutput },
    { role: "user", content: "final turn" },
  ];

  const shrinkBase: CompactionOptions = {
    ...baseOptions,
    allowShrink: true,
    bridgeMessages: 1, // keep the huge tool output in the seed
  };

  it("truncates kept tool output at a line boundary within SHORT_TOOL_CHARS", () => {
    const result = compactMessages(baseMessages, {
      ...shrinkBase,
      keepTokens: 1_000,
    });
    expect(result.strategy).toBe("shrink");
    expect(result.droppedCount).toBeGreaterThan(0);
    const tool = result.messages.find((m) => m.role === "tool");
    const content = typeof tool?.content === "string" ? tool.content : "";
    expect(content).toContain("[tool output shortened");
    const beforeNotice = content.split("\n[tool output shortened")[0];
    expect(beforeNotice.length).toBeLessThanOrEqual(2_000);
    expect(beforeNotice.endsWith("\n")).toBe(true);
  });

  it("applies progressive truncation when still over budget", () => {
    const result = compactMessages(baseMessages, {
      ...shrinkBase,
      keepTokens: 300,
    });
    expect(result.strategy).toBe("shrink");
    const tool = result.messages.find((m) => m.role === "tool");
    const content = typeof tool?.content === "string" ? tool.content : "";
    expect(content).toContain("[tool output shortened");
    const beforeNotice = content.split("\n[tool output shortened")[0];
    // Progressive truncation ran below the first 2000-char limit.
    expect(beforeNotice.length).toBeLessThan(2_000);
    expect(content.length).toBeLessThan(toolOutput.length);
  });
});

describe("planRecovery", () => {
  const baseRecovery = {
    compactions: 0,
    maxCompactions: 3,
    sizeRetries: 0,
    maxSizeRetries: 2,
    allowSummarize: true,
    allowShrink: true,
  };

  it("returns none when within the trigger", () => {
    expect(planRecovery(50_000, 100_000, 200_000, baseRecovery)).toEqual({
      action: "none",
      reason: "within budget",
    });
  });

  it("chooses compact when over trigger with slots remaining", () => {
    expect(planRecovery(110_000, 100_000, 200_000, baseRecovery)).toEqual({
      action: "compact",
      reason: "over trigger, compaction slots available",
    });
  });

  it("chooses shrink when compactions are exhausted", () => {
    const noCompactions = { ...baseRecovery, compactions: 3, maxCompactions: 3 };
    expect(planRecovery(110_000, 100_000, 200_000, noCompactions)).toEqual({
      action: "shrink",
      reason: "compactions exhausted, shrink available",
    });
  });

  it("chooses escalate over the hard limit", () => {
    const noShrink = { ...baseRecovery, allowShrink: false, compactions: 3, maxCompactions: 3 };
    expect(planRecovery(250_000, 100_000, 200_000, noShrink)).toEqual({
      action: "escalate",
      reason: "over hard limit, try fallback model",
    });
  });
});
