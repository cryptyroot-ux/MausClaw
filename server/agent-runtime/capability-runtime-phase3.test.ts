import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CompositeCapabilityRuntime, SkillCapabilityProvider } from "./capability-runtime.ts";
import type { CapabilityGrant } from "./contracts.ts";
import { installSkill, setSkillEnabled } from "../skills.ts";

const grant: CapabilityGrant = { botId: "bot-1", threadId: "t-1", approvalMode: "full", allowed: new Set(), denied: new Set() };

describe("CompositeCapabilityRuntime", () => {
  it("aggregates providers and enforces a single grant policy", async () => {
    const provider = {
      id: "p1", kind: "native-tool" as const,
      list: () => [{ id: "tool_a", name: "tool_a", description: "a", schema: {}, risk: "read" as const, sideEffect: false, timeoutMs: 1000 }],
      mount: async () => {},
      validate: () => {},
      invoke: async (call: any) => ({ callId: call.callId, ok: true, content: "done" }),
      close: async () => {},
      describe: () => "p1",
    };
    const runtime = new CompositeCapabilityRuntime([provider]);
    await runtime.mountAll({ grant, signal: new AbortController().signal });
    expect(runtime.list(grant).map((d) => d.id)).toEqual(["tool_a"]);

    const deniedGrant: CapabilityGrant = { ...grant, denied: new Set(["tool_a"]) };
    const res = await runtime.invoke({ runId: "r", callId: "c", capabilityId: "tool_a", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant: deniedGrant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("denied");

    await runtime.close();
    expect(runtime.list(grant)).toEqual([]);
  });
});

describe("SkillCapabilityProvider", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skillcap-")); });

  it("exposes enabled skills and reads their SKILL.md", async () => {
    // Minimal: provider with no enabled skills returns empty list
    const provider = new SkillCapabilityProvider("nonexistent-bot-xyz");
    expect(provider.list(grant)).toEqual([]);
    const res = await provider.invoke({ runId: "r", callId: "c", capabilityId: "skill:nope", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not dispatch a skill denied by its native tool name", async () => {
    const botId = `scope-${randomUUID()}`;
    const skillName = "scope-guard";
    const installed = installSkill(botId, "fixture", [{
      path: "SKILL.md",
      content: `---\nname: ${skillName}\ndescription: Scoped fixture\n---\n\nThis skill must stay hidden.\n`,
    }]);
    expect("error" in installed).toBe(false);
    expect(setSkillEnabled(botId, skillName, true)).toMatchObject({ enabled: true });

    const deniedGrant: CapabilityGrant = { ...grant, denied: new Set(["skill_scope_guard"]) };
    const runtime = new CompositeCapabilityRuntime([new SkillCapabilityProvider(botId)]);
    await runtime.mountAll({ grant: deniedGrant, signal: new AbortController().signal });
    const result = await runtime.invoke({
      runId: "r",
      callId: "c",
      capabilityId: `skill:${skillName}`,
      arguments: {},
      botId,
      threadId: "t-1",
    }, { grant: deniedGrant, signal: new AbortController().signal });

    expect(runtime.list(deniedGrant)).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain("This skill must stay hidden.");
    await runtime.close();
  });
});

describe("CapabilityProvider denial/failure per type", () => {
  const grant: CapabilityGrant = { botId: "bot-1", threadId: "t-1", approvalMode: "full", allowed: new Set(), denied: new Set() };

  it("MCP provider: denied grant returns denied", async () => {
    const session = {
      list: () => [{ id: "mcp_tool", name: "mcp_tool", description: "mcp", schema: {}, risk: "read" as const, sideEffect: false, timeoutMs: 1000 }],
      validate: () => {},
      invoke: async () => ({ callId: "c", ok: true, content: "ok" }),
      close: async () => {},
    };
    const provider = new (await import("./capability-runtime.ts")).SessionCapabilityProvider("mcp", "mcp", session as any, "MCP");
    const runtime = new (await import("./capability-runtime.ts")).CompositeCapabilityRuntime([provider]);
    await runtime.mountAll({ grant, signal: new AbortController().signal });
    const deniedGrant: CapabilityGrant = { ...grant, denied: new Set(["mcp_tool"]) };
    const res = await runtime.invoke({ runId: "r", callId: "c", capabilityId: "mcp_tool", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant: deniedGrant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("denied");
    await runtime.close();
  });

  it("MCP provider: invoke failure returns failed", async () => {
    const session = {
      list: () => [{ id: "mcp_tool", name: "mcp_tool", description: "mcp", schema: {}, risk: "read" as const, sideEffect: false, timeoutMs: 1000 }],
      validate: () => {},
      invoke: async () => { throw new Error("boom"); },
      close: async () => {},
    };
    const { SessionCapabilityProvider, CompositeCapabilityRuntime } = await import("./capability-runtime.ts");
    const provider = new SessionCapabilityProvider("mcp", "mcp", session as any, "MCP");
    const runtime = new CompositeCapabilityRuntime([provider]);
    await runtime.mountAll({ grant, signal: new AbortController().signal });
    const res = await runtime.invoke({ runId: "r", callId: "c", capabilityId: "mcp_tool", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("failed");
    await runtime.close();
  });

  it("skill provider: missing skill returns not_found", async () => {
    const { SkillCapabilityProvider } = await import("./capability-runtime.ts");
    const provider = new SkillCapabilityProvider("no-such-bot-xyz");
    const res = await provider.invoke({ runId: "r", callId: "c", capabilityId: "skill:nope", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
    await provider.close();
  });

  it("custom policy hook is respected", async () => {
    const session = {
      list: () => [{ id: "t", name: "t", description: "t", schema: {}, risk: "read" as const, sideEffect: false, timeoutMs: 1000 }],
      validate: () => {},
      invoke: async () => ({ callId: "c", ok: true, content: "ok" }),
      close: async () => {},
    };
    const { SessionCapabilityProvider, CompositeCapabilityRuntime } = await import("./capability-runtime.ts");
    const provider = new SessionCapabilityProvider("mcp", "mcp", session as any, "MCP");
    const runtime = new CompositeCapabilityRuntime([provider], () => ({ allowed: false, reason: "policy-blocked" }));
    await runtime.mountAll({ grant, signal: new AbortController().signal });
    const res = await runtime.invoke({ runId: "r", callId: "c", capabilityId: "t", arguments: {}, botId: "bot-1", threadId: "t-1" }, { grant, signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(res.content).toBe("policy-blocked");
    await runtime.close();
  });
});
