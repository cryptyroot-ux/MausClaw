import { describe, expect, it, vi } from "vitest";

import { createChatCapabilitySession } from "./chat-capability-runtime.ts";
import type { ChatToolDefinition, ChatToolSession } from "../drivers/chat-mcp-tools.ts";
import type { CapabilityCall, CapabilityGrant } from "./contracts.ts";
import { ASK_USER_TOOL, ASK_USER_TOOL_DEFINITION } from "../../shared/ask-question.ts";

const definition = (name: string): ChatToolDefinition => ({
  type: "function",
  function: { name, description: `Fixture ${name}`, parameters: { type: "object" } },
});

const grant = (allowed: string[] = [], approvalMode: CapabilityGrant["approvalMode"] = "full"): CapabilityGrant => ({
  botId: "bot-1",
  threadId: "thread-1",
  approvalMode,
  allowed: new Set(allowed),
  denied: new Set(),
});

const call = (callId: string, capabilityId: string): CapabilityCall => ({
  runId: "run-1",
  callId,
  capabilityId,
  arguments: { value: "fixture" },
  botId: "bot-1",
  threadId: "thread-1",
});

function fakeSession(overrides: Partial<ChatToolSession> = {}): ChatToolSession & { executed: string[]; closed: number } {
  const executed: string[] = [];
  let closed = 0;
  return {
    definitions: [definition("read_file"), definition("write_file")],
    skipped: [],
    trimmed: [],
    validate: vi.fn(),
    view: (name) => ({ title: name, input: { value: "fixture" }, ask: name === "write_file" }),
    execute: async (name) => {
      executed.push(name);
      return { ok: true, text: `Result for ${name}` };
    },
    close: async () => { closed++; },
    get executed() { return executed; },
    get closed() { return closed; },
    ...overrides,
  };
}

function approval(allowed: boolean) {
  return {
    floored: vi.fn(() => null),
    ask: vi.fn(async () => allowed),
    question: vi.fn(async (): Promise<string | null> => null),
  };
}

describe("createChatCapabilitySession", () => {
  it("lists only in-scope chat capabilities", () => {
    const session = fakeSession();
    const bridge = createChatCapabilitySession({ session, approval: approval(true) });

    expect(bridge.list(grant(["mcp:read_file"])).map((item) => item.id)).toEqual(["mcp:read_file"]);
    expect(bridge.list(grant()).map((item) => item.id)).toEqual(["mcp:read_file", "mcp:write_file"]);
  });

  it("waits for approval before executing an ask-only capability", async () => {
    const session = fakeSession();
    const gate = approval(false);
    const bridge = createChatCapabilitySession({ session, approval: gate });

    const denied = await bridge.invoke(call("c1", "mcp:write_file"), { grant: grant([], "ask"), signal: new AbortController().signal });
    expect(gate.ask).toHaveBeenCalledOnce();
    expect(denied).toMatchObject({ ok: false, error: "denied" });
    expect(session.executed).toEqual([]);

    const allowedGate = approval(true);
    const allowedBridge = createChatCapabilitySession({ session, approval: allowedGate });
    const allowed = await allowedBridge.invoke(call("c2", "mcp:write_file"), { grant: grant([], "ask"), signal: new AbortController().signal });
    expect(allowed).toMatchObject({ ok: true, content: "Result for write_file" });
    expect(session.executed).toEqual(["write_file"]);
  });

  it("preserves mixed batch partial results without replay", async () => {
    const session = fakeSession();
    const gate = approval(true);
    gate.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const bridge = createChatCapabilitySession({ session, approval: gate });

    const denied = await bridge.invoke(call("c1", "mcp:write_file"), { grant: grant([], "ask"), signal: new AbortController().signal });
    const allowed = await bridge.invoke(call("c2", "mcp:write_file"), { grant: grant([], "ask"), signal: new AbortController().signal });

    expect(denied.ok).toBe(false);
    expect(allowed.ok).toBe(true);
    expect(session.executed).toEqual(["write_file"]);
    expect(gate.ask).toHaveBeenCalledTimes(2);
  });

  it("does not expose skill assets as capabilities", () => {
    const bridge = createChatCapabilitySession({
      session: fakeSession({ definitions: [definition("read_file")] }),
      approval: approval(true),
    });

    expect(bridge.list(grant())).toEqual([
      expect.objectContaining({ id: "mcp:read_file", name: "read_file" }),
    ]);
  });

  it("closes the chat session and refuses later invocation", async () => {
    const session = fakeSession();
    const bridge = createChatCapabilitySession({ session, approval: approval(true) });

    await bridge.close();
    await bridge.close();
    const result = await bridge.invoke(call("c1", "mcp:read_file"), { grant: grant(), signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: false, error: "closed" });
    expect(session.closed).toBe(1);
    expect(session.executed).toEqual([]);
  });

  it("marks a thrown post-dispatch session failure uncertain", async () => {
    const session = fakeSession({
      execute: async () => { throw new Error("MCP timeout after dispatch"); },
    });
    const bridge = createChatCapabilitySession({ session, approval: approval(true) });

    const result = await bridge.invoke(call("c1", "mcp:read_file"), { grant: grant(), signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: false, uncertain: true, error: "uncertain_side_effect" });
  });

  it("validates ask_user without a chat-session registration", () => {
    const validate = vi.fn(() => { throw new Error("chat session must not validate ask_user"); });
    const session = fakeSession({ definitions: [ASK_USER_TOOL_DEFINITION], validate });
    const bridge = createChatCapabilitySession({ session, approval: approval(true) });
    const ask = call("c1", ASK_USER_TOOL);
    (ask as { arguments: unknown }).arguments = { questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] };

    expect(() => bridge.validate(ask, grant())).not.toThrow();
    expect(validate).not.toHaveBeenCalled();
  });

  it("routes ask_user through the question approval without executing a tool", async () => {
    const session = fakeSession({ definitions: [ASK_USER_TOOL_DEFINITION] });
    const gate = approval(true);
    gate.question.mockResolvedValueOnce("Yes");
    const bridge = createChatCapabilitySession({ session, approval: gate });
    const ask = call("c1", ASK_USER_TOOL);
    (ask as { arguments: unknown }).arguments = { questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] };

    const result = await bridge.invoke(ask, { grant: grant(), signal: new AbortController().signal });

    expect(result).toMatchObject({ ok: true, content: "Yes" });
    expect(gate.question).toHaveBeenCalledOnce();
    expect(session.executed).toEqual([]);
  });
});
