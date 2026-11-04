import { describe, expect, it } from "vitest";

import { createGeminiModelAdapter } from "./gemini-adapter.ts";
import type { ModelCatalog } from "./contracts.ts";

const catalog: ModelCatalog = { default: "gemini-2.0-flash", options: [{ id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", contextWindow: 1_000_000 }] };

describe("createGeminiModelAdapter", () => {
  it("discovers models from catalog", async () => {
    const adapter = createGeminiModelAdapter({ providerId: "gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "supported", contextWindow: { status: "known", value: 1_000_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }) });
    const discovered = await adapter.discoverModels();
    expect(discovered.options[0]?.id).toBe("gemini-2.0-flash");
  });

  it("generates text from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Hello from Gemini." }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createGeminiModelAdapter({ providerId: "gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 1_000_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "gemini-2.0-flash", tools: [], signal: new AbortController().signal })) events.push(e);
    expect(events.some((e) => e.type === "content.delta" && e.delta === "Hello from Gemini.")).toBe(true);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "usage" && e.input === 10)).toBe(true);
  });

  it("generates tool calls from a non-streaming response", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "/tmp/x" } } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createGeminiModelAdapter({ providerId: "gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 1_000_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "read" }], model: "gemini-2.0-flash", tools: [{ id: "read_file", name: "read_file", description: "read", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 1000 }], signal: new AbortController().signal })) events.push(e);
    const tc = events.find((e) => e.type === "tool_calls");
    expect(tc).toBeTruthy();
    expect(tc.calls[0].name).toBe("read_file");
  });

  it("throws on HTTP error", async () => {
    const fetcher = async () => new Response("bad key", { status: 401 });
    const adapter = createGeminiModelAdapter({ providerId: "gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 1_000_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    await expect(async () => {
      for await (const _e of adapter.generate({ messages: [{ role: "user", content: "hi" }], model: "gemini-2.0-flash", tools: [], signal: new AbortController().signal })) { /* drain */ }
    }).rejects.toThrow();
  });

  it("assigns unique IDs to parallel tool calls with the same function name (non-streaming) (M3)", async () => {
    const fetcher = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { functionCall: { name: "read_file", args: { path: "/tmp/a" } } },
        { functionCall: { name: "read_file", args: { path: "/tmp/b" } } },
      ] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
    const adapter = createGeminiModelAdapter({ providerId: "gemini", apiUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "key", catalog, capabilities: () => ({ tools: "supported", parallelTools: "supported", streaming: "unsupported", contextWindow: { status: "known", value: 1_000_000 }, imageInput: "supported", imageOutput: "unsupported", audioInput: "unsupported", audioOutput: "unsupported", structuredOutput: "unknown", toolSchemaLimit: { status: "unknown" } }), fetcher: fetcher as any, timeoutMs: 5_000 });
    const events: any[] = [];
    for await (const e of adapter.generate({ messages: [{ role: "user", content: "read" }], model: "gemini-2.0-flash", tools: [{ id: "read_file", name: "read_file", description: "read", schema: { type: "object" }, risk: "read", sideEffect: false, timeoutMs: 1000 }], signal: new AbortController().signal })) events.push(e);
    const tc = events.find((e) => e.type === "tool_calls");
    expect(tc).toBeTruthy();
    expect(tc.calls).toHaveLength(2);
    expect(tc.calls[0].name).toBe("read_file");
    expect(tc.calls[1].name).toBe("read_file");
    expect(tc.calls[0].id).not.toBe(tc.calls[1].id);
    expect(tc.calls[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tc.calls[1].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
