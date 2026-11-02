// Engine-level context management for native turns: request-size accounting, large tool-result offload
// with paging, and incremental mid-turn compaction. Provider-agnostic: every native driver shares it.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { prefixBytes } from "../context-rebuild.ts";
import type { ChatToolDefinition } from "./chat-mcp-tools.ts";
import type { OpenAIChatMessage } from "./openai-chat.ts";

export function turnContextSettings(fromTurn: TurnContextSettings | undefined): TurnContextSettings {
  const envNumber = (name: string) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  return {
    ...fromTurn,
    compactAt: fromTurn?.compactAt ?? envNumber("MAUSCLAW_TURN_COMPACT_AT"),
    offloadBytes: fromTurn?.offloadBytes ?? envNumber("MAUSCLAW_TOOL_OFFLOAD_BYTES"),
    offloadDir: fromTurn?.offloadDir ?? (process.env.MAUSCLAW_TOOL_OFFLOAD_DIR || undefined),
  };
}

export interface TurnContextSettings {
  /** Fraction (<1) of the window, or absolute tokens, at which a turn compacts before the next model call. */
  compactAt?: number;
  /** Tool results larger than this (bytes) are offloaded to disk and paged with read_tool_output. */
  offloadBytes?: number;
  /** Folder for offloaded tool outputs; absent disables offload. */
  offloadDir?: string;
  /** Model that writes compaction summaries; absent uses the turn's model. */
  summaryModel?: string;
  /** Most recent assistant exchanges kept verbatim. */
  keepExchanges?: number;
}

export const DEFAULT_TURN_COMPACT_AT = 0.75;
export const DEFAULT_OFFLOAD_BYTES = 16_000;
export const DEFAULT_KEEP_EXCHANGES = 4;
const HEAD_BYTES = 2_000;
const TAIL_BYTES = 1_000;
/** Characters per token for the cheap estimate; deliberately below the ~4 of English text so it over-counts. */
const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1_100;
const MESSAGE_OVERHEAD_TOKENS = 4;

export const SUMMARY_TAG = "[Context summary of earlier steps in this turn — older messages were compacted]";

function textOf(content: OpenAIChatMessage["content"]): { text: string; images: number } {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0 };
  let text = "";
  let images = 0;
  for (const part of content) {
    if (part.type === "image_url") images++;
    else if ("text" in part && typeof part.text === "string") text += part.text;
  }
  return { text, images };
}

const tokensOfText = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export function estimateMessageTokens(message: OpenAIChatMessage): number {
  const { text, images } = textOf(message.content);
  let tokens = MESSAGE_OVERHEAD_TOKENS + tokensOfText(text) + images * IMAGE_TOKENS;
  if (message.tool_calls?.length) tokens += tokensOfText(JSON.stringify(message.tool_calls));
  for (const key of ["reasoning_content", "reasoning"] as const) if (message[key]) tokens += tokensOfText(message[key]!);
  if (message.reasoning_details?.length) tokens += tokensOfText(JSON.stringify(message.reasoning_details));
  return tokens;
}

/** Tokens a request will take: system + history + tool schemas + images, before calibration. */
export function estimateRequestTokens(messages: readonly OpenAIChatMessage[], tools: readonly ChatToolDefinition[] = []): number {
  let total = 3;
  for (const message of messages) total += estimateMessageTokens(message);
  if (tools.length) total += tokensOfText(JSON.stringify(tools));
  return total;
}

export function turnCompactBudget(window: number, compactAt?: number): number {
  const at = typeof compactAt === "number" && Number.isFinite(compactAt) && compactAt > 0 ? compactAt : DEFAULT_TURN_COMPACT_AT;
  return Math.max(1, Math.floor(Math.min(at < 1 ? window * at : at, window * 0.9)));
}

/** Learns how far the cheap estimate is from the provider's own prompt_tokens, never scaling it below 1. */
export class TokenCalibration {
  private ratio = 1;
  observe(estimated: number, reported: number | undefined) {
    if (!reported || reported <= 0 || estimated <= 0) return;
    this.ratio = Math.min(3, Math.max(1, reported / estimated));
  }
  apply(estimated: number) { return Math.ceil(estimated * this.ratio); }
}

// ---------- tool-output offload ----------

export const READ_TOOL_OUTPUT_TOOL = "read_tool_output";
export const READ_TOOL_OUTPUT_DEFINITION: ChatToolDefinition = {
  type: "function",
  function: {
    name: READ_TOOL_OUTPUT_TOOL,
    description: "Read part of a large tool output that was saved to disk instead of being shown in full. Pass the handle from the shortened result; offset and limit are in characters.",
    parameters: {
      type: "object",
      properties: {
        handle: { type: "string", description: "The handle printed in the shortened tool result, e.g. out_ab12cd34ef." },
        offset: { type: "integer", minimum: 0, description: "Character offset to start reading at (default 0)." },
        limit: { type: "integer", minimum: 1, maximum: 20000, description: "Characters to read (default 8000, max 20000)." },
      },
      required: ["handle"],
      additionalProperties: false,
    },
  },
};

const HANDLE = /^out_[A-Za-z0-9_-]{6,64}$/;
const threadFolder = (dir: string, threadId: string) => join(dir, createHash("sha256").update(threadId).digest("hex").slice(0, 24));

export interface Offloaded { text: string; handle: string; bytes: number }

/** Saves `text` in full and returns head + tail + a note naming the handle; null when it is small enough. */
export function offloadToolOutput(text: string, input: { dir?: string; threadId: string; callId: string; thresholdBytes?: number }): Offloaded | null {
  const threshold = input.thresholdBytes ?? DEFAULT_OFFLOAD_BYTES;
  const bytes = Buffer.byteLength(text);
  if (!input.dir || bytes <= threshold) return null;
  const handle = `out_${createHash("sha256").update(`${input.threadId}\0${input.callId}\0${bytes}`).digest("base64url").slice(0, 16)}`;
  const folder = threadFolder(input.dir, input.threadId);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, `${handle}.txt`), text, { mode: 0o600 });
  const head = prefixBytes(text, HEAD_BYTES);
  const tailStart = Math.max(head.length, text.length - TAIL_BYTES);
  const tail = text.slice(tailStart);
  const note = `\n\n[… output shortened: ${text.length} characters in total, ${text.length - head.length - tail.length} omitted. ` +
    `Full output saved with handle ${handle}; call ${READ_TOOL_OUTPUT_TOOL} {"handle":"${handle}","offset":${head.length},"limit":8000} to read more.]\n\n`;
  return { text: `${head}${note}${tail}`, handle, bytes };
}

export function readToolOutput(args: Record<string, unknown>, input: { dir?: string; threadId: string }): { ok: boolean; text: string } {
  const handle = typeof args.handle === "string" ? args.handle.trim() : "";
  if (!input.dir) return { ok: false, text: "Tool output offload is not enabled for this turn." };
  if (!HANDLE.test(handle)) return { ok: false, text: "Unknown handle: pass the out_… handle from a shortened tool result." };
  const folder = threadFolder(input.dir, input.threadId);
  const file = resolve(folder, `${handle}.txt`);
  if (!file.startsWith(resolve(folder) + sep) || !existsSync(file)) return { ok: false, text: `No saved output for handle ${handle} in this conversation.` };
  const full = readFileSync(file, "utf8");
  const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
  const limit = Math.min(20_000, Math.max(1, Math.floor(Number(args.limit ?? 8_000)) || 8_000));
  const slice = full.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { ok: true, text: `[${handle}: characters ${offset}–${end} of ${full.length}${end < full.length ? `; next offset ${end}` : "; end of output"}]\n${slice}` };
}

// ---------- compaction ----------

export interface CompactionPlan {
  /** Messages folded into the summary (may include an earlier summary). */
  folded: OpenAIChatMessage[];
  previousSummary: string | null;
  build(summary: string): OpenAIChatMessage[];
}

const isSummary = (message: OpenAIChatMessage) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(SUMMARY_TAG);

/** Splits messages into pinned (system, request), a foldable middle, and a verbatim tail that starts on an
 * assistant message so every tool result stays with its call. Null when nothing can be folded. */
export function planCompaction(messages: readonly OpenAIChatMessage[], request: OpenAIChatMessage, keepExchanges = DEFAULT_KEEP_EXCHANGES): CompactionPlan | null {
  const head = messages[0]?.role === "system" ? 1 : 0;
  const requestAt = messages.indexOf(request);
  const assistants: number[] = [];
  for (let index = head; index < messages.length; index++) if (messages[index]!.role === "assistant") assistants.push(index);
  // The tail never begins before the request, which is pinned on its own.
  const eligible = assistants.filter((index) => index > requestAt);
  const keep = Math.max(1, keepExchanges);
  let cut: number;
  if (eligible.length > keep) cut = eligible[eligible.length - keep]!;
  else {
    // Few rounds this turn: fold transcript history before the request instead.
    cut = requestAt;
  }
  const folded: OpenAIChatMessage[] = [];
  let previousSummary: string | null = null;
  for (let index = head; index < cut; index++) {
    const message = messages[index]!;
    if (message === request) continue;
    if (isSummary(message)) { previousSummary = (message.content as string).slice(SUMMARY_TAG.length).trim(); continue; }
    folded.push(message);
  }
  if (!folded.length) return null;
  const system = messages.slice(0, head);
  const tail = messages.slice(cut).filter((message) => message !== request);
  const requestBeforeTail = requestAt >= 0 && requestAt <= cut;
  return {
    folded,
    previousSummary,
    build: (summary) => [
      ...system,
      { role: "user", content: `${SUMMARY_TAG}\n${summary.trim()}` },
      ...(requestBeforeTail ? [request] : []),
      ...tail,
    ],
  };
}

const RENDER_MESSAGE_BYTES = 3_000;

/** Folded messages as plain text for the summarizer, each bounded. */
export function renderForSummary(messages: readonly OpenAIChatMessage[], budgetBytes: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages) {
    const { text, images } = textOf(message.content);
    const calls = message.tool_calls?.map((call) => `${call.function.name}(${call.function.arguments.slice(0, 400)})`).join("; ");
    let body = text;
    if (Buffer.byteLength(body) > RENDER_MESSAGE_BYTES) body = `${prefixBytes(body, RENDER_MESSAGE_BYTES - 400)} … ${body.slice(-300)}`;
    const line = `[${message.role}${message.tool_call_id ? ` result ${message.tool_call_id}` : ""}] ${calls ? `calls: ${calls} ` : ""}${body}${images ? ` [${images} image(s)]` : ""}`;
    const size = Buffer.byteLength(line);
    if (used + size > budgetBytes) { lines.push(`[… ${messages.length - lines.length} more message(s) not shown]`); break; }
    lines.push(line);
    used += size;
  }
  return lines.join("\n");
}

export function summaryPrompt(previousSummary: string | null, rendered: string): string {
  return [
    "You compact an AI agent's working context. Write a dense, structured note that lets the agent continue the SAME task without the original messages.",
    "Use exactly these sections, as bullet lists (write 'none' when empty):",
    "## Goal", "## Decisions", "## Facts and constraints (keep every exact identifier, number, path, URL, name, and value verbatim)",
    "## Files and resources touched", "## Open todos / next steps",
    "Merge the previous summary with the new messages; drop nothing from the previous summary that is still true. Do not invent facts. Output only the note.",
    "",
    "### Previous summary", previousSummary ?? "none",
    "", "### New messages to fold in", rendered,
  ].join("\n");
}

/** Used when the summarizer call fails: keeps the previous note and the start of every folded text message. */
export function deterministicTurnSummary(previousSummary: string | null, folded: readonly OpenAIChatMessage[]): string {
  const facts = folded.flatMap((message) => {
    const { text } = textOf(message.content);
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return [];
    return [`- (${message.role}) ${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`];
  });
  return [previousSummary ?? "", "## Folded messages (automatic fallback summary)", ...facts.slice(-60)].filter(Boolean).join("\n");
}

export interface CompactResult { messages: OpenAIChatMessage[]; folded: number; beforeTokens: number; afterTokens: number; summarizer: "model" | "fallback" }

/** One incremental compaction: folds older steps (plus any earlier summary) into a new summary message. */
export async function compactTurnMessages(
  messages: readonly OpenAIChatMessage[],
  request: OpenAIChatMessage,
  input: { tools?: readonly ChatToolDefinition[]; keepExchanges?: number; summarize: (prompt: string) => Promise<string>; summaryBudgetBytes: number },
): Promise<CompactResult | null> {
  const plan = planCompaction(messages, request, input.keepExchanges);
  if (!plan) return null;
  const beforeTokens = estimateRequestTokens(messages, input.tools);
  let summary: string;
  let summarizer: CompactResult["summarizer"] = "model";
  try {
    summary = (await input.summarize(summaryPrompt(plan.previousSummary, renderForSummary(plan.folded, input.summaryBudgetBytes)))).trim();
    if (!summary) throw new Error("empty summary");
  } catch {
    summary = deterministicTurnSummary(plan.previousSummary, plan.folded);
    summarizer = "fallback";
  }
  const next = plan.build(summary);
  return { messages: next, folded: plan.folded.length, beforeTokens, afterTokens: estimateRequestTokens(next, input.tools), summarizer };
}

/** A provider's refusal of a prompt over its context window (OpenAI, Groq, Mistral, OpenRouter, vLLM, llama.cpp, LM Studio …). */
const CONTEXT_OVERFLOW = /context[_ ]length[_ ]exceeded|maximum context length|context (?:window|length) (?:of|is|exceeded)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|too many (?:input )?tokens|reduce the length of the messages|input (?:is )?too long|exceeds (?:the )?available context(?: size)?|request exceeds the maximum|tokens? (?:limit|budget) exceeded/i;

export function refusesContextLength(status: number, body: string): boolean {
  return (status === 400 || status === 413 || status === 422 || status === 500) && CONTEXT_OVERFLOW.test(body);
}
