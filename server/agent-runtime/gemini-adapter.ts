// Google Gemini transport (generateContent / streamGenerateContent). Owns the
// Gemini wire format only; conforms to the protocol-neutral ModelAdapter.
import { randomUUID } from "node:crypto";
import { rejectsKey, noteKeyRejected } from "../key-rejections.ts";
import type {
  CapabilityDescriptor,
  ModelAdapter,
  ModelAdapterError,
  ModelAdapterErrorCode,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
  ModelToolCall,
} from "./contracts.ts";

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  functionCall?: { name: string; args: unknown };
  functionResponse?: { name: string; response: unknown };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; code?: number };
}

class GeminiAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterErrorCode;
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;
  readonly bytes?: number;
  constructor(message: string, code: ModelAdapterErrorCode, retryable: boolean, retrySafe: boolean, requestStarted: boolean, bytes?: number) {
    super(message); this.name = "GeminiAdapterError"; this.code = code; this.retryable = retryable; this.retrySafe = retrySafe; this.requestStarted = requestStarted; this.bytes = bytes;
  }
}

function protocolError(message: string, requestStarted: boolean): GeminiAdapterError {
  return new GeminiAdapterError(message, "terminal", false, false, requestStarted);
}

function abortError(reason: unknown): DOMException {
  if (reason instanceof DOMException) return reason;
  return new DOMException("The model request was aborted", "AbortError");
}

function splitSystem(messages: ReadonlyArray<ModelMessage>): { system: string | undefined; rest: GeminiContent[] } {
  const systemParts: string[] = [];
  const rest: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
      }
      rest.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    if (message.role === "tool") {
      const response = typeof message.content === "string" ? message.content : "";
      // Gemini expects functionResponse with the function name; we approximate using toolCallId as name fallback.
      rest.push({ role: "user", parts: [{ functionResponse: { name: message.toolCallId ?? "tool", response: { result: response } } }] });
      continue;
    }
    // user
    const parts: GeminiPart[] = [];
    if (typeof message.content === "string") {
      if (message.content) parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") parts.push({ text: part.text });
        else if (part.type === "image") parts.push({ inline_data: { mime_type: part.mimeType, data: part.data } });
      }
    }
    if (!parts.length) parts.push({ text: "" });
    rest.push({ role: "user", parts });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, rest };
}

function wireTools(tools: ReadonlyArray<CapabilityDescriptor>) {
  return [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.schema })) }];
}

export interface GeminiModelAdapterConfig {
  readonly providerId: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly catalog: ModelCatalog | (() => ModelCatalog);
  readonly capabilities: (modelId: string) => ModelCapabilities;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxOutputTokens?: number;
}

export function createGeminiModelAdapter(config: GeminiModelAdapterConfig): ModelAdapter {
  const resolveFetcher = () => config.fetcher ?? fetch;
  const baseUrl = config.apiUrl.replace(/\/+$/, "");

  return {
    providerId: config.providerId,

    async discoverModels(): Promise<ModelCatalog> {
      return typeof config.catalog === "function" ? config.catalog() : config.catalog;
    },

    capabilities(modelId: string): ModelCapabilities {
      return config.capabilities(modelId);
    },

    async *generate(request: ModelGenerateRequest): AsyncIterable<ModelEvent> {
      if (!config.apiKey) {
        throw new GeminiAdapterError("No API key is configured for this provider", "terminal", false, false, false);
      }

      const { system, rest } = splitSystem(request.messages);
      const stream = config.capabilities(request.model).streaming === "supported";
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(new DOMException("The model request timed out", "TimeoutError")), config.timeoutMs ?? 120_000);
      const signal = AbortSignal.any([request.signal, timeoutController.signal]);
      let emitted = false;

      const payload: Record<string, unknown> = {
        contents: rest,
        generationConfig: { maxOutputTokens: config.maxOutputTokens ?? 4096 },
      };
      if (system) payload.systemInstruction = { parts: [{ text: system }] };
      if (request.tools.length) payload.tools = wireTools(request.tools);

      const endpoint = stream ? "streamGenerateContent?alt=sse" : "generateContent";

      try {
        let response: Response;
        try {
          response = await resolveFetcher()(`${baseUrl}/models/${encodeURIComponent(request.model)}:${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          if (request.signal.aborted) throw abortError(request.signal.reason);
          if (timeoutController.signal.aborted) throw new GeminiAdapterError("The model request timed out", "transient", true, !emitted, emitted);
          throw new GeminiAdapterError(emitted ? "The model connection failed after output started" : "The model request failed before a response was received", "transient", true, !emitted, emitted);
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          if (rejectsKey(response.status, detail)) noteKeyRejected(config.apiUrl, config.apiKey);
          const code: ModelAdapterErrorCode = transient ? "transient" : response.status === 400 || response.status === 422 ? "invalid_request" : "terminal";
          throw new GeminiAdapterError(`Gemini returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`, code, false, false, emitted);
        }

        if (!stream) {
          let completion: GeminiResponse;
          try { completion = await response.json() as GeminiResponse; } catch { throw protocolError("Gemini returned an unreadable JSON response", emitted); }
          if (completion.error) throw protocolError(completion.error.message ?? "Gemini error", emitted);
          const candidate = completion.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];
          const toolCalls: ModelToolCall[] = [];
          for (const part of parts) {
            if (part.text) { emitted = true; yield { type: "content.delta", kind: "assistant_text", delta: part.text }; }
            if (part.functionCall) {
              toolCalls.push({ id: randomUUID(), name: part.functionCall.name, arguments: part.functionCall.args ?? {} });
            }
          }
          if (toolCalls.length) { emitted = true; yield { type: "tool_calls", calls: toolCalls }; }
          const usage = completion.usageMetadata;
          if (usage) yield { type: "usage", input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 };
          yield { type: "completed", finishReason: candidate?.finishReason ?? null };
          return;
        }

        if (!response.body) throw protocolError("Gemini returned no stream body", emitted);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              let update: GeminiResponse;
              try { update = JSON.parse(data) as GeminiResponse; } catch { throw protocolError("Gemini stream contained an incomplete JSON frame", emitted); }
              const candidate = update.candidates?.[0];
              const parts = candidate?.content?.parts ?? [];
              const toolCalls: ModelToolCall[] = [];
              for (const part of parts) {
                if (part.text) { emitted = true; yield { type: "content.delta", kind: "assistant_text", delta: part.text }; }
                if (part.functionCall) {
                  toolCalls.push({ id: randomUUID(), name: part.functionCall.name, arguments: part.functionCall.args ?? {} });
                }
              }
              if (toolCalls.length) { emitted = true; yield { type: "tool_calls", calls: toolCalls }; }
              const usage = update.usageMetadata;
              if (usage) yield { type: "usage", input: usage.promptTokenCount ?? 0, output: usage.candidatesTokenCount ?? 0 };
              if (candidate?.finishReason) yield { type: "completed", finishReason: candidate.finishReason };
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        if (error instanceof GeminiAdapterError) throw error;
        if (request.signal.aborted) throw abortError(request.signal.reason);
        if (timeoutController.signal.aborted) throw new GeminiAdapterError("The model request timed out", "transient", true, !emitted, emitted);
        throw new GeminiAdapterError(emitted ? "The model stream failed after output started" : "The model stream failed before output started", "transient", true, !emitted, emitted);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
