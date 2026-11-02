// Anthropic Messages API driver over the MausClaw-owned native engine.
import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { createNativeChatEngine } from "./native-engine.ts";
import { createAnthropicModelAdapter } from "../agent-runtime/anthropic-adapter.ts";
import { probeCapabilities } from "../agent-runtime/capability-probe.ts";

const DRIVER_KIND = "anthropic";
const DEFAULT_URL = "https://api.anthropic.com";
const MODELS = {
  default: "claude-3-5-sonnet-20241022",
  options: [
    { id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet", contextWindow: 200_000 },
    { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", contextWindow: 200_000 },
    { id: "claude-3-opus-20240229", label: "Claude 3 Opus", contextWindow: 200_000 },
  ],
};

export interface AnthropicConfig {
  tools?: boolean;
  url: string;
  apiKeyEnv: string;
  maxTokens?: number;
}

function decodeConfig(raw: unknown): AnthropicConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.maxTokens !== undefined && typeof config.maxTokens !== "number") throw new Error("maxTokens must be a number");
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens as number } : {}),
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "ANTHROPIC_API_KEY",
  };
}

export const AnthropicDriver: ProviderDriver<AnthropicConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Anthropic (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const modelAdapter = createAnthropicModelAdapter({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      capabilities: (modelId) => probeCapabilities(modelId, () => MODELS, { toolsEnabled: config.tools !== false && String(config.tools) !== "false", imageInput: () => true }),
      maxTokens: config.maxTokens,
    });
    const nativeAgentEngine = await createNativeChatEngine({
      providerId: DRIVER_KIND,
      apiUrl: config.url,
      apiKey,
      catalog: () => MODELS,
      toolsEnabled: config.tools !== false && String(config.tools) !== "false",
      imageInput: () => true,
      httpErrorLabel: "Anthropic",
      modelAdapter,
    });
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      nativeAgentEngine,
      modelAdapter,
      apiKey,
      apiUrl: config.url,
      tools: config.tools,
      models: () => MODELS,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "Anthropic",
      missingKeyError: `Save an Anthropic API key in Settings → API keys, or set ${config.apiKeyEnv}.`,
      unavailableReason: "No Anthropic API key — open Settings → API keys.",
      timeoutMs: 120_000,
      generateModel: () => "claude-3-5-haiku-20241022",
      nativeLog: {
        source: "anthropic.messages",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};

// Re-export the adapter for direct use / tests.
export { createAnthropicModelAdapter, probeCapabilities };
