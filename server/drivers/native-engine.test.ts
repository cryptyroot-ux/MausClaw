import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createServer, type ServerResponse } from "node:http";

import { createNativeChatEngine } from "./native-engine.ts";
import type {
  AgentEvent,
  CapabilityGrant,
  CapabilitySession,
  ModelAdapter,
  ModelCapabilities,
  ModelCatalog,
  ModelEvent,
  ModelMessage,
  ProviderModelRef,
} from "../agent-runtime/contracts.ts";
import type { ModelCatalog as ServerModelCatalog } from "../contracts.ts";

const catalog: ModelCatalog = {
  default: "default-model",
  options: [
    { id: "default-model", label: "Default Model" },
    { id: "other-model", label: "Other Model" },
  ],
};

const capabilities: ModelCapabilities = {
  tools: "supported",
  parallelTools: "supported",
  streaming: "supported",
  contextWindow: { status: "known", value: 128_000 },
  imageInput: "unsupported",
  imageOutput: "unsupported",
  audioInput: "unsupported",
  audioOutput: "unsupported",
  structuredOutput: "unsupported",
  toolSchemaLimit: { status: "unknown" },
};


const grant: CapabilityGrant = {
  botId: "bot-1", threadId: "thread-1", approvalMode: "full",
  allowed: new Set(), denied: new Set(),
};

function testCapabilitySession(): CapabilitySession {
  return {
    list: () => [],
    validate: () => {},
    async invoke() {
      return { callId: "unused", ok: true, content: "unused" };
    },
    close: async () => {},
  };
}

const userMessages: ReadonlyArray<ModelMessage> = [{ role: "user", content: "Hi" }];

function baseAdapter(providerId: string): ModelAdapter {
  return {
    providerId,
    async discoverModels(): Promise<ModelCatalog> { return catalog; },
    capabilities(): ModelCapabilities { return capabilities; },
    async *generate(): AsyncGenerator<ModelEvent> {
      yield { type: "content.delta", kind: "assistant_text", delta: "ok" };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}

// HTTP server fixture for OpenAI-compatible adapters created by getAdapterForModel.
let server: ReturnType<typeof createServer>;
let origin: string;

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

beforeEach(async () => {
  server = createServer(async (request, response) => {
    if (request.url?.includes("/chat/completions")) {
      json(response, {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    } else {
      json(response, { error: "not found" }, 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function makeEngine(providerId: string) {
  return createNativeChatEngine({
    providerId,
    apiUrl: origin,
    apiKey: "test-key",
    catalog: () => catalog as unknown as ServerModelCatalog,
    modelAdapter: baseAdapter(providerId),
    toolsEnabled: true,
  });
}

async function runEngine(engine: any, providerModel: ProviderModelRef, threadId = "thread-1"): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const unsubscribe = engine.onEvent(threadId, (e: any) => events.push(e));
  const { done } = await engine.run({
    botId: "bot-1", threadId, text: "Hi",
    messages: userMessages,
    providerModel,
    grant,
    capabilities: testCapabilitySession(),
    signal: new AbortController().signal,
  });
  await done;
  unsubscribe();
  return events;
}

describe("createNativeChatEngine adapter resolver (M4)", () => {
  it("resolves the default model via the base adapter for any providerId", async () => {
    const engine = await makeEngine("anthropic");
    const events = await runEngine(engine, { providerId: "anthropic", modelId: "default-model" });
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);
  });

  it("creates adapters keyed by providerId + modelId for non-default models", async () => {
    const anthropicEngine = await makeEngine("anthropic");
    const openaiEngine = await makeEngine("openai");

    const aEvents = await runEngine(anthropicEngine, { providerId: "anthropic", modelId: "other-model" }, "thread-a");
    const oEvents = await runEngine(openaiEngine, { providerId: "openai", modelId: "other-model" }, "thread-o");

    expect(aEvents.some((e) => e.type === "turn.completed")).toBe(true);
    expect(oEvents.some((e) => e.type === "turn.completed")).toBe(true);
  });
});
