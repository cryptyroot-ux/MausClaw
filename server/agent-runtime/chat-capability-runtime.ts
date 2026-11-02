import { ASK_USER_TOOL, askQuestionSummary, parseAskQuestions, type AskQuestion } from "../../shared/ask-question.ts";
import type { FloorBlock } from "../safety-floor-gate.ts";
import type { ChatToolCallView, ChatToolDefinition, ChatToolSession } from "../drivers/chat-mcp-tools.ts";
import type {
  CapabilityCall,
  CapabilityDescriptor,
  CapabilityGrant,
  CapabilityResult,
  CapabilitySession,
} from "./contracts.ts";

const DEFAULT_TOOL_TIMEOUT_MS = 10 * 60_000;

export interface ChatCapabilityApproval {
  floored(call: {
    full: boolean;
    threadId: string;
    botId?: string;
    shown: ChatToolCallView;
    summary?: string;
  }): FloorBlock | null;
  ask(tool: string, summary: string, grant?: string): Promise<boolean>;
  question(tool: string, summary: string, questions: AskQuestion[]): Promise<string | null>;
}

export interface ChatCapabilitySessionOptions {
  session: ChatToolSession;
  approval: ChatCapabilityApproval;
}

function descriptor(definition: ChatToolDefinition): CapabilityDescriptor {
  return {
    id: definition.function.name,
    name: definition.function.name,
    description: definition.function.description,
    schema: definition.function.parameters,
    // MCP definitions do not carry a reliable risk field. Persist the
    // conservative side-effect class so an uncertain call is recoverable.
    risk: "write",
    sideEffect: true,
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  };
}

function permitted(id: string, grant: CapabilityGrant): boolean {
  if (grant.denied.has(id)) return false;
  return grant.allowed.size === 0 || grant.allowed.has(id);
}

function preview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "This tool has no preview.";
  }
}

function capabilityImages(images: ChatToolResultImages): CapabilityResult["images"] {
  const converted: Array<{ mimeType: string; data: string }> = [];
  for (const image of images ?? []) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(image.image_url.url);
    if (match) converted.push({ mimeType: match[1]!, data: match[2]! });
  }
  return converted.length ? converted : undefined;
}

type ChatToolResultImages = Awaited<ReturnType<ChatToolSession["execute"]>>["images"];

/**
 * Adapts the existing ChatToolSession and approval broker to the MausClaw
 * CapabilitySession contract. The bridge never grants authority: it only
 * forwards the current grant, approval decision, and MCP execution.
 */
export function createChatCapabilitySession({
  session,
  approval,
}: ChatCapabilitySessionOptions): CapabilitySession {
  const descriptors = new Map(session.definitions.map((definition) => [definition.function.name, descriptor(definition)]));
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("Capability session is closed");
  };

  const assertPermitted = (id: string, grant: CapabilityGrant): void => {
    if (!descriptors.has(id)) throw new Error(`Unknown capability: ${id}`);
    if (grant.denied.has(id)) throw new Error(`Capability denied: ${id}`);
    if (grant.allowed.size > 0 && !grant.allowed.has(id)) throw new Error(`Capability not allowed: ${id}`);
  };

  return {
    list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
      if (closed) return [];
      return Array.from(descriptors.values())
        .filter((item) => permitted(item.id, grant))
        .map((item) => item.id === ASK_USER_TOOL ? { ...item, optional: true } : item);
    },

    validate(call: CapabilityCall, grant: CapabilityGrant): void {
      assertOpen();
      assertPermitted(call.capabilityId, grant);
      if (call.capabilityId === ASK_USER_TOOL) {
        if (!parseAskQuestions(call.arguments)) throw new Error("The ask_user arguments are malformed");
        return;
      }
      session.validate(call.capabilityId, call.arguments);
    },

    async invoke(
      call: CapabilityCall,
      context: { grant: CapabilityGrant; signal: AbortSignal },
    ): Promise<CapabilityResult> {
      if (closed) {
        return { callId: call.callId, ok: false, content: "Capability session is closed", error: "closed" };
      }
      if (!descriptors.has(call.capabilityId)) {
        return { callId: call.callId, ok: false, content: `Unknown capability: ${call.capabilityId}`, error: "unknown_capability" };
      }
      if (!permitted(call.capabilityId, context.grant)) {
        return { callId: call.callId, ok: false, content: `Capability denied: ${call.capabilityId}`, error: "denied" };
      }

      let dispatched = false;
      try {
        context.signal.throwIfAborted();
        if (call.capabilityId === ASK_USER_TOOL) {
          const questions = parseAskQuestions(call.arguments);
          if (!questions) {
            return { callId: call.callId, ok: false, content: "The ask_user arguments are malformed.", error: "invalid_arguments" };
          }
          const answer = await approval.question(ASK_USER_TOOL, askQuestionSummary(questions), questions);
          context.signal.throwIfAborted();
          return {
            callId: call.callId,
            ok: true,
            content: answer ?? "The person did not answer this question. Do not guess an answer; ask again later or proceed without it.",
          };
        }

        session.validate(call.capabilityId, call.arguments);
        const shown = session.view(call.capabilityId, call.arguments as Record<string, unknown>);
        const summary = preview(shown.input);
        const floored = approval.floored({
          full: context.grant.approvalMode === "full",
          threadId: context.grant.threadId,
          botId: context.grant.botId,
          shown,
          summary,
        });
        if (floored) {
          return { callId: call.callId, ok: false, content: floored.reason, error: "denied" };
        }
        const allowed = context.grant.approvalMode === "full"
          || !shown.ask
          || await approval.ask(shown.title, summary, shown.grant);
        context.signal.throwIfAborted();
        if (!allowed) {
          return {
            callId: call.callId,
            ok: false,
            content: "Permission denied or expired; the tool was not executed.",
            error: "denied",
          };
        }

        dispatched = true;
        const result = await session.execute(call.capabilityId, call.arguments as Record<string, unknown>, context.signal);
        const images = capabilityImages(result.images);
        const omitted = result.images?.length && !images ? "\n[image omitted: unsupported image transport]" : "";
        return {
          callId: call.callId,
          ok: result.ok,
          content: `${result.text}${omitted}`,
          ...(images ? { images } : {}),
          ...(result.ok ? {} : { error: "capability_failed" }),
        };
      } catch (error) {
        if (context.signal.aborted) {
          return {
            callId: call.callId,
            ok: false,
            content: "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying.",
            uncertain: true,
            error: "interrupted",
          };
        }
        if (dispatched) {
          return {
            callId: call.callId,
            ok: false,
            content: "The tool failed after dispatch; its outcome may be uncertain. Inspect its state before retrying.",
            uncertain: true,
            error: "uncertain_side_effect",
          };
        }
        return {
          callId: call.callId,
          ok: false,
          content: error instanceof Error ? error.message : String(error),
          error: "execution_error",
        };
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      descriptors.clear();
      await session.close();
    },
  };
}
