import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { allowsTool, parseToolScope, selectorIdentity } from "../../shared/tool-scope.ts";
import { ASK_USER_TOOL, ASK_USER_TOOL_DEFINITION, parseAskQuestions, askQuestionSummary } from "../../shared/ask-question.ts";
import { chatToolName } from "../drivers/chat-mcp-tools.ts";
import { mountChatTools, type ChatToolSession } from "../drivers/chat-mcp-tools.ts";
import type { ChatImagePart } from "../drivers/chat-images.ts";
import { ChatProtocolError } from "../drivers/openai-chat-protocol.ts";
import type { createChatToolApproval } from "../drivers/chat-tool-approval.ts";
import { toolSchemaProfileFor } from "../tool-schema-profile.ts";
import { createChatCapabilitySession, type ChatCapabilityApproval } from "./chat-capability-runtime.ts";
import { CompositeCapabilityRuntime, SessionCapabilityProvider, SkillCapabilityProvider } from "./capability-runtime.ts";
import { NativeFileCapabilityProvider } from "./native-file-capability-provider.ts";
import { NativeGitCapabilityProvider } from "./native-git-capability-provider.ts";
import { NativeWebCapabilityProvider } from "./native-web-capability-provider.ts";
import { ToolSearchCapabilityProvider } from "./tool-search-capability-provider.ts";
import { NativeShellCapabilityProvider } from "./native-shell-capability-provider.ts";
import { NativeComputerCapabilityProvider } from "./native-computer-capability-provider.ts";
import { workspaceDir } from "../workspace.ts";
import type { AgentEngine, CapabilityGrant, CapabilitySession, CapabilityProvider, CapabilityDescriptor, CapabilityCall, CapabilityResult } from "./contracts.ts";
import { plainFailureMessage } from "../drivers/engine-errors.ts";

export interface NativeSteerState {
  queue: string[];
  impl?: (text: string) => Promise<"steered" | "refused">;
}

export interface NativeTurnContext {
  turn: SendTurnInput;
  messages: ReadonlyArray<{ role: "system" | "user" | "assistant" | "tool"; content: unknown; tool_call_id?: string }>;
  model: string;
  turnId: string;
  abort: AbortController;
  approval: ReturnType<typeof createChatToolApproval>;
  engine: AgentEngine;
  driverKind: string;
  apiUrl: string;
  httpErrorLabel: string;
  toolsEnabled: () => boolean;
  computerUse: boolean;
  nudgeAnnouncedAction: boolean;
  emit: (event: RuntimeEvent) => void;
  base: (threadId: string, turnId: string) => { eventId: string; provider: string; threadId: string; turnId: string; createdAt: string };
  safeText: (text: string) => string;
  preview: (value: unknown) => string | undefined;
  steer: NativeSteerState;
  onSettled: () => void;
}

/** The MausClaw-owned native turn: mount capabilities, run the engine, bridge events, and close everything. The driver
 * supplies admission, approval, and the prepared messages; it never owns the model/tool cycle. */


/** Native ask_user capability provider - handles user questions directly without MCP */
class AskUserCapabilityProvider implements CapabilityProvider {
  readonly id = "native-ask-user";
  readonly kind = "native-tool" as const;
  private readonly approval: ChatCapabilityApproval;
  private closed = false;

  constructor(approval: ChatCapabilityApproval) {
    this.approval = approval;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (grant.denied.has("ask_user")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("ask_user")) return [];
    return [{
      id: "ask_user",
      name: "ask_user",
      description: "Ask the user a question and get their answer.",
      schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: { type: "array", items: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }
              },
              required: ["question"]
            },
            minItems: 1,
            maxItems: 6
          }
        },
        required: ["questions"],
        additionalProperties: false
      },
      risk: "read" as const,
      sideEffect: false,
      timeoutMs: 60_000,
      optional: true
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void {
    if (this.closed) throw new Error("Capability provider is closed");
    if (call.capabilityId !== "ask_user") throw new Error(`Unknown capability: ${call.capabilityId}`);
    if (grant.denied.has("ask_user")) throw new Error("Capability denied: ask_user");
    if (grant.allowed.size > 0 && !grant.allowed.has("ask_user")) throw new Error("Capability not allowed: ask_user");
    if (!parseAskQuestions(call.arguments)) throw new Error("The ask_user arguments are malformed");
  }

  async mount(): Promise<void> { /* no process */ }

  async invoke(call: CapabilityCall, context: { readonly grant: CapabilityGrant; readonly signal: AbortSignal }): Promise<CapabilityResult> {
    if (this.closed) return { callId: call.callId, ok: false, content: "closed", error: "closed" };
    if (call.capabilityId !== "ask_user") return { callId: call.callId, ok: false, content: "Unknown capability", error: "not_found" };
    if (!parseAskQuestions(call.arguments)) return { callId: call.callId, ok: false, content: "The ask_user arguments are malformed.", error: "invalid_arguments" };
    
    const questions = parseAskQuestions(call.arguments)!;
    const answer = await this.approval.question(ASK_USER_TOOL, askQuestionSummary(questions), questions);
    context.signal.throwIfAborted();
    
    return {
      callId: call.callId,
      ok: true,
      content: answer ?? "The person did not answer this question. Do not guess an answer; ask again later or proceed without it."
    };
  }

  async close(): Promise<void> { this.closed = true; }

  describe(): string { return "native ask_user tool"; }
}

export async function runNativeTurn(context: NativeTurnContext): Promise<void> {
  const { turn, messages, model, turnId, abort, approval, engine } = context;
  let tools: ChatToolSession | undefined;
  let capabilitySession: CapabilitySession | undefined;
  let unsubscribe = () => {};
  let completed = false;
  let roundText = "";
  const usage = { input: 0, output: 0 };
  let hasUsage = false;

  const finish = (ok: boolean, stopReason: string | null, failure?: string) => {
    if (completed) return;
    completed = true;
    if (ok && roundText.trim()) {
      context.emit({ ...context.base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: context.safeText(roundText) });
    }
    if (failure) {
      context.emit({
        ...context.base(turn.threadId, turnId),
        type: "runtime.error",
        message: context.safeText(plainFailureMessage(context.httpErrorLabel === "upstream" ? "upstream" : context.httpErrorLabel, failure)).slice(0, 2_000),
        terminal: !abort.signal.aborted,
      });
    }
    context.emit({
      ...context.base(turn.threadId, turnId),
      type: "turn.completed",
      ok,
      stopReason: abort.signal.aborted ? "interrupted" : stopReason,
      cost: null,
      ...(hasUsage ? { usage } : {}),
    });
  };

  try {
    if (messages.slice(0, -1).some((message) => Array.isArray(message.content))) {
      throw new ChatProtocolError("The native runtime cannot replay structured content from earlier turns; this turn was not sent.");
    }
    const composed = messages.at(-1)?.content;
    if (typeof composed !== "string" && !Array.isArray(composed)) {
      throw new ChatProtocolError("The native runtime received no user content for this turn; it was not sent.");
    }
    const nativeText = typeof composed === "string"
      ? composed
      : composed.find((part) => part.type === "text")?.text ?? turn.text;
    const nativeImages = Array.isArray(composed)
      ? composed.filter((part): part is ChatImagePart => part.type === "image_url").map((part) => {
          const match = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
          if (!match) throw new ChatProtocolError("The image transport is invalid; this turn was not sent.");
          return { mimeType: match[1]!, data: match[2]! };
        })
      : [];

    const parsed = parseToolScope(turn.toolScope);
    if (!parsed.ok) throw new Error(parsed.error);
    const scope = parsed.scope;
    tools = await mountChatTools(
      context.toolsEnabled() ? turn.integrations : undefined,
      abort.signal,
      context.computerUse,
      scope,
      turn.mcpCallTimeoutMs,
      toolSchemaProfileFor({ url: context.apiUrl, model }),
    );
    for (const { server, reason } of tools.skipped) {
      context.emit({ ...context.base(turn.threadId, turnId), type: "runtime.notice", message: `MCP server "${server}" was skipped for this turn: ${context.safeText(reason)}` });
    }
    const questionAllowed = context.toolsEnabled() && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL });
    if (questionAllowed && !tools.definitions.some((definition) => definition.function.name === ASK_USER_TOOL)) {
      tools.definitions.push(ASK_USER_TOOL_DEFINITION);
    }
    // Populate grant from toolScope using transformed tool names (matching chatToolName)
    const allowed = new Set<string>();
    const denied = new Set<string>();
    if (scope) {
      for (const selector of scope.allow ?? []) {
        const identity = selectorIdentity(selector);
        if (identity) {
          if (identity.kind === "mcp") {
            allowed.add(chatToolName(identity.server, identity.name));
          } else {
            allowed.add(identity.name);
          }
        }
      }
      for (const selector of scope.deny ?? []) {
        const identity = selectorIdentity(selector);
        if (identity) {
          if (identity.kind === "mcp") {
            denied.add(chatToolName(identity.server, identity.name));
          } else {
            denied.add(identity.name);
          }
        }
      }
    }
    const grant: CapabilityGrant = {
      botId: turn.botId ?? "",
      threadId: turn.threadId,
      approvalMode: turn.approvalMode === "full" ? "full" : "ask",
      allowed,
      denied,
    };
    const mcpSession = createChatCapabilitySession({ session: tools, approval });
    const fileRoot = turn.botId ? workspaceDir(turn.botId) : process.cwd();
    const providers: any[] = [
      new SessionCapabilityProvider("mcp", "mcp", mcpSession, "MCP tools"),
    ];
    // Native built-in tools (file, shell, git, web, tool_search) are available when
    // the tool scope permits them (or when no scope is set). They are not gated by
    // the MCP tools flag, but they DO respect toolScope (granular per-tool filtering).
    providers.push(new NativeFileCapabilityProvider({ root: fileRoot }, scope));
    providers.push(new NativeShellCapabilityProvider({ root: fileRoot }, scope));
    providers.push(new NativeGitCapabilityProvider({ root: fileRoot }, scope));
    providers.push(new NativeWebCapabilityProvider({ root: fileRoot }, scope));
    providers.push(new NativeComputerCapabilityProvider({ root: fileRoot }, scope));
    if (allowsTool(scope, { kind: "native", name: "tool_search" })) providers.push(new ToolSearchCapabilityProvider(() => mcpSession));
    // Native ask_user tool - handled directly without MCP
    if (context.toolsEnabled() && allowsTool(scope, { kind: "native", name: ASK_USER_TOOL })) {
      providers.push(new AskUserCapabilityProvider(approval));
    }
    providers.push(new SkillCapabilityProvider(turn.botId ?? "", undefined));
    const composite = new CompositeCapabilityRuntime(providers);
    await composite.mountAll({ grant, signal: abort.signal });
    capabilitySession = composite;

    const nativeMessages = messages.slice(0, -1).map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : null,
      ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    }));

    unsubscribe = engine.onEvent(turn.threadId, (event) => {
      switch (event.type) {
        case "model.delta":
          if (event.kind === "assistant_text") roundText += event.delta;
          context.emit({ ...context.base(turn.threadId, turnId), type: "content.delta", streamKind: event.kind, delta: context.safeText(event.delta) });
          break;
        case "usage":
          usage.input += event.input;
          usage.output += event.output;
          hasUsage = true;
          context.emit({ ...context.base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage });
          break;
        case "tool.calls":
          roundText = "";
          for (const call of event.calls) {
            context.emit({
              ...context.base(turn.threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: call.id,
              title: call.name,
              input: context.preview(call.arguments),
            });
          }
          break;
        case "tool.result":
          context.emit({
            ...context.base(turn.threadId, turnId),
            type: "item.completed",
            itemType: "tool",
            itemId: event.callId,
            ok: event.result.ok,
            output: context.preview({ ok: event.result.ok, result: event.result.content }),
          });
          break;
        case "turn.completed":
          finish(event.ok, event.stopReason ?? null);
          break;
        case "run.failed": {
          const stopReason = event.code === "capability_failed" ? "tool_error"
            : event.code === "incomplete_action" ? "incomplete_action"
            : "error";
          finish(false, stopReason, event.message);
          break;
        }
        case "run.interrupted":
          finish(false, "interrupted");
          break;
        case "run.recovery_required":
          finish(false, "recovery_required", "The operation may have taken effect. Inspect its state before continuing.");
          break;
        case "run.compacted":
          context.emit({ ...context.base(turn.threadId, turnId), type: "runtime.notice", message: `Older context was summarized to fit the model window (${event.tokenEstimate} estimated tokens after compaction).` });
          break;
        case "run.started":
          break;
      }
    });

    const handle = await engine.run({
      botId: turn.botId ?? "",
      threadId: turn.threadId,
      text: nativeText,
      messages: nativeMessages,
      providerModel: { providerId: context.driverKind, modelId: model },
      grant,
      capabilities: capabilitySession,
      toolScope: turn.toolScope,
      signal: abort.signal,
      ...(turn.budget ? { budget: turn.budget } : {}),
      ...(nativeImages.length ? { images: nativeImages } : {}),
      ...(context.nudgeAnnouncedAction ? { nudgeAnnouncedAction: true } : {}),
      ...(turn.toolErrorCorrectiveRounds !== undefined ? { toolErrorCorrectiveRounds: turn.toolErrorCorrectiveRounds } : {}),
      ...(turn.toolScope !== undefined ? { toolScope: turn.toolScope } : {}),
    });
    context.steer.impl = (text) => engine.steer(handle.runId, text);
    for (const text of context.steer.queue.splice(0)) await context.steer.impl(text);
    await handle.done;
    if (!completed) finish(false, abort.signal.aborted ? "interrupted" : "error");
  } catch (error) {
    finish(false, abort.signal.aborted ? "interrupted" : "error", error instanceof Error ? error.message : String(error));
  } finally {
    approval.close();
    unsubscribe();
    try {
      if (capabilitySession) await capabilitySession.close();
      else await tools?.close();
    } catch {
      if (!completed) finish(false, "error", "Tool processes could not be stopped; their execution state is uncertain.");
    }
    context.onSettled();
  }
}
