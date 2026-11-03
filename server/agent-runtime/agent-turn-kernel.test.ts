import { describe, expect, it } from "vitest";

import { AgentTurnKernel } from "./agent-turn-kernel.ts";
import type {
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
      return [];
    },
    validate() {},
    async invoke() {
      return { callId: "unused", ok: true, content: "" };
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
      createCapabilities: () => testSession(),
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
      createCapabilities: () => testSession(),
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
});
