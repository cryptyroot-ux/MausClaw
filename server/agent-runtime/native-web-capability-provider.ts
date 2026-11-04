import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";
import { runWebTool, WEB_TOOL_DESCRIPTOR, type WebToolContext } from "./native-web-tool.ts";
import { allowsTool } from "../../shared/tool-scope.ts";

export class NativeWebCapabilityProvider implements CapabilityProvider {
  readonly id = "native:web";
  readonly kind = "native-tool" as const;
  private readonly ctx: WebToolContext;
  private readonly scope: unknown;
  private closed = false;

  constructor(ctx: WebToolContext, scope?: unknown) { this.ctx = ctx; this.scope = scope; }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (!allowsTool(this.scope, { kind: "native", name: "web" })) return [];
    if (grant.denied.has("web")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("web")) return [];
    return [{
      id: WEB_TOOL_DESCRIPTOR.id,
      name: WEB_TOOL_DESCRIPTOR.name,
      description: WEB_TOOL_DESCRIPTOR.description,
      schema: WEB_TOOL_DESCRIPTOR.schema,
      risk: WEB_TOOL_DESCRIPTOR.risk,
      sideEffect: WEB_TOOL_DESCRIPTOR.sideEffect,
      timeoutMs: WEB_TOOL_DESCRIPTOR.timeoutMs,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== "web" && call.capabilityId !== "native:web") throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has("web")) throw new Error("Capability denied: web");
    if (grant.allowed.size > 0 && !grant.allowed.has("web")) throw new Error("Capability not allowed: web");
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try { this.validate(call, context.grant); }
    catch (error) { return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" }; }
    context.signal.throwIfAborted();
    const result = await runWebTool(this.ctx, (call.arguments ?? {}) as Record<string, unknown>);
    return { callId: call.callId, ok: result.ok, content: result.content, ...(result.error ? { error: result.error } : {}) };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native web (fetch, search)"; }
}
