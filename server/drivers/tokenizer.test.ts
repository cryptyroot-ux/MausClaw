import { describe, expect, it } from "vitest";
import { countTokens, encodingForModel, estimateTokensByChars, prepareTokenizer } from "./tokenizer.ts";

describe("tokenizer", () => {
  it("maps model families to encodings and leaves unknown models on the estimate", () => {
    expect(encodingForModel("gpt-4o-mini")).toBe("o200k_base");
    expect(encodingForModel("openai/gpt-5.1")).toBe("o200k_base");
    expect(encodingForModel("gpt-6.1-sol")).toBe("o200k_base");
    expect(encodingForModel("o3-mini")).toBe("o200k_base");
    expect(encodingForModel("gpt-4-turbo")).toBe("cl100k_base");
    expect(encodingForModel("MyCombo")).toBeNull();
    expect(encodingForModel("claude-sonnet-5-5")).toBeNull();
    expect(encodingForModel(undefined)).toBeNull();
  });

  it("uses chars/3.5 for unknown models", async () => {
    expect(await prepareTokenizer("MyCombo")).toBe(false);
    expect(countTokens("abcdefg", "MyCombo")).toBe(2);
    expect(countTokens("", "gpt-4o")).toBe(0);
  });

  it("counts exactly once the encoding is loaded, special-token text included", async () => {
    expect(await prepareTokenizer("gpt-4o")).toBe(true);
    expect(countTokens("hello world", "gpt-4o")).toBe(2);
    expect(countTokens("say <|endoftext|> now", "gpt-4o")).toBeGreaterThan(3);
    const code = "export function add(a: number, b: number) { return a + b; }\n".repeat(50);
    expect(countTokens(code, "gpt-4o")).toBe(900);
    // The estimate weighs punctuation, so code no longer comes in under the BPE count.
    expect(estimateTokensByChars(code)).toBeGreaterThanOrEqual(900);
  });

  it("does not under-count JSON or code for models without a known encoding (audit T01)", async () => {
    await prepareTokenizer("gpt-4o");
    const samples = {
      english: "The quick brown fox jumps over the lazy dog. ".repeat(50),
      json: JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ id: i, ok: true, path: `/src/f${i}.ts` }))),
      typescript: "export async function runToolBatch<Call, Result>(calls: readonly Call[]): Promise<void> { for (let i = 0; i < calls.length; i++) {} }\n".repeat(30),
      toolResult: JSON.stringify({ ok: true, result: "  12\tconst x = { a: [1, 2, 3], b: \"c\" };\n".repeat(40) }),
    };
    for (const [kind, text] of Object.entries(samples)) {
      const ratio = countTokens(text, "claude-sonnet-4") / countTokens(text, "gpt-4o");
      expect(ratio, kind).toBeGreaterThanOrEqual(1);
      expect(ratio, kind).toBeLessThan(1.5); // still an estimate, not a 2x overshoot
    }
  });
});
