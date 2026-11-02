import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "mausclaw-native-provider-"));
const originalDataDir = process.env.MAUSCLAW_DATA_DIR;
process.env.MAUSCLAW_DATA_DIR = dataDir;
const originalPath = process.env.PATH;
process.env.PATH = "/nonexistent-native-agent-path";

const { createOpenAIChatRuntime } = await import("../drivers/openai-chat.ts");
const { createOpenAICompatibleModelAdapter } = await import("./model-adapter.ts");
const { createAgentEngine } = await import("./runtime.ts");
const { createSqliteAgentRunStore } = await import("./run-store.ts");
const { InMemoryCapabilitySession } = await import("./capability-runtime.ts");
const { closeMessageDb } = await import("../message-db.ts");

afterAll(() => {
  process.env.PATH = originalPath;
  if (originalDataDir === undefined) delete process.env.MAUSCLAW_DATA_DIR;
  else process.env.MAUSCLAW_DATA_DIR = originalDataDir;
  closeMessageDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const catalog = { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] };
const capabilities = {
  tools: "supported" as const,
  parallelTools: "unknown" as const,
  streaming: "unsupported" as const,
  contextWindow: { status: "known" as const, value: 128_000 },
  imageInput: "unsupported" as const,
  imageOutput: "unsupported" as const,
  audioInput: "unsupported" as const,
  audioOutput: "unsupported" as const,
  structuredOutput: "unsupported" as const,
  toolSchemaLimit: { status: "unknown" as const },
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function jsonResponse(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function toolRound(id: string, name: string): unknown {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: '{"value":"fixture"}' } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
}

describe("native ProviderAdapter acceptance", () => {
  it("completes two tool rounds without an agent CLI", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part.toString();
      requests.push(JSON.parse(body));
      if (requests.length === 1) jsonResponse(response, toolRound("call-a", "fixture-a"));
      else if (requests.length === 2) jsonResponse(response, toolRound("call-b", "fixture-b"));
      else jsonResponse(response, {
        choices: [{ message: { content: "Both fixture values are verified." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const origin = `http://127.0.0.1:${address.port}`;

    const adapter = createOpenAICompatibleModelAdapter({
      providerId: "openai-compat",
      apiUrl: `${origin}/v1`,
      apiKey: "fixture-key",
      catalog,
      capabilities: () => capabilities,
    });
    const store = createSqliteAgentRunStore();
    const baseEngine = createAgentEngine({ adapters: { resolve: () => adapter }, store });
    const capabilitySession = new InMemoryCapabilitySession();
    const invoked: string[] = [];
    capabilitySession.register({
      id: "fixture-a",
      name: "fixture-a",
      description: "Fixture A",
      schema: { type: "object" },
      risk: "read",
      sideEffect: false,
      timeoutMs: 5_000,
    }, async (call) => {
      invoked.push(call.capabilityId);
      return { callId: call.callId, ok: true, content: "A done" };
    });
    capabilitySession.register({
      id: "fixture-b",
      name: "fixture-b",
      description: "Fixture B",
      schema: { type: "object" },
      risk: "read",
      sideEffect: false,
      timeoutMs: 5_000,
    }, async (call) => {
      invoked.push(call.capabilityId);
      return { callId: call.callId, ok: true, content: "B done" };
    });
    const engine = {
      ...baseEngine,
      run: (request: Parameters<typeof baseEngine.run>[0]) => baseEngine.run({ ...request, capabilities: capabilitySession }),
    };

    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "native-fixture", displayName: "Native Fixture", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "fixture-key",
      apiUrl: `${origin}/v1`,
      models: () => catalog,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "fixture",
      missingKeyError: "missing key",
      unavailableReason: "missing key",
      timeoutMs: 5_000,
      nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
      computerUse: false,
      nativeAgentEngine: engine,
    });
    cleanups.push(async () => { await runtime.dispose(); });

    const agentEvents: Array<{ type: string; runId?: string }> = [];
    engine.onEvent("thread-1", (event) => agentEvents.push(event));
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      runtime.adapter.onEvent((event) => {
        if (event.type === "turn.completed") resolve(event as unknown as Record<string, unknown>);
      });
    });

    await runtime.adapter.sendTurn({
      threadId: "thread-1",
      text: "Run both fixture capabilities.",
      agentEngine: "mausclaw-native",
      model: "fixture-model",
      approvalMode: "full",
    });
    const result = await completed;

    expect(result).toMatchObject({ ok: true, stopReason: "stop" });
    expect(invoked).toEqual(["fixture-a", "fixture-b"]);
    expect(requests).toHaveLength(3);
    const started = agentEvents.find((event) => event.type === "run.started") as { runId: string } | undefined;
    expect(started?.runId).toBeTruthy();
    expect(store.getRun(started!.runId)).toMatchObject({ status: "completed", modelRounds: 3, toolCalls: 2 });
  });

  it("accepts steering on a native turn and injects it into the next round", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part.toString();
      requests.push(JSON.parse(body));
      await held;
      jsonResponse(response, {
        choices: [{ message: { content: requests.length === 1 ? "Native answer." : "Native answer after steer." }, finish_reason: "stop" }],
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const origin = `http://127.0.0.1:${address.port}`;

    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "native-fixture", displayName: "Native Fixture", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "fixture-key",
      apiUrl: `${origin}/v1`,
      models: () => catalog,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "fixture",
      missingKeyError: "missing key",
      unavailableReason: "missing key",
      timeoutMs: 5_000,
      nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
      computerUse: true,
      nativeAgentEngine: createAgentEngine({
        adapters: {
          resolve: () => createOpenAICompatibleModelAdapter({
            providerId: "openai-compat",
            apiUrl: `${origin}/v1`,
            apiKey: "fixture-key",
            catalog,
            capabilities: () => capabilities,
          }),
        },
        store: createSqliteAgentRunStore(),
      }),
    });
    cleanups.push(async () => { await runtime.dispose(); });
    const completed = new Promise<void>((resolve) => {
      runtime.adapter.onEvent((event) => {
        if (event.type === "turn.completed") resolve();
      });
    });

    try {
      await runtime.adapter.sendTurn({
        threadId: "thread-steer",
        text: "Take your time.",
        agentEngine: "mausclaw-native",
        model: "fixture-model",
        approvalMode: "full",
      });
      expect(await runtime.adapter.steer?.("thread-steer", "An extra instruction.")).toBe("steered");
    } finally {
      release();
    }
    await completed;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toContainEqual({ role: "user", content: "An extra instruction." });
  });

  it("fails before contacting the provider when an attached image cannot be read", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      for await (const _part of request) { /* drain */ }
      requests.push({});
      jsonResponse(response, { choices: [{ message: { content: "unexpected" }, finish_reason: "stop" }] });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const origin = `http://127.0.0.1:${address.port}`;

    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "native-fixture", displayName: "Native Fixture", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "fixture-key",
      apiUrl: `${origin}/v1`,
      models: () => catalog,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "fixture",
      missingKeyError: "missing key",
      unavailableReason: "missing key",
      timeoutMs: 5_000,
      nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
      computerUse: true,
      nativeAgentEngine: createAgentEngine({
        adapters: {
          resolve: () => createOpenAICompatibleModelAdapter({
            providerId: "openai-compat",
            apiUrl: `${origin}/v1`,
            apiKey: "fixture-key",
            catalog,
            capabilities: () => capabilities,
          }),
        },
        store: createSqliteAgentRunStore(),
      }),
    });
    cleanups.push(async () => { await runtime.dispose(); });
    const errors: string[] = [];
    runtime.adapter.onEvent((event) => {
      if (event.type === "runtime.error") errors.push(event.message);
    });

    await expect(runtime.adapter.sendTurn({
      threadId: "thread-images",
      text: "Look at this.",
      agentEngine: "mausclaw-native",
      model: "fixture-model",
      approvalMode: "full",
      images: [{ path: "/nonexistent.png", mime: "image/png", bytes: 0 }],
    })).rejects.toThrow(/ENOENT|image/i);
    expect(requests).toHaveLength(0);
  });

  it("attaches a readable turn image to the native request", async () => {
    const requests: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part.toString();
      requests.push(JSON.parse(body));
      jsonResponse(response, { choices: [{ message: { content: "Seen." }, finish_reason: "stop" }] });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const origin = `http://127.0.0.1:${address.port}`;
    const imagePath = join(dataDir, "pixel.png");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(imagePath, image);

    const runtime = createOpenAIChatRuntime({
      input: { instanceId: "native-fixture", displayName: "Native Fixture", environment: {}, enabled: true, config: {} },
      driverKind: "openai-compat",
      apiKey: "fixture-key",
      apiUrl: `${origin}/v1`,
      models: () => catalog,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      httpErrorLabel: "fixture",
      missingKeyError: "missing key",
      unavailableReason: "missing key",
      timeoutMs: 5_000,
      nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
      computerUse: true,
      nativeAgentEngine: createAgentEngine({
        adapters: {
          resolve: () => createOpenAICompatibleModelAdapter({
            providerId: "openai-compat",
            apiUrl: `${origin}/v1`,
            apiKey: "fixture-key",
            catalog,
            capabilities: () => ({ ...capabilities, imageInput: "supported" as const }),
          }),
        },
        store: createSqliteAgentRunStore(),
      }),
    });
    cleanups.push(async () => { await runtime.dispose(); });
    const completed = new Promise<Record<string, unknown>>((resolve) => {
      runtime.adapter.onEvent((event) => {
        if (event.type === "turn.completed") resolve(event as unknown as Record<string, unknown>);
      });
    });

    await runtime.adapter.sendTurn({
      threadId: "thread-image",
      text: "Look at this.",
      agentEngine: "mausclaw-native",
      model: "fixture-model",
      approvalMode: "full",
      images: [{ path: imagePath, mime: "image/png", bytes: image.length }],
    });
    expect(await completed).toMatchObject({ ok: true });
    expect(requests.at(-1)?.messages?.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Look at this." },
        { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
      ],
    });
  });
});
