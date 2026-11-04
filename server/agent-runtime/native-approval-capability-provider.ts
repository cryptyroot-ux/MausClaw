import type { ChatToolCallView } from "../drivers/chat-mcp-tools.ts";
import type { ChatCapabilityApproval } from "./chat-capability-runtime.ts";
import type {
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityProvider,
  CapabilityResult,
} from "./contracts.ts";

const READ_ONLY_GIT_OPERATIONS = new Set(["status", "diff", "log", "worktree-list"]);

function inputObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function needsApproval(descriptor: CapabilityDescriptor, call: CapabilityCall): boolean {
  if (call.capabilityId !== "git") return descriptor.sideEffect || descriptor.risk !== "read";
  const args = inputObject(call.arguments);
  const operation = args.operation;
  if (typeof operation !== "string" || READ_ONLY_GIT_OPERATIONS.has(operation)) return false;
  return !(operation === "branch" && !args.name && !args.delete);
}

export class NativeApprovalCapabilityProvider implements CapabilityProvider {
  readonly id: CapabilityProvider["id"];
  readonly kind: CapabilityProvider["kind"];
  private readonly provider: CapabilityProvider;
  private readonly approval: ChatCapabilityApproval;
  private readonly preview: (value: unknown) => string | undefined;
  private closed = false;

  constructor(
    provider: CapabilityProvider,
    approval: ChatCapabilityApproval,
    preview: (value: unknown) => string | undefined,
  ) {
    this.provider = provider;
    this.id = provider.id;
    this.kind = provider.kind;
    this.approval = approval;
    this.preview = preview;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    return this.closed ? [] : this.provider.list(grant);
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (!this.provider.list(grant).some((descriptor) => descriptor.id === call.capabilityId)) {
      throw new Error(`Capability not found: ${call.capabilityId}`);
    }
    this.provider.validate(call, grant);
  }

  async mount(context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<void> {
    await this.provider.mount(context);
  }

  async invoke(
    call: CapabilityCall,
    context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal },
  ): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    let descriptor: CapabilityDescriptor;
    try {
      this.validate(call, context.grant);
      context.signal.throwIfAborted();
      descriptor = this.provider.list(context.grant).find((item) => item.id === call.capabilityId)!;
    } catch (error) {
      return {
        callId: call.callId,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        error: context.signal.aborted ? "interrupted" : "denied",
      };
    }

    const input = inputObject(call.arguments);
    const shown: ChatToolCallView = {
      title: descriptor.name,
      input,
      ask: needsApproval(descriptor, call),
      grant: `native:${descriptor.name}`,
    };
    const summary = this.preview(input) ?? "This tool has no arguments.";
    const floored = this.approval.floored({
      full: context.grant.approvalMode === "full",
      threadId: call.threadId,
      botId: call.botId,
      shown,
      summary,
    });
    if (floored) return { callId: call.callId, ok: false, content: floored.reason, error: "denied" };

    if (shown.ask && context.grant.approvalMode !== "full") {
      const allowed = await this.approval.ask(shown.title, summary, shown.grant);
      if (context.signal.aborted) return { callId: call.callId, ok: false, content: "interrupted", error: "interrupted" };
      if (!allowed) {
        return {
          callId: call.callId,
          ok: false,
          content: "Permission denied or expired; the tool was not executed.",
          error: "denied",
        };
      }
    }

    try {
      context.signal.throwIfAborted();
      return await this.provider.invoke(call, context);
    } catch (error) {
      return {
        callId: call.callId,
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        error: context.signal.aborted ? "interrupted" : "failed",
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.provider.close();
  }

  describe(): string { return this.provider.describe(); }
}
