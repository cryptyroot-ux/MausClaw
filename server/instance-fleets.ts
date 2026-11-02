// The engine instances a fresh install starts with, and the ones an existing product fleet gains.
// instanceConfigs (config.ts) copies every entry before it changes one.
import type { InstanceConfigMap } from "./contracts.ts";

export const OPENAI_API_INSTANCE = "openai";
export const OPENROUTER_API_INSTANCE = "openrouter";
export const XAI_API_INSTANCE = "xaiApi";
export const CLAUDE_API_INSTANCE = "claudeApi";
export const API_KEY_FLEET: InstanceConfigMap = {
  [OPENAI_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenAI", access: "api", icon: { kind: "preset", preset: "openai" },
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "MAUSCLAW_OPENAI_API_KEY", catalog: "openai" },
  },
  [CLAUDE_API_INSTANCE]: {
    driver: "anthropic", displayName: "Claude (API key)", access: "api", icon: { kind: "preset", preset: "anthropic" },
    config: { requireApiKey: true },
  },
  [XAI_API_INSTANCE]: { driver: "grok", displayName: "xAI", access: "api", icon: { kind: "preset", preset: "xai" } },
  [OPENROUTER_API_INSTANCE]: {
    driver: "openai-compat", displayName: "OpenRouter", access: "api", icon: { kind: "preset", preset: "openrouter" },
    config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "MAUSCLAW_OPENROUTER_API_KEY" },
  },
};

export const DEFAULT_FLEET: InstanceConfigMap = {
  openaiCompat: { driver: "openai-compat" },
  ollamaCloud: { driver: "openai-compat", displayName: "Ollama Cloud", config: { url: "https://ollama.com/v1", apiKeyEnv: "MAUSCLAW_OLLAMA_CLOUD_API_KEY" } },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  ...API_KEY_FLEET,
};

export const PRODUCT_FLEET_ADDITIONS = {
  openaiCompat: { driver: "openai-compat" },
  mistral: { driver: "mistral" },
  cerebras: { driver: "cerebras" },
  groq: { driver: "groq" },
  meta: { driver: "meta" },
  ...API_KEY_FLEET,
} as const;
