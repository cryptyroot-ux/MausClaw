import { describe, expect, it } from "vitest";
import { countTokens, encodingForModel, estimateTokensByChars, FALLBACK_CHARS_PER_TOKEN, prepareTokenizer } from "./tokenizer.ts";

describe("tokenizer unit — model family coverage", () => {
  it("maps all gpt-4o variants to o200k_base", () => {
    for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4o-preview", "gpt-4o-realtime", "gpt-4o-audio", "openai/gpt-4o-search-preview", "azure/gpt-4o-transcribe"]) {
      expect(encodingForModel(id)).toBe("o200k_base");
    }
  });

  it("maps gpt-4.1, 4.5, 5, 6, oss variants to o200k_base", () => {
    for (const id of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.5", "gpt-5", "gpt-5-mini", "gpt-5.5", "gpt-6", "gpt-6.1-sol", "gpt-oss", "gpt-oss-120b"]) {
      expect(encodingForModel(id)).toBe("o200k_base");
    }
  });

  it("maps o-series (o1–o9) to o200k_base", () => {
    for (const id of ["o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o3-mini-high", "o4-mini", "o9"]) {
      expect(encodingForModel(id)).toBe("o200k_base");
    }
  });

  it("maps chatgpt-4o and codex to o200k_base", () => {
    expect(encodingForModel("chatgpt-4o")).toBe("o200k_base");
    expect(encodingForModel("chatgpt-4o-latest")).toBe("o200k_base");
    expect(encodingForModel("codex")).toBe("o200k_base");
    expect(encodingForModel("codex-mini-latest")).toBe("o200k_base");
  });

  it("maps classic gpt-4 / gpt-3.5 / text-embedding to cl100k_base", () => {
    expect(encodingForModel("gpt-4")).toBe("cl100k_base");
    expect(encodingForModel("gpt-4-turbo")).toBe("cl100k_base");
    expect(encodingForModel("gpt-4-0125-preview")).toBe("cl100k_base");
    expect(encodingForModel("gpt-4-vision-preview")).toBe("cl100k_base");
    expect(encodingForModel("gpt-3.5")).toBe("cl100k_base");
    expect(encodingForModel("gpt-3.5-turbo")).toBe("cl100k_base");
    expect(encodingForModel("text-embedding-3-small")).toBe("cl100k_base");
  });

  it("leaves unknown models null", () => {
    expect(encodingForModel("claude-sonnet-4-6")).toBeNull();
    expect(encodingForModel("gemini-2.5-pro")).toBeNull();
    expect(encodingForModel("llama-3.3-70b")).toBeNull();
    expect(encodingForModel("")).toBeNull();
    expect(encodingForModel(undefined)).toBeNull();
  });

  it("provider prefixes are stripped", () => {
    expect(encodingForModel("openai/gpt-4o")).toBe("o200k_base");
    expect(encodingForModel("azure/gpt-4")).toBe("cl100k_base");
    expect(encodingForModel("ANTHROPIC/openai/gpt-4o")).toBe("o200k_base");
    expect(encodingForModel("azure/gpt-4o-mini")).toBe("o200k_base");
    expect(encodingForModel("Bedrock/gpt-4-turbo")).toBe("cl100k_base");
  });

  it("countTokens returns chars-based estimate for unknown models (over-counting bias)", async () => {
    await prepareTokenizer("unknown-model-xyz");
    const text = "Hello world";
    expect(countTokens(text, "unknown-model-xyz")).toBeGreaterThanOrEqual(Math.ceil(text.length / 4));
  });

  it("FALLBACK_CHARS_PER_TOKEN is 3.5", () => {
    expect(FALLBACK_CHARS_PER_TOKEN).toBe(3.5);
  });

  it("estimateTokensByChars never below chars/3.5", () => {
    const text = "a".repeat(100);
    expect(estimateTokensByChars(text)).toBeGreaterThanOrEqual(Math.ceil(100 / 3.5));
  });
});