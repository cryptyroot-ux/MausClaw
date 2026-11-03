import { describe, expect, it } from "vitest";

import { AgentTurnKernel } from "./agent-turn-kernel.ts";
import type {
  AgentRunRequest,
  AgentRunStore,
  CapabilityGrant,
  CapabilitySession,
  ModelAdapter,
  ModelCapabilities,
  ModelMessage,
} from "./contracts.ts";

function testRunStore(): AgentRunStore {
  const runs = new Map<string, import("./contracts.ts").AgentRunRecord>();
  return {
    createRun(record) {
      runs.set(record.runId, record);
    },
    getRun(runId) {
      return runs.get(runId);
    },
    updateRunProgress() {},
    transitionRun(runId, expected, next, updatedAt, failureCode) {
      const current = runs.get(runId);
      if (!current || current.status !== expected) return false;
      runs.set(runId, { ...current, status: next, updatedAt, ...(failureCode ? { failureCode } : {}) });
      return true;
    },
    beginCapabilityCall() {},
    settleCapabilityCall() {},
    recoverUnsettledRuns() {},
    recordCompaction() {},
    recordToolOutput() {},
    readToolOutput() {},
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

function testAdapter(text: string): ModelAdapter {
  return {
    providerId: "fixture",
    async discoverModels() {
      return { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture" }] };
    },
    capabilities() {
      return supportedCapabilities;
    },
    async *generate() {
      yield { type: "content.delta", kind: "assistant_text", delta: text };
      yield { type: "completed", finishReason: "stop" };
    },
  };
}

function testSession(): CapabilitySession {
  return {
    list() {
      return [
        { id: "echo", name: "echo", description: "Echo test", schema: { type: "object", properties: {} }, risk: "read" as const, sideEffect: false, timeoutMs: 5000 },
      ];
    },
    validate() {},
    async invoke(call) {
      return { callId: call.callId, ok: true, content: "echo result" };
    },
    async close() {},
  };
}

describe("AgentTurnKernel", () => {
  it("runs a simple turn to completion with no tools", async () => {
    const store = testRunStore();
    const kernel = new AgentTurnKernel({
      adapters: { resolve: () => testAdapter("Hello from the kernel") },
      store,
      createCapabilities: ({ capabilities }) => capabilities,
    });

    const handle = await kernel.run({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Say hello",
      messages: [],
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant: { botId: "bot-1", threadId: "thread-1", approvalMode: "ask", allowed: new Set(), denied: new Set() },
      capabilities: testSession(),
      signal: new AbortController().signal,
    });

    await handle.done;
    const run = store.getRun(handle.runId)!;
    expect(run.status).toBe("completed");
  });

  it("interrupts a running turn", async () => {
    const store = testRunStore();
    const kernel = new AgentTurnKernel({
      adapters: { resolve: () => testAdapter("") },
      store,
      createCapabilities: ({ capabilities }) => capabilities,
    });

    const controller = new AbortController();
    const handle = await kernel.run({
      botId: "bot-1",
      threadId: "thread-2",
      text: "Say hello",
      messages: [],
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      grant: { botId: "bot-1", threadId: "thread-2", approvalMode: "ask", allowed: new Set(), denied: new Set() },
      capabilities: testSession(),
      signal: controller.signal,
    });

    await kernel.interrupt(handle.runId);
    await handle.done.catch(() => {});
    const run = store.getRun(handle.runId)!;
    expect(run.status).toBe("interrupted");
  });

  it("tracks model request count and disables tools on the last request when maxTurnRequests is set", async () => {
    const store = testRunStore();
    const generateCalls: Array<{ readonly tools: unknown[]; readonly attempt: number }> = [];

    function countingAdapter(): ModelAdapter {
      let attempt = 0;
      return {
        providerId: "fixture",
        async discoverModels() {
          return { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture" }] };
        },
        capabilities() {
          return supportedCapabilities;
        },
        async *generate(request: { readonly tools?: unknown[] }) {
          attempt += 1;
          generateCalls.push({ tools: request.tools ?? [], attempt });
          if (attempt === 1) {
            // First request: ask for a tool call
            yield { type: "tool_calls", calls: [{ id: "tc-1", name: "echo", arguments: {} }] };
            yield { type: "completed", finishReason: null };
          } else {
            // Subsequent requests: final answer
            yield { type: "content.delta", kind: "assistant_text", delta: "done" };
            yield { type: "completed", finishReason: "stop" };
          }
        },
      };
    }

    const kernel = new AgentTurnKernel({
      adapters: { resolve: () => countingAdapter() },
      store,
      createCapabilities: ({ capabilities }) => capabilities,
    });

    const handle = await kernel.run({
      botId: "bot-1",
      threadId: "thread-3",
      text: "Do a thing",
      messages: [],
      providerModel: { providerId: "fixture", modelId: "fixture-model" },
      maxTurnRequests: 2,
      grant: { botId: "bot-1", threadId: "thread-3", approvalMode: "ask", allowed: new Set(), denied: new Set() },
      capabilities: testSession(),
      signal: new AbortController().signal,
    } as AgentRunRequest);

    await handle.done;
    const run = store.getRun(handle.runId)!;
    expect(run.status).toBe("completed");
    // Two generation attempts were made
    expect(generateCalls.length).toBe(2);
    // On the last (second) request, tools were disabled
    expect(generateCalls[generateCalls.length - 1].tools).toEqual([]);
  });
});
