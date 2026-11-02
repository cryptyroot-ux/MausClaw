import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlMausclaw } from "../scripts/control-mausclaw.ts";

const MCP_FIXTURE = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'native-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write the native verification artifact', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
  else if (request.method === 'tools/call' && request.params.name === 'write_file') {
    writeFileSync(process.env.NATIVE_ARTIFACT, request.params.arguments.content);
    result = { content: [{ type: 'text', text: 'created native artifact' }] };
  } else result = { content: [{ type: 'text', text: 'Unknown fixture operation' }], isError: true };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`;

function frame(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

it("a real isolated server runs an OpenAI-compatible bot through the native loop, approval, and MCP", async () => {
  const requests: Array<{ messages: Array<{ role: string; tool_call_id?: string }>; tools?: Array<{ function: { name: string; description?: string } }> }> = [];
  const upstream = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as typeof requests[number];
    // Skip live-capability probe calls: they carry no real capability
    // (tools: [] or only a trivial "noop" tool) and must not pollute the
    // recorded request list or trip the native-tool assertion below.
    const isProbeCall = !parsed.tools || parsed.tools.length === 0 || parsed.tools.every((t) => t.function.name === "noop");
    if (!isProbeCall) requests.push(parsed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (isProbeCall) {
      if (parsed.tools && parsed.tools.length > 0) {
        // Tools probe: the model should call the noop tool; answer with a
        // noop tool_calls event so the probe detects tools support.
        response.write(frame({ tool_calls: [{ index: 0, id: "noop-call", type: "function", function: { name: "noop", arguments: "{}" } }] }, null));
        response.end(frame({ tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: "" } }] }, "tool_calls") + "data: [DONE]\n\n");
      } else {
        // Streaming probe: just complete.
        response.end(frame({ content: "ok" }, "stop") + "data: [DONE]\n\n");
      }
      return;
    }
    const hasToolResult = parsed.messages.some((message) => message.role === "tool");
    if (hasToolResult) {
      response.end(frame({ content: "The native artifact was created." }, "stop") + "data: [DONE]\n\n");
      return;
    }
    const tool = parsed.tools?.find((item) => item.function.description?.includes("native verification artifact"));
    expect(tool).toBeTruthy();
    response.write(frame({ tool_calls: [{ index: 0, id: "native-call", type: "function", function: { name: tool!.function.name, arguments: '{"content":"native-verified"}' } }] }, null));
    response.end(frame({ tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: "" } }] }, "tool_calls") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = (args: string[]) => runControlMausclaw([...args, "--url", fixture.info.url]) as Promise<any>;

  try {
    await api("PATCH", "/api/config", {
      openaiCompat: { key: "synthetic-native-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" },
    });
    const script = join(fixture.info.dataDir, "native-mcp.mjs");
    const artifact = join(fixture.info.dataDir, "native-artifact.txt");
    writeFileSync(script, MCP_FIXTURE);
    await api("POST", "/api/mcp/servers", {
      name: "native",
      command: process.execPath,
      args: [script],
      env: { NATIVE_ARTIFACT: artifact },
      enabled: true,
    });
    await api("PATCH", "/api/mcp/servers/native", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Native probe"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, {
      mcpServers: ["native"],
      approvalMode: "ask",
      description: "Native verification assistant",
      soul: "Use the structured native tool when asked.",
    });
    mkdirSync(join(fixture.info.dataDir, "workspaces", bot.id), { recursive: true });

    expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Create the native artifact."])).success).toBe(true);
    const waiting = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
    expect(waiting.status).toBe("needs-user");
    expect(existsSync(artifact)).toBe(false);
    const bots = await api("GET", "/api/bots");
    const current = bots.bots.find((item: any) => item.id === bot.id);
    const card = current.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "allow" });
    const settled = await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20"]);
    expect(settled.status).toBe("settled");
    expect(readFileSync(artifact, "utf8")).toBe("native-verified");

    const instances = await api("GET", "/api/instances");
    expect(instances.instances.filter((item: any) => item.snapshot?.state === "available").map((item: any) => item.instanceId)).not.toContain("claude");

    const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    const runs = db.prepare("SELECT status, model_rounds, tool_calls FROM agent_runs").all() as Array<{ status: string; model_rounds: number; tool_calls: number }>;
    db.close();
    expect(runs).toEqual([{ status: "completed", model_rounds: 2, tool_calls: 1 }]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.some((message) => message.role === "tool" && message.tool_call_id === "native-call")).toBe(true);
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 60_000);
