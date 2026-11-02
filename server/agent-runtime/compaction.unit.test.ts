import { describe, it, expect, beforeEach } from "vitest";
import {
  compactMessages,
  compactionTrigger,
  planRecovery,
  estimateTokensForText,
  estimateMessageTokens,
  estimateMessagesTokens,
  chooseBodyCut,
  compactionKeepTokens,
  contextBudget,
  scoreMessageImportance,
  compactionTranscript,
  SUMMARY_PROMPT,
  buildCompactionRecord,
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

describe("estimateTokensForText", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokensForText("")).toBe(0);
  });

  it("returns a positive count for non-empty text", () => {
    expect(estimateTokensForText("hello world")).toBeGreaterThan(0);
  });

  it("grows monotonically with input length", () => {
    expect(estimateTokensForText("a".repeat(100))).toBeGreaterThan(
      estimateTokensForText("a".repeat(10)),
    );
  });

  it("is deterministic for identical input", () => {
    expect(estimateTokensForText("abc 123 punctuation!")).toBe(
      estimateTokensForText("abc 123 punctuation!"),
    );
  });

  it("accepts an optional modelId without throwing", () => {
    expect(() => estimateTokensForText("hello world", "gpt-4o")).not.toThrow();
    expect(estimateTokensForText("hello world", "gpt-4o")).toBeGreaterThan(0);
  });

  it("handles unicode and whitespace", () => {
    expect(estimateTokensForText("café résumé\n\t")).toBeGreaterThan(0);
  });
});

describe("estimateMessageTokens", () => {
  it("returns the base overhead for empty string content", () => {
    const message: ModelMessage = { role: "user", content: "" };
    expect(estimateMessageTokens(message)).toBe(4);
  });

  it("returns the base overhead for null content", () => {
    const message: ModelMessage = { role: "assistant", content: null };
    expect(estimateMessageTokens(message)).toBe(4);
  });

  it("counts string content", () => {
    const message: ModelMessage = { role: "assistant", content: "hello world" };
    expect(estimateMessageTokens(message)).toBeGreaterThan(4);
  });

  it("counts array text parts", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    };
    expect(estimateMessageTokens(message)).toBeGreaterThan(4);
  });

  it("counts image parts by base64 length (64 bytes -> 1 token)", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "a".repeat(64) }],
    };
    // 4 overhead + ceil(64/64)=1 clamped to >=1
    expect(estimateMessageTokens(message)).toBe(5);
  });

  it("clamps tiny image data to at least one token", () => {
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "" }],
    };
    expect(estimateMessageTokens(message)).toBe(5);
  });

  it("scales image tokens for larger payloads", () => {
    const small: ModelMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "a".repeat(64) }],
    };
    const large: ModelMessage = {
      role: "user",
      content: [{ type: "image", mimeType: "image/png", data: "a".repeat(128) }],
    };
    expect(estimateMessageTokens(large)).toBeGreaterThan(estimateMessageTokens(small));
  });

  it("counts toolCallId overhead", () => {
    const without: ModelMessage = { role: "tool", content: "result" };
    const withId: ModelMessage = { role: "tool", content: "result", toolCallId: "call-123" };
    expect(estimateMessageTokens(withId)).toBeGreaterThan(estimateMessageTokens(without));
  });

  it("counts toolCalls including names, ids, and arguments", () => {
    const plain: ModelMessage = { role: "assistant", content: "" };
    const withCalls: ModelMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/tmp/x" } }],
    };
    expect(estimateMessageTokens(withCalls)).toBeGreaterThan(estimateMessageTokens(plain));
  });

  it("counts multiple tool calls separately", () => {
    const one: ModelMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "a", arguments: {} }],
    };
    const two: ModelMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "a", arguments: {} },
        { id: "c2", name: "b", arguments: {} },
      ],
    };
    expect(estimateMessageTokens(two)).toBeGreaterThan(estimateMessageTokens(one));
  });

  it("sums text and image parts in mixed array content", () => {
    const message: ModelMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", mimeType: "image/png", data: "a".repeat(64) },
      ],
    };
    const textOnly: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "describe this" }],
    };
    expect(estimateMessageTokens(message)).toBeGreaterThan(estimateMessageTokens(textOnly));
  });

  it("accepts a modelId argument", () => {
    const message: ModelMessage = { role: "user", content: "hello" };
    expect(estimateMessageTokens(message, "gpt-4o")).toBeGreaterThan(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("returns 0 for an empty list", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });

  it("equals the sum of individual message estimates", () => {
    const messages: readonly ModelMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const expected =
      estimateMessageTokens(messages[0]) +
      estimateMessageTokens(messages[1]) +
      estimateMessageTokens(messages[2]);
    expect(estimateMessagesTokens(messages)).toBe(expected);
  });

  it("grows with more messages", () => {
    const one: readonly ModelMessage[] = [{ role: "user", content: "one" }];
    const two: readonly ModelMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];
    expect(estimateMessagesTokens(two)).toBeGreaterThan(estimateMessagesTokens(one));
  });

  it("accepts a modelId argument", () => {
    const messages: readonly ModelMessage[] = [{ role: "user", content: "hello" }];
    expect(estimateMessagesTokens(messages, "gpt-4o")).toBeGreaterThan(0);
  });
});

describe("chooseBodyCut", () => {
  const small: ModelMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
    { role: "user", content: "third" },
  ];

  it("returns 0 when everything fits", () => {
    expect(chooseBodyCut(small, 1_000_000)).toBe(0);
  });

  it("returns body.length when nothing fits", () => {
    // keepTokens 0 cannot accommodate the overhead of any message
    expect(chooseBodyCut(small, 0)).toBe(small.length);
  });

  it("returns an index within [0, body.length]", () => {
    const cut = chooseBodyCut(small, 4);
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(cut).toBeLessThanOrEqual(small.length);
  });

  it("handles an empty body", () => {
    expect(chooseBodyCut([], 100)).toBe(0);
  });

  it("never cuts so the kept slice begins with an orphan tool result", () => {
    const body: readonly ModelMessage[] = [
      { role: "user", content: "opener" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c1", content: "tool result content here" },
      { role: "user", content: "final turn" },
    ];
    for (const keep of [0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 100_000]) {
      const cut = chooseBodyCut(body, keep);
      if (cut < body.length) {
        expect(body[cut].role, `keep=${keep}`).not.toBe("tool");
      }
    }
  });

  it("does not create an orphan when the cut lands exactly on a tool message", () => {
    const body: readonly ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "tool", toolCallId: "c1", content: "c" },
      { role: "user", content: "d" },
    ];
    // Force a cut position that would otherwise land on the tool message.
    const cut = chooseBodyCut(body, estimateMessageTokens(body[3]) + 1);
    expect(cut < body.length ? body[cut].role : "end").not.toBe("tool");
  });

  it("keeps newest messages within the token budget", () => {
    const body: readonly ModelMessage[] = [
      { role: "user", content: "old " + "x".repeat(100) },
      { role: "assistant", content: "mid " + "y".repeat(100) },
      { role: "user", content: "new" },
    ];
    const cut = chooseBodyCut(body, estimateMessageTokens(body[2]) + 1);
    expect(cut).toBeGreaterThanOrEqual(1);
  });

  it("accepts an optional modelId", () => {
    expect(() => chooseBodyCut(small, 100, "gpt-4o")).not.toThrow();
  });
});

describe("compactionKeepTokens (standalone)", () => {
  it("uses the default 128k window when unknown", () => {
    // 128000 * 0.25 = 32000, clamped to max 32000
    expect(compactionKeepTokens({ status: "unknown" })).toBe(32_000);
  });

  it("clamps small windows to 8000", () => {
    expect(compactionKeepTokens({ status: "known", value: 10_000 })).toBe(8_000);
  });

  it("clamps large windows to 32000", () => {
    expect(compactionKeepTokens({ status: "known", value: 200_000 })).toBe(32_000);
  });

  it("applies the 25% proportion inside the clamp range", () => {
    expect(compactionKeepTokens({ status: "known", value: 80_000 })).toBe(20_000);
    expect(compactionKeepTokens({ status: "known", value: 64_000 })).toBe(16_000);
  });

  it("floors the proportional value", () => {
    // 100000 * 0.25 = 25000 (exact). Use 100001 -> floor 25000
    expect(compactionKeepTokens({ status: "known", value: 100_001 })).toBe(25_000);
  });
});

describe("contextBudget (standalone)", () => {
  it("uses the default 128k window when unknown", () => {
    expect(contextBudget({ status: "unknown" })).toEqual({
      window: 128_000,
      trigger: 108_800,
    });
  });

  it("computes reserve = max(16000, 15% of window)", () => {
    // 50000 * 0.15 = 7500 -> reserve stays 16000; trigger = max(25000, 34000) = 34000
    expect(contextBudget({ status: "known", value: 50_000 })).toEqual({
      window: 50_000,
      trigger: 34_000,
    });
  });

  it("uses 15% reserve for larger windows", () => {
    // 200000 * 0.15 = 30000; trigger = max(100000, 170000) = 170000
    expect(contextBudget({ status: "known", value: 200_000 })).toEqual({
      window: 200_000,
      trigger: 170_000,
    });
  });

  it("trigger is at least 50% of the window", () => {
    const w = 40_000;
    const reserve = Math.max(16_000, Math.floor(w * 0.15));
    const expected = Math.max(Math.floor(w / 2), w - reserve);
    expect(contextBudget({ status: "known", value: w }).trigger).toBe(expected);
  });

  it("trigger never exceeds the window", () => {
    for (const w of [8_192, 32_000, 128_000, 256_000]) {
      const { trigger, window } = contextBudget({ status: "known", value: w });
      expect(trigger).toBeLessThanOrEqual(window);
      expect(trigger).toBeGreaterThan(0);
    }
  });
});

describe("scoreMessageImportance", () => {
  it("scores system messages as 100 with reason 'system'", () => {
    const msg: ModelMessage = { role: "system", content: "anything" };
    expect(scoreMessageImportance(msg, 0, 5)).toEqual({
      index: 0,
      score: 100,
      reasons: ["system"],
    });
  });

  it("system score is 100 regardless of position", () => {
    const msg: ModelMessage = { role: "system", content: "" };
    expect(scoreMessageImportance(msg, 3, 10).score).toBe(100);
  });

  it("scores a user message with base 15 plus concise 5 when short", () => {
    // total=1 => recency 1 => 40 points; user base 15; concise 5 => 60
    const msg: ModelMessage = { role: "user", content: "hi" };
    const scored = scoreMessageImportance(msg, 0, 1);
    expect(scored.score).toBe(60);
    expect(scored.reasons).toContain("user");
    expect(scored.reasons).toContain("concise");
  });

  it("adds 5 for a question mark in user content", () => {
    const q: ModelMessage = { role: "user", content: "hi?" };
    const plain: ModelMessage = { role: "user", content: "hi" };
    expect(scoreMessageImportance(q, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 5,
    );
    expect(scoreMessageImportance(q, 0, 1).reasons).toContain("question");
  });

  it("scores assistant with base 10", () => {
    const msg: ModelMessage = { role: "assistant", content: "x".repeat(600) }; // not concise
    // recency 40 + 10 = 50
    expect(scoreMessageImportance(msg, 0, 1).score).toBe(50);
    expect(scoreMessageImportance(msg, 0, 1).reasons).toContain("assistant");
  });

  it("adds 20 for assistant tool calls", () => {
    const plain: ModelMessage = { role: "assistant", content: "x".repeat(600) };
    const withCalls: ModelMessage = {
      role: "assistant",
      content: "x".repeat(600),
      toolCalls: [{ id: "c", name: "t", arguments: {} }],
    };
    expect(scoreMessageImportance(withCalls, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 20,
    );
    expect(scoreMessageImportance(withCalls, 0, 1).reasons).toContain("tool-calls");
  });

  it("adds 10 for assistant decision language", () => {
    const plain: ModelMessage = { role: "assistant", content: "x".repeat(600) };
    const decided: ModelMessage = { role: "assistant", content: "we fixed it " + "x".repeat(600) };
    expect(scoreMessageImportance(decided, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 10,
    );
    expect(scoreMessageImportance(decided, 0, 1).reasons).toContain("decision");
  });

  it("scores tool result with base 5", () => {
    const msg: ModelMessage = { role: "tool", content: "x".repeat(600) };
    // recency 40 + 5 = 45
    expect(scoreMessageImportance(msg, 0, 1).score).toBe(45);
    expect(scoreMessageImportance(msg, 0, 1).reasons).toContain("tool-result");
  });

  it("adds 15 for tool error content", () => {
    const plain: ModelMessage = { role: "tool", content: "x".repeat(600) };
    const errored: ModelMessage = { role: "tool", content: "error occurred " + "x".repeat(600) };
    expect(scoreMessageImportance(errored, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 15,
    );
    expect(scoreMessageImportance(errored, 0, 1).reasons).toContain("error");
  });

  it("adds 10 for tool content containing a file path", () => {
    const plain: ModelMessage = { role: "tool", content: "x".repeat(600) };
    const withPath: ModelMessage = { role: "tool", content: "opened src/main.ts " + "x".repeat(600) };
    expect(scoreMessageImportance(withPath, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 10,
    );
    expect(scoreMessageImportance(withPath, 0, 1).reasons).toContain("file-path");
  });

  it("recency scales 0-40 across positions", () => {
    const msg: ModelMessage = { role: "user", content: "hi" };
    const first = scoreMessageImportance(msg, 0, 5);
    const last = scoreMessageImportance(msg, 4, 5);
    // (4/4 - 0/4) * 40 = 40
    expect(last.score - first.score).toBe(40);
  });

  it("marks recent messages with 'recent' reason", () => {
    const msg: ModelMessage = { role: "user", content: "hi" };
    const recent = scoreMessageImportance(msg, 4, 5);
    expect(recent.reasons).toContain("recent");
  });

  it("does not mark early messages as recent", () => {
    const msg: ModelMessage = { role: "user", content: "hi" };
    const early = scoreMessageImportance(msg, 0, 5);
    expect(early.reasons).not.toContain("recent");
  });

  it("adds concise +5 for short content", () => {
    const long: ModelMessage = { role: "assistant", content: "x".repeat(600) };
    const short: ModelMessage = { role: "assistant", content: "short" };
    // short gets concise +5 AND recency same; long content has no code
    const longScore = scoreMessageImportance(long, 0, 1).score;
    const shortScore = scoreMessageImportance(short, 0, 1).score;
    expect(shortScore).toBe(longScore + 5);
    expect(scoreMessageImportance(short, 0, 1).reasons).toContain("concise");
  });

  it("adds code +5 for code fences or inline code", () => {
    const plain: ModelMessage = { role: "assistant", content: "no code here " + "x".repeat(600) };
    const withCode: ModelMessage = { role: "assistant", content: "see `foo()` " + "x".repeat(600) };
    expect(scoreMessageImportance(withCode, 0, 1).score).toBe(
      scoreMessageImportance(plain, 0, 1).score + 5,
    );
    expect(scoreMessageImportance(withCode, 0, 1).reasons).toContain("code");
  });

  it("caps scores at 100", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: "done `x`",
      toolCalls: [{ id: "c", name: "t", arguments: {} }],
    };
    expect(scoreMessageImportance(msg, 0, 1).score).toBeLessThanOrEqual(100);
  });

  it("handles array content for scoring (text extraction)", () => {
    const q: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "what is this?" }],
    };
    expect(scoreMessageImportance(q, 0, 1).reasons).toContain("question");
  });

  it("returns the provided index", () => {
    const msg: ModelMessage = { role: "user", content: "hi" };
    expect(scoreMessageImportance(msg, 7, 10).index).toBe(7);
  });
});

describe("compactionTranscript", () => {
  it("returns empty string for no messages", () => {
    expect(compactionTranscript([])).toBe("");
  });

  it("joins messages with double newlines", () => {
    const msgs: readonly ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const out = compactionTranscript(msgs);
    expect(out).toContain("USER: hello");
    expect(out).toContain("ASSISTANT: world");
    expect(out).toContain("\n\n");
  });

  it("clips long content at clipChars with ellipsis", () => {
    const msg: ModelMessage = { role: "user", content: "a".repeat(3000) };
    const out = compactionTranscript([msg], { clipChars: 10 });
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(3000);
  });

  it("respects maxChars by breaking before exceeding", () => {
    const msgs: readonly ModelMessage[] = [
      { role: "user", content: "a".repeat(20) },
      { role: "assistant", content: "b".repeat(20) },
    ];
    const out = compactionTranscript(msgs, { maxChars: 40 });
    expect(out).toContain("USER:");
    expect(out).not.toContain("ASSISTANT:");
  });

  it("appends tool calls to the line", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: "x",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/tmp/a" } }],
    };
    const out = compactionTranscript([msg]);
    expect(out).toContain("TOOL CALLS:");
    expect(out).toContain("read_file");
    expect(out).toContain("/tmp/a");
  });

  it("uppercases the role prefix", () => {
    const msg: ModelMessage = { role: "tool", content: "result" };
    const out = compactionTranscript([msg]);
    expect(out.startsWith("TOOL:")).toBe(true);
  });

  it("preserves multiple tool calls joined by semicolons", () => {
    const msg: ModelMessage = {
      role: "assistant",
      content: "x",
      toolCalls: [
        { id: "c1", name: "a", arguments: {} },
        { id: "c2", name: "b", arguments: {} },
      ],
    };
    const out = compactionTranscript([msg]);
    expect(out).toContain("a({})");
    expect(out).toContain(";");
    expect(out).toContain("b({})");
  });

  it("uses default clipChars and maxChars when omitted", () => {
    const msg: ModelMessage = { role: "user", content: "short" };
    expect(compactionTranscript([msg])).toBe("USER: short");
  });
});

describe("SUMMARY_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SUMMARY_PROMPT).toBe("string");
    expect(SUMMARY_PROMPT.length).toBeGreaterThan(0);
  });

  it("mentions preserving objectives and files", () => {
    expect(SUMMARY_PROMPT).toMatch(/objective/i);
    expect(SUMMARY_PROMPT).toMatch(/files/i);
  });

  it("is a single joined string without newlines", () => {
    expect(SUMMARY_PROMPT.includes("\n")).toBe(false);
  });
});

describe("buildCompactionRecord", () => {
  it("returns an AgentCompactionRecord-shaped object", () => {
    const record = buildCompactionRecord("run-1", 2, "summary text", 5, 1234, "auto");
    expect(record.runId).toBe("run-1");
    expect(record.sequence).toBe(2);
    expect(record.summary).toBe("summary text");
    expect(record.firstKeptIndex).toBe(5);
    expect(record.tokenEstimate).toBe(1234);
    expect(record.trigger).toBe("auto");
    expect(typeof record.createdAt).toBe("number");
  });

  it("defaults createdAt to approximately now", () => {
    const before = Date.now();
    const record = buildCompactionRecord("r", 1, "s", 0, 0, "overflow");
    const after = Date.now();
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
    expect(record.createdAt).toBeLessThanOrEqual(after);
  });

  it("uses a provided createdAt verbatim", () => {
    const record = buildCompactionRecord("r", 1, "s", 0, 0, "auto", 42);
    expect(record.createdAt).toBe(42);
  });

  it("accepts trigger 'overflow'", () => {
    const record = buildCompactionRecord("r", 1, "s", 0, 0, "overflow", 1);
    expect(record.trigger).toBe("overflow");
  });
});

describe("compactMessages (additional coverage)", () => {
  beforeEach(() => {
    resetOverflow("gpt-4o");
  });

  function manyMessages(count: number, chars: number): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (let i = 0; i < count; i++) out.push(variedMessage(i, chars));
    return out;
  }

  it("returns strategy 'none' when already within budget", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = compactMessages(messages, {
      keepTokens: 100_000,
      maxTokens: 200_000,
      allowShrink: false,
      allowSummarize: false,
      minKeepMessages: 2,
      bridgeMessages: 2,
    });
    expect(result.strategy).toBe("none");
    expect(result.droppedCount).toBe(0);
    expect(result.savedTokens).toBe(0);
    expect(result.qualityScore).toBe(100);
    expect(result.droppedMessages).toEqual([]);
  });

  it("returns strategy 'none' when there is no user message", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "no user here" },
    ];
    const result = compactMessages(messages, baseOptions);
    expect(result.strategy).toBe("none");
  });

  it("returns strategy 'none' when body is empty", () => {
    const messages: ModelMessage[] = [{ role: "system", content: "sys only" }];
    const result = compactMessages(messages, baseOptions);
    expect(result.strategy).toBe("none");
  });

  it("uses sliding-window and inserts a compacted note", () => {
    const messages = manyMessages(80, 1500);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.strategy).toBe("sliding-window");
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages.some((m) =>
      typeof m.content === "string" && m.content.includes("compacted to fit"),
    )).toBe(true);
    expect(result.savedTokens).toBeGreaterThan(0);
  });

  it("keeps the last user message in sliding-window output", () => {
    const messages = manyMessages(80, 1500);
    const lastUser = (messages.filter((m) => m.role === "user").pop() as ModelMessage).content;
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.messages.some((m) => m.content === lastUser)).toBe(true);
  });

  it("keeps system messages in sliding-window output", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "important system directive" },
      ...manyMessages(80, 1500),
    ];
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.messages.some((m) => m.role === "system")).toBe(true);
  });

  it("reports droppedMessages length matching droppedCount", () => {
    const messages = manyMessages(80, 1500);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.droppedMessages.length).toBe(result.droppedCount);
  });

  it("truncates images in shrink tier", () => {
    const toolOutput = Array.from({ length: 100 }, (_, i) =>
      `line ${i}: ${"segment content heresegment content here".repeat(2)}`,
    ).join("\n");
    const messages: ModelMessage[] = [
      { role: "user", content: "opener" },
      { role: "assistant", content: "", toolCalls: [{ name: "t", id: "c1", arguments: {} }] },
      { role: "tool", toolCallId: "c1", content: toolOutput },
      {
        role: "user",
        content: [
          { type: "text", text: "final turn" },
          { type: "image", mimeType: "image/png", data: "a".repeat(10_000) },
        ],
      },
    ];
    const result = compactMessages(messages, {
      ...shrinkBaseCompactionOptions(),
      allowShrink: true,
      keepTokens: 1_000,
      bridgeMessages: 1,
    });
    expect(result.strategy).toBe("shrink");
    const imgMsg = result.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "text" && (p as { text: string }).text === "final turn"),
    );
    if (imgMsg && Array.isArray(imgMsg.content)) {
      const joined = imgMsg.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
      expect(joined).toContain("image omitted");
    }
  });

  it("escalates when compaction cannot fit even without shrinking", () => {
    const messages = manyMessages(5, 100);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
      keepTokens: 1,
      maxTokens: 1,
    });
    expect(result.strategy).toBe("escalate");
    expect(result.droppedCount).toBeGreaterThan(0);
  });

  it("escalates when shrinking cannot fit within the budget", () => {
    const messages = manyMessages(5, 100);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: true,
      keepTokens: 1,
      maxTokens: 1,
    });
    expect(result.strategy).toBe("escalate");
  });

  it("qualityScore is between 0 and 100", () => {
    const messages = manyMessages(80, 1500);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.qualityScore).toBeGreaterThanOrEqual(0);
    expect(result.qualityScore).toBeLessThanOrEqual(100);
  });

  it("savedTokens is non-negative", () => {
    const messages = manyMessages(80, 1500);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.savedTokens).toBeGreaterThanOrEqual(0);
  });

  it("messages array is a new array (not same reference)", () => {
    const messages = manyMessages(80, 1500);
    const result = compactMessages(messages, {
      ...baseOptions,
      allowShrink: false,
    });
    expect(result.messages).not.toBe(messages);
  });
});

function shrinkBaseCompactionOptions(): CompactionOptions {
  return {
    keepTokens: 32_000,
    maxTokens: 128_000,
    modelId: "gpt-4o",
    allowShrink: true,
    allowSummarize: false,
    minKeepMessages: 2,
    bridgeMessages: 2,
  };
}

describe("planRecovery (all combinations)", () => {
  const base = {
    compactions: 0,
    maxCompactions: 3,
    sizeRetries: 0,
    maxSizeRetries: 2,
    allowSummarize: true,
    allowShrink: true,
  };

  it("returns none when tokenEst is within the effective trigger", () => {
    expect(planRecovery(10_000, 100_000, 200_000, base)).toEqual({
      action: "none",
      reason: "within budget",
    });
  });

  it("prefers compact when slots and summarization are available", () => {
    expect(planRecovery(150_000, 100_000, 200_000, base)).toEqual({
      action: "compact",
      reason: "over trigger, compaction slots available",
    });
  });

  it("skips compact when allowSummarize is false", () => {
    const opts = { ...base, allowSummarize: false };
    expect(planRecovery(150_000, 100_000, 200_000, opts)).toEqual({
      action: "shrink",
      reason: "compactions exhausted, shrink available",
    });
  });

  it("skips compact when compactions are exhausted even if allowSummarize", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3 };
    expect(planRecovery(150_000, 100_000, 200_000, opts)).toEqual({
      action: "shrink",
      reason: "compactions exhausted, shrink available",
    });
  });

  it("skips shrink when allowShrink is false and tokenEst <= maxTokens -> fail", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3, allowShrink: false };
    expect(planRecovery(150_000, 100_000, 200_000, opts)).toEqual({
      action: "fail",
      reason: "all recovery strategies exhausted",
    });
  });

  it("skips shrink when size retries are exhausted and stays under maxTokens => fail", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3, sizeRetries: 2, maxSizeRetries: 2 };
    expect(planRecovery(150_000, 100_000, 200_000, opts)).toEqual({
      action: "fail",
      reason: "all recovery strategies exhausted",
    });
  });

  it("escalates when over maxTokens with no strategies left but small retries", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3, allowShrink: false };
    expect(planRecovery(250_000, 100_000, 200_000, opts)).toEqual({
      action: "escalate",
      reason: "over hard limit, try fallback model",
    });
  });

  it("fails when all strategies exhausted and tokenEst <= maxTokens", () => {
    const opts = {
      ...base,
      compactions: 3,
      maxCompactions: 3,
      sizeRetries: 2,
      maxSizeRetries: 2,
      allowShrink: false,
    };
    expect(planRecovery(150_000, 100_000, 200_000, opts)).toEqual({
      action: "fail",
      reason: "all recovery strategies exhausted",
    });
  });

  it("prefers shrink over escalate when shrink is available even if over maxTokens? no: compact first", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3 };
    expect(planRecovery(250_000, 100_000, 200_000, opts).action).toBe("shrink");
  });

  it("escalate reason includes fallback model", () => {
    const opts = { ...base, compactions: 3, maxCompactions: 3, allowShrink: false };
    expect(planRecovery(250_000, 100_000, 200_000, opts)).toEqual({
      action: "escalate",
      reason: "over hard limit, try fallback model",
    });
  });

  it("result always has action and reason strings", () => {
    const r = planRecovery(1, 1, 1, base);
    expect(typeof r.action).toBe("string");
    expect(typeof r.reason).toBe("string");
  });
});
