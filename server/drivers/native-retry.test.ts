// Shared retry policy for every native API driver: 429/5xx/network retried before any token streams.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../contracts.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { GroqDriver } from "./groq.ts";
import { MistralDriver } from "./mistral.ts";
import { CerebrasDriver } from "./cerebras.ts";
import { MinimaxDriver } from "./minimax.ts";
import { MetaDriver } from "./meta.ts";
import { GrokDriver } from "./grok.ts";
import {
  HttpStatusError, RETRY_AFTER_CAP_MS, RETRY_MAX_ATTEMPTS, RETRY_TOTAL_WAIT_CAP_MS,
  classifyError, nextRetryDelay, parseRetryAfter,
} from "./retry.ts";

const sse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const OK = 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

beforeEach(() => { process.env.MAUSCLAW_RETRY_SCALE = "0.001"; vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { delete process.env.MAUSCLAW_RETRY_SCALE; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("retry helper", () => {
  it("parses Retry-After seconds and HTTP-date, capped", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 5_000)).toBe(5_000);
    expect(parseRetryAfter("9999")).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
  it("classifies by HTTP status", () => {
    for (const status of [429, 500, 502, 503, 504]) expect(classifyError(new HttpStatusError("x", status)).transient).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) expect(classifyError(new HttpStatusError("x", status)).transient).toBe(false);
    expect(classifyError(new TypeError("fetch failed")).transient).toBe(true);
    expect(classifyError(new Error("read ECONNRESET")).transient).toBe(true);
  });
  it("caps attempts and total wait, preferring Retry-After", () => {
    expect(nextRetryDelay(0, 0, 1_500)).toBe(1_500);
    expect(nextRetryDelay(RETRY_MAX_ATTEMPTS - 1, 0)).toBeNull();
    expect(nextRetryDelay(0, RETRY_TOTAL_WAIT_CAP_MS)).toBeNull();
    expect(nextRetryDelay(0, RETRY_TOTAL_WAIT_CAP_MS - 100, 5_000)).toBe(100);
  });
});

async function runTurn(responses: Array<() => Response | Promise<Response>>, abortAfterMs?: number) {
  let call = 0;
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (!String(url).endsWith("/chat/completions")) return new Response("", { status: 404 });
    const next = responses[Math.min(call++, responses.length - 1)]!;
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);
  const instance = await OpenAICompatDriver.create({
    instanceId: "compat", displayName: "Compat", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "https://api.example.test/v1", apiKeyEnv: "K", model: "m" }),
    environment: { K: "secret" },
  });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent((event) => events.push(event));
  await instance.adapter.sendTurn({ threadId: "t", text: "hi" });
  if (abortAfterMs !== undefined) setTimeout(() => void instance.adapter.interruptTurn?.("t"), abortAfterMs);
  await vi.waitFor(() => {
    if (!events.some((e) => e.type === "turn.completed")) throw new Error("running");
  }, { timeout: 5_000 });
  await instance.dispose();
  const chatCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/chat/completions")).length;
  return { events, chatCalls };
}
const retries = (events: RuntimeEvent[]) => events.filter((e) => e.type === "turn.retrying") as Array<RuntimeEvent & { delayMs: number; reason: string }>;
const text = (events: RuntimeEvent[]) => events.filter((e) => e.type === "content.delta").map((e) => (e as { delta: string }).delta).join("");

describe("native runtime retry", () => {
  it("honors Retry-After on 429 then succeeds", async () => {
    const { events, chatCalls } = await runTurn([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      () => sse(OK),
    ]);
    expect(chatCalls).toBe(2);
    expect(retries(events)).toMatchObject([{ delayMs: 2_000, reason: "rate_limited" }]);
    expect(text(events)).toBe("hello");
  });
  it("retries 503 then 200, and a network failure", async () => {
    const { events, chatCalls } = await runTurn([
      () => new Response("down", { status: 503 }),
      () => { throw new TypeError("fetch failed"); },
      () => sse(OK),
    ]);
    expect(chatCalls).toBe(3);
    expect(retries(events).map((e) => e.reason)).toEqual(["server_error", "connection_reset"]);
    expect(text(events)).toBe("hello");
  });
  it("gives up after the max attempts", async () => {
    const { events, chatCalls } = await runTurn([() => new Response("down", { status: 502 })]);
    expect(chatCalls).toBe(RETRY_MAX_ATTEMPTS);
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
  });
  it("never retries 401", async () => {
    const { events, chatCalls } = await runTurn([() => new Response("bad key", { status: 401 }), () => sse(OK)]);
    expect(chatCalls).toBe(1);
    expect(retries(events)).toHaveLength(0);
  });
  it("never retries after tokens streamed", async () => {
    const broken = () => {
      const enc = new TextEncoder();
      return new Response(new ReadableStream({
        start(c) { c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n')); setTimeout(() => c.error(new Error("read ECONNRESET")), 50); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const { events, chatCalls } = await runTurn([broken, () => sse(OK)]);
    expect(chatCalls).toBe(1);
    expect(retries(events)).toHaveLength(0);
    expect(text(events)).toBe("par");
    expect(events.find((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
  });
});

describe("driver wiring", () => {
  it.each([
    ["groq", GroqDriver], ["mistral", MistralDriver], ["cerebras", CerebrasDriver],
    ["minimax", MinimaxDriver], ["meta", MetaDriver], ["grok", GrokDriver], ["openai-compat", OpenAICompatDriver],
  ] as const)("%s is built on the shared native runtime", async (_kind, driver) => {
    expect(typeof driver.create).toBe("function");
  });
});
