import type { AnyProviderDriver } from "../contracts.ts";
import { AnthropicDriver } from "./anthropic.ts";
import { GeminiDriver } from "./gemini.ts";
import { GrokDriver } from "./grok.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { OpenAIResponsesDriver } from "./openai-responses.ts";
import { GroqDriver } from "./groq.ts";
import { MetaDriver } from "./meta.ts";
import { MinimaxDriver } from "./minimax.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";

// Hanya driver API native yang dijalankan di atas MausClaw-native agent engine.
// Semua driver agen eksternal (CLI/ACP: Claude, Codex, Hermes, Pi, Antigravity,
// OpenCode, Qwen, Cursor, dll.) telah dihapus total. MausClaw adalah platform agen
// mandiri: provider/model dihubungkan melalui ModelAdapter, bukan melalui CLI eksternal.
export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  AnthropicDriver,
  GeminiDriver,
  GrokDriver,
  OpenAICompatDriver,
  OpenAIResponsesDriver,
  GroqDriver,
  MetaDriver,
  MinimaxDriver,
  MistralDriver,
  CerebrasDriver,
];
