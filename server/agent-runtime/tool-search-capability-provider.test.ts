import { describe, expect, it } from "vitest";

import { ToolSearchCapabilityProvider } from "./tool-search-capability-provider.ts";
import type { CapabilityGrant } from "./contracts.ts";

const grant: CapabilityGrant = { botId: "b", threadId: "t", approvalMode: "full", allowed: new Set(), denied: new Set() };

describe("ToolSearchCapabilityProvider", () => {
  it("lists tool_search capability", () => {
    const session = { list: () => [{ id: "write_file", name: "write_file", description: "Write a file", schema: {}, risk: "write" as const, sideEffect: true, timeoutMs: 1000 }] };
    const p = new ToolSearchCapabilityProvider(() => session as any);
    expect(p.list(grant).map((d) => d.id)).toEqual(["native:tool-search"]);
  });

  it("searches and returns matching tools", async () => {
    const session = { list: () => [{ id: "write_file", name: "write_file", description: "Write a file", schema: {}, risk: "write" as const, sideEffect: true, timeoutMs: 1000 }] };
    const p = new ToolSearchCapabilityProvider(() => session as any);
    const r = await p.invoke({ runId: "r", callId: "c", capabilityId: "native:tool-search", arguments: { query: "write" }, botId: "b", threadId: "t" }, { grant, signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("write_file");
  });

  it("returns no matches for unknown query", async () => {
    const session = { list: () => [{ id: "write_file", name: "write_file", description: "Write a file", schema: {}, risk: "write" as const, sideEffect: true, timeoutMs: 1000 }] };
    const p = new ToolSearchCapabilityProvider(() => session as any);
    const r = await p.invoke({ runId: "r", callId: "c", capabilityId: "native:tool-search", arguments: { query: "zzzzz" }, botId: "b", threadId: "t" }, { grant, signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("No matching");
  });
});
