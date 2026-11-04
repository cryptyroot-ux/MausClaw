import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";
import { runShellTool, SHELL_TOOL_DESCRIPTOR, type ShellToolContext } from "./native-shell-tool.ts";
import { allowsTool } from "../../shared/tool-scope.ts";

export class NativeShellCapabilityProvider implements CapabilityProvider {
  readonly id = "native:shell";
  readonly kind = "native-tool" as const;
  private readonly ctx: ShellToolContext;
  private readonly scope: unknown;
  private closed = false;

  constructor(ctx: ShellToolContext, scope?: unknown) { this.ctx = ctx; this.scope = scope; }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (!allowsTool(this.scope, { kind: "native", name: "bash" })) return [];
    if (grant.denied.has("bash")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("bash")) return [];
    return [{
      id: SHELL_TOOL_DESCRIPTOR.id,
      name: SHELL_TOOL_DESCRIPTOR.name,
      description: SHELL_TOOL_DESCRIPTOR.description,
      schema: SHELL_TOOL_DESCRIPTOR.schema,
      risk: SHELL_TOOL_DESCRIPTOR.risk,
      sideEffect: SHELL_TOOL_DESCRIPTOR.sideEffect,
      timeoutMs: SHELL_TOOL_DESCRIPTOR.timeoutMs,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== "bash" && call.capabilityId !== "native:shell:bash") throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has("bash")) throw new Error("Capability denied: bash");
    if (grant.allowed.size > 0 && !grant.allowed.has("bash")) throw new Error("Capability not allowed: bash");
    const args = call.arguments as Record<string, unknown> | null;
    if (!args || typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try { this.validate(call, context.grant); }
    catch (error) { return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" }; }
    context.signal.throwIfAborted();
    const result = await runShellTool(this.ctx, (call.arguments ?? {}) as Record<string, unknown>, context.signal);
    return { callId: call.callId, ok: result.ok, content: result.content, ...(result.error ? { error: result.error } : {}) };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native shell (bash)"; }
}
