import type { CapabilityCall, CapabilityDescriptor, CapabilityGrant, CapabilityProvider, CapabilityResult } from "./contracts.ts";
import { allowsTool } from "../../shared/tool-scope.ts";
import { COMPUTER_TOOL_DESCRIPTOR, MAX_COMMAND_CHARS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, runComputerTool, type ComputerToolContext } from "./native-computer-tool.ts";

export class NativeComputerCapabilityProvider implements CapabilityProvider {
  readonly id = "native-computer-exec";
  readonly kind = "native-tool" as const;
  private readonly ctx: ComputerToolContext;
  private readonly scope: unknown;
  private closed = false;

  constructor(ctx: ComputerToolContext, scope?: unknown) { this.ctx = ctx; this.scope = scope; }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (!this.ctx.spawnBoxed) return []; // OS sandbox unavailable: do not offer computer execution at all
    if (!allowsTool(this.scope, { kind: "native", name: COMPUTER_TOOL_DESCRIPTOR.name })) return [];
    if (grant.denied.has(COMPUTER_TOOL_DESCRIPTOR.id)) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has(COMPUTER_TOOL_DESCRIPTOR.id)) return [];
    return [{
      id: COMPUTER_TOOL_DESCRIPTOR.id,
      name: COMPUTER_TOOL_DESCRIPTOR.name,
      description: COMPUTER_TOOL_DESCRIPTOR.description,
      schema: COMPUTER_TOOL_DESCRIPTOR.schema,
      risk: COMPUTER_TOOL_DESCRIPTOR.risk,
      sideEffect: COMPUTER_TOOL_DESCRIPTOR.sideEffect,
      timeoutMs: COMPUTER_TOOL_DESCRIPTOR.timeoutMs,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== COMPUTER_TOOL_DESCRIPTOR.id) throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has(COMPUTER_TOOL_DESCRIPTOR.id)) throw new Error("Capability denied: computer_exec");
    if (grant.allowed.size > 0 && !grant.allowed.has(COMPUTER_TOOL_DESCRIPTOR.id)) throw new Error("Capability not allowed: computer_exec");
    const args = call.arguments as Record<string, unknown> | null;
    if (!args || typeof args.command !== "string" || !args.command.trim()) throw new Error("command is required");
    if ((args.command as string).length > MAX_COMMAND_CHARS) throw new Error(`command is too long (${(args.command as string).length} chars, max ${MAX_COMMAND_CHARS})`);
    if (args.cwd !== undefined && typeof args.cwd !== "string") throw new Error("cwd must be a string");
    if (args.timeout_ms !== undefined) {
      const ms = Number(args.timeout_ms);
      if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
        throw new Error(`timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
      }
    }
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    try { this.validate(call, context.grant); }
    catch (error) { return { callId: call.callId, ok: false, content: error instanceof Error ? error.message : String(error), error: "denied" }; }
    context.signal.throwIfAborted();
    // Fail closed: computer execution must run inside the OS sandbox. When the boxed spawn
    // runner is not wired in, the sandbox is unavailable and the command must not run.
    if (!this.ctx.spawnBoxed) {
      return { callId: call.callId, ok: false, content: "native computer execution is not isolated: OS sandbox unavailable", error: "isolation_unavailable" };
    }
    const result = await runComputerTool(this.ctx, (call.arguments ?? {}) as Record<string, unknown>, context.signal);
    return { callId: call.callId, ok: result.ok, content: result.content, ...(result.error ? { error: result.error } : {}), ...(result.uncertain ? { uncertain: true } : {}) };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native computer execution (computer_exec)"; }
}
