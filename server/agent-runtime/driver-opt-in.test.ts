import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";

const { OpenAICompatDriver } = await import("../drivers/openai-compat.ts");
const { closeMessageDb } = await import("../message-db.ts");
const { startFakeHttpMcp } = await import("../testing/fake-http-mcp-server.ts");
const { DATA_DIR } = await import("../config.ts");

afterAll(() => {
  closeMessageDb();
});

function json(response: import("node:http").ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function toolSearchRound(): unknown {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{
          id: "call-search",
          type: "function",
          function: { name: "tool_search", arguments: '{"query":"audit"}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };
}

function toolRound(): unknown {
  return {
    choices: [{
      message: {
        content: "",
        tool_calls: [{
          id: "call-1",
          type: "function",
          function: { name: "audit_echo", arguments: '{"value":"fixture"}' },
        }],
      },
      finish_reason: "tool_calls",
    }],
  };
}

function finalRound(text: string): unknown {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}

function waitForCompleted(instance: { onEvent(listener: (event: RuntimeEvent) => void): () => void }): Promise<RuntimeEvent> {
  return new Promise((resolve) => {
    const unsubscribe = instance.onEvent((event) => {
      if (event.type === "turn.completed") {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

describe("OpenAI-compatible native opt-in", () => {
  it("runs an allowlisted native turn through a real MCP tool, then keeps legacy turns legacy", async () => {
    const mcp = await startFakeHttpMcp({
      tools: [{ name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
      callResult: (params) => {
        const value = (params as { arguments?: { value?: unknown } }).arguments?.value;
        return { content: [{ type: "text", text: `echoed ${String(value)}` }] };
      },
    });
    const requests: Array<{ messages?: unknown; tools?: unknown; stream?: boolean }> = [];
    const modelServer = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part.toString();
      const parsed = JSON.parse(body) as { messages?: unknown; tools?: unknown; stream?: boolean };
      const firstContent = Array.isArray(parsed.messages) ? String(parsed.messages[0]?.content ?? "") : "";
      // The live probe sends a couple of trial generate calls before the real turn.
      // Answer them without consuming the canned turn responses.
      if (firstContent.includes("Reply with:")) {
        json(response, finalRound("ok"));
        return;
      }
      if (firstContent.includes("Use the noop tool")) {
        json(response, toolSearchRound());
        return;
      }
      requests.push(parsed);
      if (requests.length === 1) json(response, toolSearchRound());
      else if (requests.length === 2) json(response, toolRound());
      else json(response, finalRound(`answer-${requests.length}`));
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
    const origin = `http://127.0.0.1:${address.port}`;

    const instance = await OpenAICompatDriver.create({
      instanceId: "native-opt-in",
      displayName: "Native Opt-in",
      environment: { FIXTURE_KEY: "fixture-key" },
      enabled: true,
      config: { url: `${origin}/v1`, apiKeyEnv: "FIXTURE_KEY", model: "fixture-model", managedModels: ["fixture-model"] },
    });

    try {
      const integration = { custom: { audit: { type: "http" as const, url: mcp.url, headers: {} } } };
      const nativeCompleted = waitForCompleted(instance.adapter);
      await instance.adapter.sendTurn({
        threadId: "thread-native",
        botId: "bot-native",
        agentEngine: "mausclaw-native",
        text: "Use the audit tool.",
        model: "fixture-model",
        approvalMode: "full",
        integrations: integration,
      });
      expect(await nativeCompleted).toMatchObject({ ok: true });
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[1]?.tools)).toContain("audit_echo");
      expect(mcp.calls).toHaveLength(1);

      const legacyCompleted = waitForCompleted(instance.adapter);
      await instance.adapter.sendTurn({
        threadId: "thread-legacy",
        botId: "bot-legacy",
        agentEngine: "mausclaw-native",
        text: "Answer without the native engine.",
        model: "fixture-model",
        approvalMode: "full",
      });
      expect(await legacyCompleted).toMatchObject({ ok: true });
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[3]?.tools)).not.toContain("audit_echo");

      const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
      const runs = db.prepare("SELECT status, model_rounds, tool_calls FROM agent_runs").all() as Array<{ status: string; model_rounds: number; tool_calls: number }>;
      db.close();
      expect(runs).toEqual([
        { status: "completed", model_rounds: 3, tool_calls: 2 },
        { status: "completed", model_rounds: 1, tool_calls: 0 },
      ]);
    } finally {
      await instance.dispose();
      mcp.close();
      modelServer.closeAllConnections();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    }
  });
});
