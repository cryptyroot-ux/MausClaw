import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { SendTurnInput } from "../contracts.ts";

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
const { DATA_DIR } = await import("../config.ts");
const { bindSafetyFloor } = await import("../safety-floor-gate.ts");

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
  bindSafetyFloor(() => ({}));
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function jsonResponse(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function toolRound(id: string, name: string, argumentsValue: unknown = { value: "fixture" }): unknown {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(argumentsValue) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
}

async function nativeToolFixture(options: {
  name: string;
  arguments: unknown;
  tools?: boolean;
  computerUse?: boolean;
  toolScope?: SendTurnInput["toolScope"];
}) {
  const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part.toString();
    requests.push(JSON.parse(body));
    jsonResponse(response, requests.length === 1
      ? toolRound("gated-call", options.name, options.arguments)
      : { choices: [{ message: { content: "Done." }, finish_reason: "stop" }] });
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
    providerId: "openai-compat", apiUrl: `${origin}/v1`, apiKey: "fixture-key", catalog,
    capabilities: () => capabilities,
  });
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: `native-gate-${options.name}`, displayName: "Native gate fixture", environment: {}, enabled: true, config: {} },
    driverKind: "openai-compat", apiKey: "fixture-key", apiUrl: `${origin}/v1`, models: () => catalog,
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "fixture", missingKeyError: "missing key", unavailableReason: "missing key", timeoutMs: 5_000,
    nativeLog: { source: "fixture", outgoing: () => ({}), incoming: () => ({}) },
    ...(options.tools !== undefined ? { tools: options.tools } : {}),
    ...(options.computerUse !== undefined ? { computerUse: options.computerUse } : {}),
    nativeAgentEngine: createAgentEngine({ adapters: { resolve: () => adapter }, store: createSqliteAgentRunStore() }),
  });
  cleanups.push(async () => { await runtime.dispose(); });
  return { runtime, requests };
}

function turnCompleted(runtime: Awaited<ReturnType<typeof createOpenAIChatRuntime>>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    runtime.adapter.onEvent((event) => {
      if (event.type === "turn.completed") resolve(event as unknown as Record<string, unknown>);
    });
  });
}

describe("native ProviderAdapter acceptance", () => {
  it("waits for approval before a native file write is dispatched", async () => {
    const botId = "native-approval-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "approval.txt");
    const { runtime, requests } = await nativeToolFixture({
      name: "write", arguments: { file_path: "approval.txt", content: "approved" },
    });
    const completed = turnCompleted(runtime);
    let resolveFirst!: (event: { type: "request"; requestId: string } | { type: "completed" }) => void;
    const first = new Promise<{ type: "request"; requestId: string } | { type: "completed" }>((resolve) => { resolveFirst = resolve; });
    runtime.adapter.onEvent((event) => {
      if (event.type === "request.opened" && event.requestType === "permission") resolveFirst({ type: "request", requestId: event.requestId! });
      if (event.type === "turn.completed") resolveFirst({ type: "completed" });
    });

    await runtime.adapter.sendTurn({
      threadId: "thread-native-approval", botId, text: "Write the fixture file.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "ask",
    });
    const waiting = await first;
    expect(existsSync(target)).toBe(false);
    expect(waiting).toMatchObject({ type: "request", requestId: expect.any(String) });
    if (waiting.type !== "request") return;
    expect(await runtime.adapter.respondToRequest("thread-native-approval", waiting.requestId, { behavior: "allow" })).toBe("allowed-once");
    expect(await completed).toMatchObject({ type: "turn.completed", ok: true });
    expect(readFileSync(target, "utf8")).toBe("approved");
    expect(requests).toHaveLength(2);
  });

  it("does not dispatch a native write after the user denies approval", async () => {
    const botId = "native-denied-write-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "denied.txt");
    const { runtime } = await nativeToolFixture({
      name: "write", arguments: { file_path: "denied.txt", content: "must not exist" },
    });
    const completed = turnCompleted(runtime);
    let resolveGate!: (value: { requestId: string } | null) => void;
    const gate = new Promise<{ requestId: string } | null>((resolve) => { resolveGate = resolve; });
    runtime.adapter.onEvent((event) => {
      if (event.type === "request.opened" && event.requestType === "permission") resolveGate({ requestId: event.requestId! });
      if (event.type === "turn.completed") resolveGate(null);
    });
    await runtime.adapter.sendTurn({
      threadId: "thread-native-denied-write", botId, text: "Write the fixture file.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "ask",
    });
    const card = await gate;
    if (!card) expect(existsSync(target)).toBe(false);
    expect(card).not.toBeNull();
    if (!card) return;
    expect(await runtime.adapter.respondToRequest("thread-native-denied-write", card.requestId, { behavior: "deny" })).toBe("rejected");
    await completed;
    expect(existsSync(target)).toBe(false);
  });

  it("does not dispatch a native write after the turn is cancelled at approval", async () => {
    const botId = "native-cancelled-write-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "cancelled.txt");
    const { runtime } = await nativeToolFixture({
      name: "write", arguments: { file_path: "cancelled.txt", content: "must not exist" },
    });
    const completed = turnCompleted(runtime);
    let resolveGate!: (value: { type: "request"; requestId: string } | { type: "completed" }) => void;
    const gate = new Promise<{ type: "request"; requestId: string } | { type: "completed" }>((resolve) => { resolveGate = resolve; });
    runtime.adapter.onEvent((event) => {
      if (event.type === "request.opened" && event.requestType === "permission") resolveGate({ type: "request", requestId: event.requestId! });
      if (event.type === "turn.completed") resolveGate({ type: "completed" });
    });
    await runtime.adapter.sendTurn({
      threadId: "thread-native-cancelled-write", botId, text: "Write the fixture file.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "ask",
    });
    const waiting = await gate;
    expect(waiting.type).toBe("request");
    if (waiting.type !== "request") return;
    await runtime.adapter.interruptTurn("thread-native-cancelled-write");
    await completed;
    expect(existsSync(target)).toBe(false);
  });

  it("keeps the native shell safety floor active even in full access mode", async () => {
    const botId = "native-floor-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "floor-blocked.txt");
    bindSafetyFloor(
      () => ({ safetyFloor: { enabled: true } }),
      () => ({ read: true, verdict: { rule: "delete-root", label: "fixture safety rule" } }),
      "linux",
    );
    const { runtime, requests } = await nativeToolFixture({
      name: "bash",
      arguments: { command: `${process.execPath} -e "require('node:fs').writeFileSync('${target}', 'blocked')"` },
    });
    const completed = turnCompleted(runtime);
    const toolResults: string[] = [];
    runtime.adapter.onEvent((event) => {
      if (event.type === "item.completed" && event.itemType === "tool") toolResults.push(event.output ?? "");
    });
    await runtime.adapter.sendTurn({
      threadId: "thread-native-floor", botId, text: "Run the fixture command.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "full",
    });
    await completed;
    expect(requests.length).toBeGreaterThan(0);
    // Fail-closed: when the OS sandbox (bot box) is unavailable, native shell is not offered,
    // so bash never appears in the tool list and nothing runs on the host.
    expect((requests[0]?.tools ?? []).map((tool) => tool.function.name)).not.toContain("bash");
    expect(toolResults.join("\n")).not.toContain("fixture safety rule");
    expect(existsSync(target)).toBe(false);
  });

  it("blocks a native shell floor match before an Ask-mode approval card", async () => {
    const botId = "native-ask-floor-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "ask-floor-blocked.txt");
    bindSafetyFloor(
      () => ({ safetyFloor: { enabled: true } }),
      () => ({ read: true, verdict: { rule: "delete-root", label: "fixture safety rule" } }),
      "linux",
    );
    const { runtime } = await nativeToolFixture({
      name: "bash",
      arguments: { command: `${process.execPath} -e "require('node:fs').writeFileSync('${target}', 'blocked')"` },
    });
    const completed = turnCompleted(runtime);
    const toolResults: string[] = [];
    let permissionCards = 0;
    runtime.adapter.onEvent((event) => {
      if (event.type === "item.completed" && event.itemType === "tool") toolResults.push(event.output ?? "");
      if (event.type === "request.opened" && event.requestType === "permission") permissionCards++;
    });
    await runtime.adapter.sendTurn({
      threadId: "thread-native-ask-floor", botId, text: "Run the fixture command.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "ask",
    });
    await completed;
    // Fail-closed: shell unavailable → no tool call → no approval card, nothing runs.
    expect(permissionCards).toBe(0);
    expect(toolResults.join("\n")).not.toContain("fixture safety rule");
    expect(existsSync(target)).toBe(false);
  });

  it("does not offer or dispatch native tools when tools are disabled", async () => {
    const botId = "native-tools-disabled-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "disabled.txt");
    const { runtime, requests } = await nativeToolFixture({
      name: "write", arguments: { file_path: "disabled.txt", content: "must not exist" }, tools: false,
    });
    const completed = turnCompleted(runtime);
    await runtime.adapter.sendTurn({
      threadId: "thread-tools-disabled", botId, text: "Write the fixture file.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "full",
    });
    expect(await completed).toMatchObject({ type: "turn.completed", ok: false });
    expect((requests[0]?.tools ?? []).map((tool) => tool.function.name)).not.toContain("write");
    expect(existsSync(target)).toBe(false);
  });

  it("does not offer or dispatch computer execution when computerUse is disabled", async () => {
    const botId = "native-computer-disabled-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "computer-disabled.txt");
    const { runtime, requests } = await nativeToolFixture({
      name: "computer_exec",
      arguments: { command: `${process.execPath} -e "require('node:fs').writeFileSync('${target}', 'blocked')"` },
      computerUse: false,
    });
    const completed = turnCompleted(runtime);
    await runtime.adapter.sendTurn({
      threadId: "thread-computer-disabled", botId, text: "Run the fixture command.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "full",
    });
    await completed;
    expect((requests[0]?.tools ?? []).map((tool) => tool.function.name)).not.toContain("computer_exec");
    expect(existsSync(target)).toBe(false);
  });

  it("does not dispatch a guessed native tool excluded by tool scope", async () => {
    const botId = "native-hidden-bash-bot";
    const workspace = join(DATA_DIR, "workspaces", botId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const target = join(workspace, "hidden-bash.txt");
    const { runtime, requests } = await nativeToolFixture({
      name: "bash",
      arguments: { command: `${process.execPath} -e "require('node:fs').writeFileSync('${target}', 'blocked')"` },
      toolScope: { deny: ["native:bash"] },
    });
    const completed = turnCompleted(runtime);
    await runtime.adapter.sendTurn({
      threadId: "thread-native-hidden-bash", botId, text: "Run the fixture command.", agentEngine: "mausclaw-native",
      model: "fixture-model", approvalMode: "full", toolScope: { deny: ["native:bash"] },
    });
    expect(await completed).toMatchObject({ type: "turn.completed", ok: false });
    expect((requests[0]?.tools ?? []).map((tool) => tool.function.name)).not.toContain("bash");
    expect(existsSync(target)).toBe(false);
  });

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
