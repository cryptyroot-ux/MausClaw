import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";
import { runGitTool, GIT_TOOL_DESCRIPTOR, type GitToolContext } from "./native-git-tool.ts";
import { allowsTool } from "../../shared/tool-scope.ts";

export class NativeGitCapabilityProvider implements CapabilityProvider {
  readonly id = "native:git";
  readonly kind = "native-tool" as const;
  private readonly ctx: GitToolContext;
  private readonly scope: unknown;
  private closed = false;

  constructor(ctx: GitToolContext, scope?: unknown) { this.ctx = ctx; this.scope = scope; }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (!allowsTool(this.scope, { kind: "native", name: "git" })) return [];
    if (grant.denied.has("git")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("git")) return [];
    return [{
      id: GIT_TOOL_DESCRIPTOR.id,
      name: GIT_TOOL_DESCRIPTOR.name,
      description: GIT_TOOL_DESCRIPTOR.description,
      schema: GIT_TOOL_DESCRIPTOR.schema,
      risk: GIT_TOOL_DESCRIPTOR.risk,
      sideEffect: GIT_TOOL_DESCRIPTOR.sideEffect,
      timeoutMs: GIT_TOOL_DESCRIPTOR.timeoutMs,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== "git" && call.capabilityId !== "native:git") throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has("git")) throw new Error("Capability denied: git");
    if (grant.allowed.size > 0 && !grant.allowed.has("git")) throw new Error("Capability not allowed: git");
    const args = call.arguments as Record<string, unknown> | null;
    const op = args?.operation;
    if (typeof op !== "string" || !op) throw new Error("operation is required");
    // Read ops don't need approval; write ops require approval unless full mode.
    // Approval is handled by the engine's grant; here we just validate args.
    if (op === "commit" && (!args?.message || typeof args.message !== "string")) throw new Error("commit requires message");
    if (op === "checkout" && (!args?.target || typeof args.target !== "string")) throw new Error("checkout requires target");
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try { this.validate(call, context.grant); }
    catch (error) { return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" }; }
    context.signal.throwIfAborted();
    const result = await runGitTool(this.ctx, (call.arguments ?? {}) as Record<string, unknown>);
    return { callId: call.callId, ok: result.ok, content: result.content, ...(result.error ? { error: result.error } : {}) };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native git (status, diff, log, add, commit, branch, checkout, init)"; }
}
