// Tool search (Claude Code ToolSearch pattern): lets the model discover MCP tools
// by keyword without loading every schema upfront. The provider wraps an MCP
// capability session and exposes a single "tool_search" capability.
import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";

export class ToolSearchCapabilityProvider implements CapabilityProvider {
  readonly id = "native:tool-search";
  readonly kind = "native-tool" as const;
  private readonly getSession: () => { list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> } | null;
  private closed = false;

  constructor(getSession: () => { list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> } | null) {
    this.getSession = getSession;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (grant.denied.has("tool_search")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("tool_search")) return [];
    return [{
      id: "native:tool-search",
      name: "tool_search",
      description: "Search available MCP tools by keyword. Returns matching tool names and descriptions. Use before calling an MCP tool whose name you don't know.",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword to search tool names and descriptions." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 20)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      risk: "read" as const,
      sideEffect: false,
      timeoutMs: 5_000,
      parallelSafe: true,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== "native:tool-search") throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has("tool_search")) throw new Error("Capability denied: tool_search");
    if (grant.allowed.size > 0 && !grant.allowed.has("tool_search")) throw new Error("Capability not allowed: tool_search");
    const args = call.arguments as Record<string, unknown> | null;
    if (!args || typeof args.query !== "string" || !args.query.trim()) throw new Error("query is required");
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try { this.validate(call, context.grant); }
    catch (error) { return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" }; }
    context.signal.throwIfAborted();
    const args = call.arguments as { query: string; limit?: number };
    const session = this.getSession();
    if (!session) return { callId: call.callId, ok: false, content: "MCP session not available", error: "not_available" };
    const tools = session.list(context.grant);
    const q = args.query.toLowerCase();
    const matches = tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    const limit = Math.min(50, Math.max(1, args.limit ?? 20));
    const sliced = matches.slice(0, limit);
    if (sliced.length === 0) return { callId: call.callId, ok: true, content: "No matching tools found." };
    const lines = sliced.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    return { callId: call.callId, ok: true, content: `Found ${matches.length} tool(s) (showing ${sliced.length}):\n${lines}` };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "tool search (MCP tool discovery)"; }
}
