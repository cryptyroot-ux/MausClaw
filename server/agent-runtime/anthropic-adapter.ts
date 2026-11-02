// Anthropic Messages transport. This adapter owns the Anthropic wire format
// only: no capability execution, no run state, and no credentials in logs.
// Conforms to the protocol-neutral ModelAdapter contract so the MausClaw engine
// loop is unchanged.
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
} from "./contracts.ts";

interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicResponse {
  id?: string;
  type?: string;
  role?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

class AnthropicAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterErrorCode;
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;
  readonly bytes?: number;

  constructor(message: string, code: ModelAdapterErrorCode, retryable: boolean, retrySafe: boolean, requestStarted: boolean, bytes?: number) {
    super(message);
    this.name = "AnthropicAdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retrySafe = retrySafe;
    this.requestStarted = requestStarted;
    this.bytes = bytes;
  }
}

function protocolError(message: string, requestStarted: boolean): AnthropicAdapterError {
  return new AnthropicAdapterError(message, "terminal", false, false, requestStarted);
}

function abortError(reason: unknown): DOMException {
  if (reason instanceof DOMException) return reason;
  return new DOMException("The model request was aborted", "AbortError");
}

function wireContent(content: ModelMessage["content"]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  if (content === null) return "";
  return content.map((part) => part.type === "text"
    ? { type: "text", text: part.text }
    : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } });
}

function splitSystem(messages: ReadonlyArray<ModelMessage>): { system: string | undefined; rest: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const rest: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof message.content === "string" && message.content) blocks.push({ type: "text", text: message.content });
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        }
      }
      rest.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }
    if (message.role === "tool") {
      rest.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId ?? "", content: typeof message.content === "string" ? message.content : "" }],
      });
      continue;
    }
    // user
    rest.push({ role: "user", content: wireContent(message.content) });
  }
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, rest };
}

function wireTools(tools: ReadonlyArray<CapabilityDescriptor>): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  }));
}

export interface AnthropicModelAdapterConfig {
  readonly providerId: string;
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly catalog: ModelCatalog | (() => ModelCatalog);
  readonly capabilities: (modelId: string) => ModelCapabilities;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxTokens?: number;
  readonly anthropicVersion?: string;
}

export function createAnthropicModelAdapter(config: AnthropicModelAdapterConfig): ModelAdapter {
  const resolveFetcher = () => config.fetcher ?? fetch;
  const apiUrl = config.apiUrl.replace(/\/+$/, "");
  const version = config.anthropicVersion ?? "2023-06-01";

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
        throw new AnthropicAdapterError("No API key is configured for this provider", "terminal", false, false, false);
      }

      const { system, rest } = splitSystem(request.messages);
      const stream = config.capabilities(request.model).streaming === "supported";
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => {
        timeoutController.abort(new DOMException("The model request timed out", "TimeoutError"));
      }, config.timeoutMs ?? 120_000);
      const signal = AbortSignal.any([request.signal, timeoutController.signal]);
      let emitted = false;

      const payload: Record<string, unknown> = {
        model: request.model,
        messages: rest,
        max_tokens: config.maxTokens ?? 4096,
        stream,
      };
      if (system) payload.system = system;
      if (request.tools.length) payload.tools = wireTools(request.tools);

      try {
        let response: Response;
        try {
          response = await resolveFetcher()(`${apiUrl}/messages`, {
            method: "POST",
            headers: {
              "x-api-key": config.apiKey,
              "anthropic-version": version,
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
            signal,
          });
        } catch {
          if (request.signal.aborted) throw abortError(request.signal.reason);
          if (timeoutController.signal.aborted) {
            throw new AnthropicAdapterError("The model request timed out", "transient", true, !emitted, emitted);
          }
          throw new AnthropicAdapterError(
            emitted ? "The model connection failed after output started" : "The model request failed before a response was received",
            "transient", true, !emitted, emitted,
          );
        }

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const transient = response.status === 408 || response.status === 429 || response.status >= 500;
          if (rejectsKey(response.status, detail)) noteKeyRejected(config.apiUrl, config.apiKey);
          const code: ModelAdapterErrorCode = transient ? "transient" : response.status === 400 || response.status === 422 ? "invalid_request" : "terminal";
          throw new AnthropicAdapterError(
            `Anthropic returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
            code, false, false, emitted,
          );
        }

        if (!stream) {
          let completion: AnthropicResponse;
          try {
            completion = await response.json() as AnthropicResponse;
          } catch {
            throw protocolError("Anthropic returned an unreadable JSON response", emitted);
          }
          if (completion.error) throw protocolError(completion.error.message ?? "Anthropic error", emitted);
          const blocks = completion.content ?? [];
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              emitted = true;
              yield { type: "content.delta", kind: "assistant_text", delta: block.text };
            } else if (block.type === "tool_use") {
              emitted = true;
              yield { type: "tool_calls", calls: [{ id: block.id ?? "", name: block.name ?? "", arguments: block.input ?? {} }] };
            }
          }
          const usage = completion.usage;
          if (usage) {
            yield { type: "usage", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 };
          }
          yield { type: "completed", finishReason: completion.stop_reason ?? null };
          return;
        }

        if (!response.body) throw protocolError("Anthropic returned no stream body", emitted);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentTool: { id: string; name: string; args: string } | null = null;
        let finishReason: string | null = null;
        let usage: { input: number; output: number } | null = null;

        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
              buffer += decoder.decode();
              break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              let event: any;
              try {
                event = JSON.parse(data);
              } catch {
                throw protocolError("Anthropic stream contained an incomplete JSON frame", emitted);
              }
              const type = event.type;
              if (type === "message_start") {
                const u = event.message?.usage;
                if (u) usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
              } else if (type === "content_block_start") {
                const block = event.content_block;
                if (block?.type === "tool_use") {
                  currentTool = { id: block.id ?? "", name: block.name ?? "", args: "" };
                }
              } else if (type === "content_block_delta") {
                const delta = event.delta;
                if (delta?.type === "text_delta" && delta.text) {
                  emitted = true;
                  yield { type: "content.delta", kind: "assistant_text", delta: delta.text };
                } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                  if (currentTool) currentTool.args += delta.partial_json;
                }
              } else if (type === "content_block_stop") {
                if (currentTool) {
                  emitted = true;
                  let args: unknown = {};
                  try { args = currentTool.args.trim() ? JSON.parse(currentTool.args) : {}; } catch { args = {}; }
                  yield { type: "tool_calls", calls: [{ id: currentTool.id, name: currentTool.name, arguments: args }] };
                  currentTool = null;
                }
              } else if (type === "message_delta") {
                if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
                const u = event.usage;
                if (u && usage) usage.output = u.output_tokens ?? usage.output;
              } else if (type === "message_stop") {
                // done
              } else if (type === "error") {
                throw protocolError(event.error?.message ?? "Anthropic stream error", emitted);
              }
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }

        if (usage) yield { type: "usage", input: usage.input, output: usage.output };
        yield { type: "completed", finishReason };
      } catch (error) {
        if (error instanceof AnthropicAdapterError) throw error;
        if (request.signal.aborted) throw abortError(request.signal.reason);
        if (timeoutController.signal.aborted) {
          throw new AnthropicAdapterError("The model request timed out", "transient", true, !emitted, emitted);
        }
        throw new AnthropicAdapterError(
          emitted ? "The model stream failed after output started" : "The model stream failed before output started",
          "transient", true, !emitted, emitted,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
