import { describe, expect, it } from "vitest";

import { createAgentEngine } from "./runtime.ts";
import { compactionKeepTokens } from "./compaction.ts";
import type { LiveProbeResult } from "./capability-probe.ts";
import type {
  AgentEvent,
  AgentCompactionRecord,
  AgentRunRecord,
  AgentToolOutputRecord,
  AgentRunStore,
  CapabilityCallStatus,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilitySession,
  ModelAdapter,
  ModelAdapterError,
  ModelAdapterRegistry,
  ModelCapabilities,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
} from "./contracts.ts";

interface TestRunStore extends AgentRunStore {
  readonly runs: Map<string, AgentRunRecord>;
  readonly calls: Map<string, { readonly status: CapabilityCallStatus }>;
  readonly compactions: AgentCompactionRecord[];
  readonly outputs: Map<string, AgentToolOutputRecord>;
  readonly recoverCalls: number[];
}

function testRunStore(): TestRunStore {
  const runs = new Map<string, AgentRunRecord>();
  const calls = new Map<string, { readonly status: CapabilityCallStatus }>();
  const compactions: AgentCompactionRecord[] = [];
  const outputs = new Map<string, AgentToolOutputRecord>();
  const recoverCalls: number[] = [];
  return {
    runs,
    calls,
    compactions,
    outputs,
    recoverCalls,
    createRun(record) {
      runs.set(record.runId, record);
    },
    getRun(runId) {
      return runs.get(runId);
    },
    updateRunProgress(runId, progress) {
      const current = runs.get(runId);
      if (current) runs.set(runId, { ...current, ...progress });
    },
    transitionRun(runId, expected, next, updatedAt, failureCode) {
      const current = runs.get(runId);
      if (!current || current.status !== expected) return false;
      runs.set(runId, { ...current, status: next, updatedAt, ...(failureCode ? { failureCode } : {}) });
      return true;
    },
    beginCapabilityCall(record) {
      calls.set(`${record.runId}:${record.callId}`, { status: record.status });
    },
    settleCapabilityCall(runId, callId, status) {
      calls.set(`${runId}:${callId}`, { status });
    },
    recoverUnsettledRuns(now: number) {
      recoverCalls.push(now);
    },
    recordCompaction(record) {
      compactions.push(record);
    },
    recordToolOutput(record) {
      outputs.set(`${record.runId}:${record.callId}`, record);
    },
    readToolOutput(runId, callId) {
      return outputs.get(`${runId}:${callId}`);
    },
  };
}

const supportedCapabilities: ModelCapabilities = {
  tools: "supported",
  parallelTools: "supported",
  streaming: "supported",
  contextWindow: { status: "known", value: 128_000 },
  imageInput: "unsupported",
  imageOutput: "unsupported",
  audioInput: "unsupported",
  audioOutput: "unsupported",
  structuredOutput: "supported",
  toolSchemaLimit: { status: "known", value: 64_000 },
};

function descriptor(id: string): CapabilityDescriptor {
  return {
    id,
    name: id,
    description: `Fixture capability ${id}`,
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    risk: "read",
    sideEffect: false,
    timeoutMs: 5_000,
  };
}

interface TestCapabilitySession extends CapabilitySession {
  readonly validations: string[];
  readonly invocations: string[];
  readonly closeCount: number;
}

function testCapabilitySession(
  descriptors: readonly CapabilityDescriptor[],
  invalidCallIds: ReadonlySet<string> = new Set(),
  uncertainCallIds: ReadonlySet<string> = new Set(),
  throwingCallIds: ReadonlySet<string> = new Set(),
  imageCallIds: ReadonlySet<string> = new Set(),
  longCallIds: ReadonlySet<string> = new Set(),
): TestCapabilitySession {
  const validations: string[] = [];
  const invocations: string[] = [];
  let closeCount = 0;
  return {
    validations,
    invocations,
    get closeCount() { return closeCount; },
    list(grant) {
      return descriptors.filter((item) => grant.allowed.has(item.id) && !grant.denied.has(item.id));
    },
    validate(call) {
      validations.push(call.callId);
      if (!descriptors.some((item) => item.id === call.capabilityId)) throw new Error("unknown capability");
      if (invalidCallIds.has(call.callId)) throw new Error("invalid fixture arguments");
    },
    async invoke(call, { grant, signal }) {
      signal.throwIfAborted();
      if (grant.denied.has(call.capabilityId) || !grant.allowed.has(call.capabilityId)) {
        return { callId: call.callId, ok: false, content: "denied", error: "denied" };
      }
      invocations.push(call.callId);
      if (throwingCallIds.has(call.callId)) throw new Error("fixture lost the result after dispatch");
      if (uncertainCallIds.has(call.callId)) return { callId: call.callId, ok: false, content: "result uncertain", error: "uncertain", uncertain: true };
      if (imageCallIds.has(call.callId)) return { callId: call.callId, ok: true, content: "Screenshot captured", images: [{ mimeType: "image/png", data: "fixture" }] };
      if (longCallIds.has(call.callId)) return { callId: call.callId, ok: true, content: "A".repeat(20_000) };
      return { callId: call.callId, ok: true, content: `Result for ${call.capabilityId}` };
    },
    async close() {
      closeCount++;
    },
  };
}

interface TestModelAdapter extends ModelAdapter {
  readonly requests: ModelGenerateRequest[];
}

function testModelAdapter(
  rounds: ReadonlyArray<ReadonlyArray<ModelEvent>>,
  modelCapabilities: ModelCapabilities = supportedCapabilities,
): TestModelAdapter {
  const requests: ModelGenerateRequest[] = [];
  return {
    providerId: "fixture",
    requests,
    async discoverModels() {
      return { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture Model" }] };
    },
    capabilities() {
      return modelCapabilities;
    },
    async *generate(request) {
      const round = requests.length;
      requests.push(request);
      for (const event of rounds[round] ?? []) yield event;
    },
  };
}

function registryFor(adapter: ModelAdapter): ModelAdapterRegistry {
  return { resolve: () => adapter };
}

class FixtureModelAdapterError extends Error implements ModelAdapterError {
  readonly code: ModelAdapterError["code"];
  readonly retryable: boolean;
  readonly retrySafe: boolean;
  readonly requestStarted: boolean;

  constructor(
    message: string,
    code: ModelAdapterError["code"],
    retryable: boolean,
    retrySafe: boolean,
    requestStarted: boolean,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retrySafe = retrySafe;
    this.requestStarted = requestStarted;
  }
}

const grant: CapabilityGrant = {
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode: "full",
  allowed: new Set(["read-a", "read-b"]),
  denied: new Set(),
};

const userMessages: ReadonlyArray<ModelMessage> = [{ role: "system", content: "Use only the supplied fixture tools." }];

describe("createAgentEngine", () => {
  it("runs two tool rounds and returns a final answer", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "tool_calls", calls: [{ id: "call-b", name: "read-b", arguments: { value: "b" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Both fixture values are verified." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const capabilities = testCapabilitySession([descriptor("read-a"), descriptor("read-b")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    const unsubscribe = engine.onEvent("thread-1", (event) => events.push(event));

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read two fixture values.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(3);
    expect(modelAdapter.requests[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-a" }));
    expect(modelAdapter.requests[2]?.messages).toContainEqual(expect.objectContaining({ role: "tool", toolCallId: "call-b" }));
    expect(capabilities.invocations).toEqual(["call-a", "call-b"]);
    expect(store.getRun(runId)).toMatchObject({ status: "completed", modelRounds: 3, toolCalls: 2 });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.calls",
      "tool.result",
      "tool.calls",
      "tool.result",
      "model.delta",
      "turn.completed",
    ]);
    expect(capabilities.closeCount).toBe(1);
    unsubscribe();
  });

  it("blocks unknown model tool capability before the first model request", async () => {
    const unknownCapabilities: ModelCapabilities = { ...supportedCapabilities, tools: "unknown" };
    const modelAdapter = testModelAdapter([], unknownCapabilities);
    const capabilities = testCapabilitySession([descriptor("read-a")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read a fixture value.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "unknown-tools" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(0);
    expect(capabilities.invocations).toEqual([]);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
  });

  it("rejects an invalid tool batch before any side effect", async () => {
    const batches = [
      {
        calls: [
          { id: "call-a", name: "read-a", arguments: { value: "a" } },
          { id: "call-b", name: "read-b", arguments: { value: "b" } },
        ],
        invalidCallIds: new Set(["call-b"]),
      },
      {
        calls: [
          { id: "same-id", name: "read-a", arguments: { value: "a" } },
          { id: "same-id", name: "read-b", arguments: { value: "b" } },
        ],
        invalidCallIds: new Set<string>(),
      },
      {
        calls: Array.from({ length: 201 }, (_, index) => ({
          id: `call-${index}`,
          name: "read-a",
          arguments: { value: String(index) },
        })),
        invalidCallIds: new Set<string>(),
      },
    ];

    for (const batch of batches) {
      const modelAdapter = testModelAdapter([[
        { type: "tool_calls", calls: batch.calls },
        { type: "completed", finishReason: "tool_calls" },
      ]]);
      const capabilities = testCapabilitySession([descriptor("read-a"), descriptor("read-b")], batch.invalidCallIds);
      const store = testRunStore();
      const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
      const { runId, done } = await engine.run({
        botId: "bot-1",
        threadId: "thread-1",
        text: "Read fixture values.",
        messages: userMessages,
        providerModel: { providerId: "fixture", modelId: "fixture-model" },
        grant,
        capabilities,
        signal: new AbortController().signal,
      });
      await done;

      expect(capabilities.invocations).toEqual([]);
      expect(store.getRun(runId)).toMatchObject({ status: "failed" });
    }
  });

  it("retries a transient model error only before visible output", async () => {
    const requests: ModelGenerateRequest[] = [];
    let attempts = 0;
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        attempts++;
        if (attempts === 1) throw new FixtureModelAdapterError("temporary refusal", "transient", true, true, false);
        yield { type: "content.delta", kind: "assistant_text", delta: "Recovered answer." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(requests).toHaveLength(2);
    expect(store.getRun(runId)).toMatchObject({ status: "completed", modelRounds: 2 });
  });

  it("does not retry a transient model error after visible output", async () => {
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        yield { type: "content.delta", kind: "assistant_text", delta: "Partial answer." };
        throw new FixtureModelAdapterError("connection dropped", "transient", true, false, true);
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", modelRounds: 1 });
  });

  it("stops before retry when interrupted during backoff", async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let requests = 0;
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests: [],
      generate(request) {
        requests++;
        request.signal.throwIfAborted();
        notifyStarted();
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async (): Promise<IteratorResult<ModelEvent>> => {
                throw new FixtureModelAdapterError("temporary refusal", "transient", true, true, false);
              },
            };
          },
        };
      },
    };
    const capabilities = testCapabilitySession([]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await started;
    await engine.interrupt(runId);
    await done;

    expect(requests).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "interrupted" });
  });

  it("marks uncertain capability results recovery required without replay", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-uncertain", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Do not repeat." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(["call-uncertain"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    engine.onEvent("thread-1", (event) => events.push(event));

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Run the fixture operation once.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(capabilities.invocations).toEqual(["call-uncertain"]);
    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.calls.get(`${runId}:call-uncertain`)).toMatchObject({ status: "recovery_required" });
    expect(store.getRun(runId)).toMatchObject({ status: "recovery_required" });
    expect(events.some((event) => event.type === "run.recovery_required")).toBe(true);
  });

  it("fails closed when a dispatched capability throws", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-throws", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Do not retry." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(["call-throws"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Run the fixture operation once.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(capabilities.invocations).toEqual(["call-throws"]);
    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.calls.get(`${runId}:call-throws`)).toMatchObject({ status: "recovery_required" });
    expect(store.getRun(runId)).toMatchObject({ status: "recovery_required" });
  });

  it("fails closed when a capability returns images the model cannot receive", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "tool_calls", calls: [{ id: "call-image", name: "read-a", arguments: { value: "a" } }] },
      { type: "completed", finishReason: "tool_calls" },
    ], [
      { type: "content.delta", kind: "assistant_text", delta: "Should not run." },
      { type: "completed", finishReason: "stop" },
    ]]);
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(["call-image"]));
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Take a screenshot.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
  });

  it("interrupts without retry after visible output", async () => {
    let signalSeen: AbortSignal | undefined;
    let deltaResolved!: () => void;
    const deltaSeen = new Promise<void>((resolve) => { deltaResolved = resolve; });
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        signalSeen = request.signal;
        yield { type: "content.delta", kind: "assistant_text", delta: "Partial answer" };
        deltaResolved();
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
        request.signal.throwIfAborted();
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const capabilities = testCapabilitySession([descriptor("read-a")]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Start a long answer.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    const completedBeforeDelta = await Promise.race([deltaSeen.then(() => false), done.then(() => true)]);
    expect(completedBeforeDelta).toBe(false);
    expect(signalSeen?.aborted).toBe(false);

    await engine.interrupt(runId);
    await done;

    expect(requests).toHaveLength(1);
    expect(store.getRun(runId)).toMatchObject({ status: "interrupted" });
    expect(capabilities.invocations).toEqual([]);
    expect(signalSeen?.aborted).toBe(true);
  });

  it("sends a turn's images as user content parts", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "content.delta", kind: "assistant_text", delta: "Saw the image." },
        { type: "completed", finishReason: "stop" },
      ],
    ], { ...supportedCapabilities, imageInput: "supported" });
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store: testRunStore() });

    const { done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Describe it.",
      messages: userMessages,
      images: [{ mimeType: "image/png", data: "fixture" }],
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await done;

    expect(modelAdapter.requests[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe it." },
        { type: "image", mimeType: "image/png", data: "fixture" },
      ],
    });
  });

  it("returns tool images to a vision model and refuses them for a text-only model", async () => {
    const rounds = [
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Saw the screenshot." },
        { type: "completed", finishReason: "stop" },
      ],
    ] as const;
    const vision = testModelAdapter(rounds, { ...supportedCapabilities, imageInput: "supported" });
    const visionStore = testRunStore();
    const visionEngine = createAgentEngine({ adapters: registryFor(vision), store: visionStore });
    const visionRun = await visionEngine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Look at the screenshot.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(["call-a"])),
      signal: new AbortController().signal,
    });
    await visionRun.done;

    expect(visionStore.getRun(visionRun.runId)).toMatchObject({ status: "completed" });
    expect(vision.requests[1]?.messages).toContainEqual({
      role: "user",
      content: [
        { type: "text", text: "Screenshot result from tool call call-a:" },
        { type: "image", mimeType: "image/png", data: "fixture" },
      ],
    });

    const textOnly = testModelAdapter([rounds[0]]);
    const textStore = testRunStore();
    const textEngine = createAgentEngine({ adapters: registryFor(textOnly), store: textStore });
    const textRun = await textEngine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Look at the screenshot.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(["call-a"])),
      signal: new AbortController().signal,
    });
    await textRun.done;

    expect(textStore.getRun(textRun.runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
    expect(textOnly.requests).toHaveLength(1);
  });

  it("retries once without tools when every offered tool is optional", async () => {
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new FixtureModelAdapterError("tools are not supported", "unsupported_tools", false, false, false);
        }
        yield { type: "content.delta", kind: "assistant_text", delta: "Answered without tools." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Say hello.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([{ ...descriptor("read-a"), optional: true }]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[1]?.tools).toHaveLength(0);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed", modelRounds: 2 });
  });

  it("fails instead of dropping a tool the turn needs", async () => {
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          throw new FixtureModelAdapterError("tools are not supported", "unsupported_tools", false, false, false);
        }
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(requests).toHaveLength(1);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "failed", failureCode: "unsupported_tools" });
  });

  it("shrinks history once when the provider rejects the request size", async () => {
    const requests: ModelGenerateRequest[] = [];
    const history: ModelMessage[] = [
      { role: "system", content: "system prompt" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `old message ${index}`,
      })),
      { role: "user", content: [{ type: "text", text: "old image" }, { type: "image", mimeType: "image/png", data: "x" }] },
      { role: "assistant", content: null, toolCalls: [{ id: "call-old", name: "read-a", arguments: { value: "a" } }] },
      { role: "tool", content: "x".repeat(5_000), toolCallId: "call-old" },
    ];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push({ ...request, messages: [...request.messages] });
        if (requests.length === 1) {
          throw new FixtureModelAdapterError("too large", "request_too_large", false, false, false);
        }
        yield { type: "content.delta", kind: "assistant_text", delta: "Done after shrinking." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Continue.",
      messages: history,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.length).toBeLessThan(requests[0]!.messages.length);
    expect(requests[1]!.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"))).toBe(false);
    const tool = requests[1]!.messages.find((message) => message.role === "tool");
    const toolText = typeof tool?.content === "string" ? tool.content : "";
    expect(toolText.length).toBeLessThan(2_100);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed" });
  });

  it("fails with a clear code when the request stays too large", async () => {
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        if (requests.length > 0) {
          throw new FixtureModelAdapterError("too large", "request_too_large", false, false, false);
        }
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Continue.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(requests).toHaveLength(3);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "failed", failureCode: "request_too_large" });
  });

  it("summarizes older history when the prompt crosses the context budget", async () => {
    const requests: ModelGenerateRequest[] = [];
    const history: ModelMessage[] = [
      { role: "system", content: "system prompt" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `message ${index} ${"x".repeat(10_000)}`,
      })),
    ];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([], { ...supportedCapabilities, contextWindow: { status: "known", value: 32_000 } }),
      requests,
      async *generate(request) {
        requests.push({ ...request, messages: [...request.messages] });
        const compacting = typeof request.messages[0]?.content === "string"
          && request.messages[0].content.includes("You are compacting an agent conversation");
        yield {
          type: "content.delta",
          kind: "assistant_text",
          delta: compacting ? "Objective, files, and test results preserved." : "Done.",
        };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Continue the task.",
      messages: history,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toHaveLength(0);
    expect(requests[1]?.messages.some((message) => typeof message.content === "string" && message.content.includes("[Earlier conversation summary"))).toBe(true);
    expect(requests[1]!.messages.length).toBeLessThan(history.length + 1);
    expect(store.compactions).toHaveLength(1);
    expect(store.compactions[0]).toMatchObject({ trigger: "auto" });
    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed" });
  });

  it("keeps the original history when the summary call fails", async () => {
    const requests: ModelGenerateRequest[] = [];
    const history: ModelMessage[] = [
      { role: "system", content: "system prompt" },
      ...Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `message ${index} ${"x".repeat(10_000)}`,
      })),
    ];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([], { ...supportedCapabilities, contextWindow: { status: "known", value: 32_000 } }),
      requests,
      async *generate(request) {
        requests.push({ ...request, messages: [...request.messages] });
        const compacting = typeof request.messages[0]?.content === "string"
          && request.messages[0].content.includes("You are compacting an agent conversation");
        if (compacting) throw new Error("summary unavailable");
        yield { type: "content.delta", kind: "assistant_text", delta: "Done." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Continue the task.",
      messages: history,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(store.compactions).toHaveLength(0);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed" });
  });

  it("caps a large tool output and exposes the stored remainder through tool_output_read", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "tool_calls", calls: [{ id: "call-read", name: "tool_output_read", arguments: { callId: "call-a", offset: 8_000, limit: 100 } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Read the remainder." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const store = testRunStore();
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(), new Set(["call-a"]));
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const outputGrant: CapabilityGrant = { ...grant, allowed: new Set([...grant.allowed, "tool_output_read"]) };

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the large fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant: outputGrant,
      capabilities,
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed" });
    expect(store.outputs.get(`${handle.runId}:call-a`)?.content).toHaveLength(20_000);
    expect(capabilities.invocations).toEqual(["call-a"]);

    const firstTool = modelAdapter.requests[1]!.messages.find((message) => message.role === "tool" && message.toolCallId === "call-a");
    const firstPayload = JSON.parse(firstTool?.content as string) as { result: string; outputRef?: { truncated?: boolean } };
    expect(firstPayload.outputRef?.truncated).toBe(true);
    expect(firstPayload.result.length).toBeLessThan(8_500);
    expect(firstPayload.result).toContain("tool_output_read");

    expect(modelAdapter.requests[1]!.tools.map((tool) => tool.name)).toContain("tool_output_read");
    const readTool = modelAdapter.requests[2]!.messages.find((message) => message.role === "tool" && message.toolCallId === "call-read");
    const readPayload = JSON.parse(readTool?.content as string) as { result: string };
    expect(JSON.parse(readPayload.result)).toMatchObject({ callId: "call-a", offset: 8_000, limit: 100, totalChars: 20_000, nextOffset: 8_100 });
    expect((JSON.parse(readPayload.result) as { content: string }).content).toHaveLength(100);
  });

  it("does not expose tool_output_read when the capability grant excludes it", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "tool_calls", calls: [{ id: "call-read", name: "tool_output_read", arguments: { callId: "call-a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
    ]);
    const store = testRunStore();
    const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(), new Set(), new Set(["call-a"]));
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Try to read a stored result without that grant.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
    });
    await handle.done;

    expect(modelAdapter.requests[1]!.tools.map((tool) => tool.name)).not.toContain("tool_output_read");
    expect(store.getRun(handle.runId)).toMatchObject({ status: "failed", failureCode: "capability_not_granted" });
    expect(capabilities.invocations).toEqual(["call-a"]);
  });

  it("stops a turn when the token budget is exhausted", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "usage", input: 1000, output: 1000 },
        { type: "content.delta", kind: "assistant_text", delta: "Answered." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Do the task.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
      budget: { maxTokens: 1500 },
    });
    await handle.done;

    expect(modelAdapter.requests).toHaveLength(1);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "failed", failureCode: "budget_exhausted" });
  });

  it("steers a running turn before the next round and refuses after it finishes", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requests: ModelGenerateRequest[] = [];
    const modelAdapter: TestModelAdapter = {
      ...testModelAdapter([]),
      requests,
      async *generate(request) {
        requests.push(request);
        if (requests.length === 1) {
          entered();
          await held;
          yield { type: "content.delta", kind: "assistant_text", delta: "First answer." };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield { type: "content.delta", kind: "assistant_text", delta: "Corrected answer." };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

    const handle = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Start the task.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await started;
    expect(await engine.steer(handle.runId, "Use the corrected value.")).toBe("steered");
    release();
    await handle.done;

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-2)).toEqual([
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Use the corrected value." },
    ]);
    expect(store.getRun(handle.runId)).toMatchObject({ status: "completed", modelRounds: 2 });
    expect(await engine.steer(handle.runId, "Too late.")).toBe("refused");
  });

  it("nudges an announced action and continues to a tool call", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "content.delta", kind: "assistant_text", delta: "Let me check the fixture." },
        { type: "completed", finishReason: "stop" },
      ],
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Verified." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store: testRunStore() });

    const { done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Check the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
      nudgeAnnouncedAction: true,
    });
    await done;

    expect(modelAdapter.requests).toHaveLength(3);
    const nudged = modelAdapter.requests[1]!.messages;
    const nudgeIndex = nudged.findIndex((message) => message.role === "user" && typeof message.content === "string" && message.content.includes("called no tool"));
    expect(nudgeIndex).toBeGreaterThan(0);
    expect(nudged[nudgeIndex - 1]).toEqual({ role: "assistant", content: "Let me check the fixture." });
  });


  it("applies pre_tool_use modifiedArguments to the tool call", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "original" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Done with the modified value." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const received: unknown[] = [];
    const baseSession = testCapabilitySession([descriptor("read-a")]);
    const baseInvoke = baseSession.invoke.bind(baseSession);
    const capabilities: CapabilitySession = {
      list: () => [descriptor("read-a")],
      validate: () => {},
      async invoke(call, ctx) {
        received.push(call.arguments);
        return baseInvoke(call, ctx);
      },
      close: async () => {},
    };
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    engine.onEvent("thread-1", (event) => events.push(event));

    let preHookInvoked = false;
    const hooks = {
      run: async (
        event: "pre_tool_use" | "post_tool_use" | "pre_compact" | "stop" | "session_start" | "session_end",
        _context: { readonly runId: string; readonly threadId: string; readonly botId: string; readonly capabilityId?: string; readonly callId?: string; readonly arguments?: unknown; readonly result?: { readonly ok: boolean; readonly content: string }; readonly reason?: string },
      ) => {
        if (event === "pre_tool_use") {
          preHookInvoked = true;
          return { allow: true, messages: [], modifiedArguments: { value: "modified" } };
        }
        return { allow: true, messages: [] };
      },
    };

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities,
      signal: new AbortController().signal,
      hooks,
    });
    await done;

    expect(preHookInvoked).toBe(true);
    expect(received).toEqual([{ value: "modified" }]);
    expect(store.getRun(runId)).toMatchObject({ status: "completed" });
    const toolResults = events.filter((event) => event.type === "tool.result");
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).result.ok).toBe(true);
  });

  it("denies a tool result and fails the run when post_tool_use blocks", async () => {
    const modelAdapter = testModelAdapter([
      [
        { type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ],
      [
        { type: "content.delta", kind: "assistant_text", delta: "Final answer after denial." },
        { type: "completed", finishReason: "stop" },
      ],
    ]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const events: AgentEvent[] = [];
    engine.onEvent("thread-1", (event) => events.push(event));

    const hooks = {
      run: async (
        event: "pre_tool_use" | "post_tool_use" | "pre_compact" | "stop" | "session_start" | "session_end",
        _context: { readonly runId: string; readonly threadId: string; readonly botId: string; readonly capabilityId?: string; readonly callId?: string; readonly arguments?: unknown; readonly result?: { readonly ok: boolean; readonly content: string }; readonly reason?: string },
      ) => {
        if (event === "post_tool_use") {
          return { allow: false, messages: ["unsafe operation"], modifiedArguments: undefined };
        }
        return { allow: true, messages: [] };
      },
    };

    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
      hooks,
    });
    await done;

    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "capability_failed" });
    const toolResults = events.filter((event) => event.type === "tool.result");
    expect(toolResults.some((event) => (event as any).result.ok === false && (event as any).result.content === "unsafe operation")).toBe(true);
  });

  it("accepts Anthropic end_turn as a normal finish (M2)", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "content.delta", kind: "assistant_text", delta: "Done." },
      { type: "completed", finishReason: "end_turn" },
    ]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1", threadId: "thread-1", text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
      grant, capabilities: testCapabilitySession([]),
      signal: new AbortController().signal,
    });
    await done;
    expect(store.getRun(runId)).toMatchObject({ status: "completed" });
  });

  it("accepts Gemini STOP as a normal finish (M2)", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "content.delta", kind: "assistant_text", delta: "Done." },
      { type: "completed", finishReason: "STOP" },
    ]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1", threadId: "thread-1", text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "gemini", modelId: "gemini-2.0-flash" },
      grant, capabilities: testCapabilitySession([]),
      signal: new AbortController().signal,
    });
    await done;
    expect(store.getRun(runId)).toMatchObject({ status: "completed" });
  });

  it("accepts OpenAI Responses completed as a normal finish (M2)", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "content.delta", kind: "assistant_text", delta: "Done." },
      { type: "completed", finishReason: "completed" },
    ]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1", threadId: "thread-1", text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "openai", modelId: "gpt-4o" },
      grant, capabilities: testCapabilitySession([]),
      signal: new AbortController().signal,
    });
    await done;
    expect(store.getRun(runId)).toMatchObject({ status: "completed" });
  });

  it("rejects max_tokens as an incomplete finish (M2)", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "content.delta", kind: "assistant_text", delta: "Parti" },
      { type: "completed", finishReason: "max_tokens" },
    ]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1", threadId: "thread-1", text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant, capabilities: testCapabilitySession([]),
      signal: new AbortController().signal,
    });
    await done;
    expect(store.getRun(runId)).toMatchObject({ status: "failed" });
  });

  it("rejects SAFETY as an incomplete finish (M2)", async () => {
    const modelAdapter = testModelAdapter([[
      { type: "content.delta", kind: "assistant_text", delta: "Parti" },
      { type: "completed", finishReason: "SAFETY" },
    ]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
    const { runId, done } = await engine.run({
      botId: "bot-1", threadId: "thread-1", text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant, capabilities: testCapabilitySession([]),
      signal: new AbortController().signal,
    });
    await done;
    expect(store.getRun(runId)).toMatchObject({ status: "failed" });
  });

  describe("Phase 4: uncertain effects and process lifecycle (M5/M6)", () => {
    it("stops the batch on an uncertain tool result without replaying", async () => {
      const modelAdapter = testModelAdapter([[
        { type: "tool_calls", calls: [{ id: "call-uncertain", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ], [
        { type: "content.delta", kind: "assistant_text", delta: "Should not run after uncertain." },
        { type: "completed", finishReason: "stop" },
      ]]);
      const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(["call-uncertain"]));
      const store = testRunStore();
      const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });
      const events: AgentEvent[] = [];
      engine.onEvent("thread-1", (event) => events.push(event));

      const { runId, done } = await engine.run({
        botId: "bot-1", threadId: "thread-1", text: "Run once.",
        messages: userMessages,
        providerModel: { providerId: "fixture", modelId: "fixture-model" },
        grant, capabilities,
        signal: new AbortController().signal,
      });
      await done;

      expect(capabilities.invocations).toEqual(["call-uncertain"]);
      expect(modelAdapter.requests).toHaveLength(1);
      expect(store.calls.get(`${runId}:call-uncertain`)).toMatchObject({ status: "recovery_required" });
      expect(store.getRun(runId)).toMatchObject({ status: "recovery_required", failureCode: "uncertain" });
      expect(events.some((event) => event.type === "run.recovery_required")).toBe(true);
      expect(events.some((event) => event.type === "run.failed")).toBe(false);
    });

    it("stops the batch when a dispatched capability throws (uncertain outcome)", async () => {
      const modelAdapter = testModelAdapter([[
        { type: "tool_calls", calls: [{ id: "call-throws", name: "read-a", arguments: { value: "a" } }] },
        { type: "completed", finishReason: "tool_calls" },
      ], [
        { type: "content.delta", kind: "assistant_text", delta: "Should not run after throw." },
        { type: "completed", finishReason: "stop" },
      ]]);
      const capabilities = testCapabilitySession([descriptor("read-a")], new Set(), new Set(), new Set(["call-throws"]));
      const store = testRunStore();
      const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store });

      const { runId, done } = await engine.run({
        botId: "bot-1", threadId: "thread-1", text: "Run once.",
        messages: userMessages,
        providerModel: { providerId: "fixture", modelId: "fixture-model" },
        grant, capabilities,
        signal: new AbortController().signal,
      });
      await done;

      expect(capabilities.invocations).toEqual(["call-throws"]);
      expect(modelAdapter.requests).toHaveLength(1);
      expect(store.calls.get(`${runId}:call-throws`)).toMatchObject({ status: "recovery_required" });
      expect(store.getRun(runId)).toMatchObject({ status: "recovery_required", failureCode: "uncertain_side_effect" });
    });

    it("tracks recoverUnsettledRuns calls on the store", () => {
      const store = testRunStore();
      store.recoverUnsettledRuns(1_700_000_000_000);
      store.recoverUnsettledRuns(1_700_000_001_000);
      expect(store.recoverCalls).toEqual([1_700_000_000_000, 1_700_000_001_000]);
    });
  });

  describe("live capability probe", () => {

  function probeRunner(results: ReadonlyArray<LiveProbeResult | null>) {
    let calls = 0;
    return {
      run: async (_adapter: ModelAdapter, _modelId: string): Promise<LiveProbeResult | null> => {
        calls++;
        return results[calls - 1] ?? results[results.length - 1];
      },
      get calls(): number { return calls; },
    };
  }

  it("overrides static tools hint with live probe result (unsupported → run fails)", async () => {
    const probe = probeRunner([{ tools: false, streaming: true, imageInput: false, latencyMs: 5 }]);
    const modelAdapter = testModelAdapter([[{ type: "completed", finishReason: "stop" }]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store, probe });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await done;
    expect(probe.calls).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "failed", failureCode: "unsupported_capability" });
  });

  it("falls back to static capabilities when the probe reports an error", async () => {
    const probe = probeRunner([null]);
    const modelAdapter = testModelAdapter([[{ type: "content.delta", kind: "assistant_text", delta: "ok" }, { type: "completed", finishReason: "stop" }]]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store, probe });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer safely.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await done;
    expect(probe.calls).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "completed" });
  });

  it("caches the live probe result per model so it is not repeated across runs", async () => {
    const probe = probeRunner([{ tools: true, streaming: true, imageInput: false, latencyMs: 3 }]);
    const modelAdapter = testModelAdapter([
      [{ type: "content.delta", kind: "assistant_text", delta: "ok" }, { type: "completed", finishReason: "stop" }],
      [{ type: "content.delta", kind: "assistant_text", delta: "ok" }, { type: "completed", finishReason: "stop" }],
    ]);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store, probe });
    const makeRun = (modelId: string) => engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Answer.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: modelId },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    const { runId: firstId, done: firstDone } = await makeRun("fixture-model");
    await firstDone;
    const { runId: secondId, done: secondDone } = await makeRun("fixture-model");
    await secondDone;
    expect(probe.calls).toBe(1);
    expect(store.getRun(firstId)).toMatchObject({ status: "completed" });
    expect(store.getRun(secondId)).toMatchObject({ status: "completed" });
  });

  it("enables tools when the live probe says supported but static hints do not", async () => {
    const probe = probeRunner([{ tools: true, streaming: true, imageInput: false, latencyMs: 4 }]);
    const unsupportedCapabilities: ModelCapabilities = { ...supportedCapabilities, tools: "unsupported" };
    const modelAdapter = testModelAdapter([
      [{ type: "tool_calls", calls: [{ id: "call-a", name: "read-a", arguments: { value: "a" } }] }, { type: "completed", finishReason: "tool_calls" }],
      [{ type: "content.delta", kind: "assistant_text", delta: "done" }, { type: "completed", finishReason: "stop" }],
    ], unsupportedCapabilities);
    const store = testRunStore();
    const engine = createAgentEngine({ adapters: registryFor(modelAdapter), store, probe });
    const { runId, done } = await engine.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Read the fixture.",
      messages: userMessages,
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant,
      capabilities: testCapabilitySession([descriptor("read-a")]),
      signal: new AbortController().signal,
    });
    await done;
    expect(probe.calls).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "completed", modelRounds: 2 });
  });
});

describe("compactionKeepTokens", () => {
  it("is proportional to the context window and clamped", () => {
    expect(compactionKeepTokens({ status: "unknown" })).toBe(32_000);
    expect(compactionKeepTokens({ status: "known", value: 32_000 })).toBe(8_000);
    expect(compactionKeepTokens({ status: "known", value: 128_000 })).toBe(32_000);
    expect(compactionKeepTokens({ status: "known", value: 64_000 })).toBe(16_000);
  });
});
});
