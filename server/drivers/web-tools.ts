// Native web tools: web_fetch (HTTP GET, page text) and web_search (DuckDuckGo's free HTML results; no API key, may
// be rate-limited or change shape). Private, loopback and link-local addresses are refused, including after redirects.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const SEARCH_MAX = 10;

export const WEB_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  { type: "function", function: { name: "web_fetch", description: "Fetch a public http(s) URL and return its text (HTML is reduced to readable text). Long pages are shortened.",
    parameters: { type: "object", properties: { url: { type: "string", description: "The http or https URL." } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the web (DuckDuckGo) and return up to 10 results with title, URL and snippet.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The search query." } }, required: ["query"], additionalProperties: false } } },
];

export function privateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

export interface WebOptions {
  /** Tests only: allow loopback/private targets (the operator can also set MAUSCLAW_WEB_ALLOW_PRIVATE=1 for local evals). */
  allowPrivate?: boolean;
  searchUrl?: string;
}

async function guard(url: URL, options: WebOptions): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  if (options.allowPrivate || process.env.MAUSCLAW_WEB_ALLOW_PRIVATE === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(privateAddress)) throw new Error(`${url.hostname} is a private or local address`);
}

async function get(raw: string, signal: AbortSignal, options: WebOptions): Promise<{ url: string; status: number; type: string; body: string; cut: boolean }> {
  let url = new URL(raw);
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  for (let hop = 0; ; hop++) {
    await guard(url, options);
    const response = await fetch(url, { redirect: "manual", signal: timeout, headers: { "user-agent": "Mozilla/5.0 (compatible; MausClaw)", accept: "text/html,text/plain,application/json,*/*" } });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
      url = new URL(location, url);
      continue;
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0; let cut = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size > FETCH_MAX_BYTES) { cut = true; await reader.cancel(); break; }
    }
    return { url: url.href, status: response.status, type: response.headers.get("content-type") ?? "", body: Buffer.concat(chunks).subarray(0, FETCH_MAX_BYTES).toString("utf8"), cut };
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (whole, code: string) =>
  ENTITIES[code.toLowerCase()] ?? (code.startsWith("#x") ? String.fromCodePoint(parseInt(code.slice(2), 16)) : code.startsWith("#") ? String.fromCodePoint(Number(code.slice(1))) : whole));

export function htmlToText(html: string): string {
  return decode(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function executeWebTool(name: string, args: Record<string, unknown>, signal: AbortSignal, options: WebOptions = {}): Promise<ChatToolResult> {
  try {
    if (name === "web_fetch") {
      const page = await get(String(args.url ?? "").trim(), signal, options);
      const text = /html|xml/i.test(page.type) || /^\s*<(!doctype|html)/i.test(page.body) ? htmlToText(page.body) : page.body;
      return { ok: page.status < 400, text: `[${page.status} ${page.url}${page.cut ? "; shortened" : ""}]\n${text}` };
    }
    if (name === "web_search") {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, text: "web_search needs a query." };
      const page = await get(`${options.searchUrl ?? "https://html.duckduckgo.com/html/"}?q=${encodeURIComponent(query)}`, signal, options);
      if (page.status >= 400) return { ok: false, text: `Search failed: HTTP ${page.status}.` };
      const links = [...page.body.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
      const snippets = [...page.body.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];
      const rows = links.slice(0, SEARCH_MAX).map((link, index) => {
        let href = decode(link[1]!);
        const target = /[?&]uddg=([^&]+)/.exec(href)?.[1];
        if (target) try { href = decodeURIComponent(target); } catch {}
        return `${index + 1}. ${htmlToText(link[2]!)}\n   ${href}\n   ${htmlToText(snippets[index]?.[1] ?? "")}`;
      });
      return { ok: true, text: rows.length ? rows.join("\n\n") : "No results (the free search may be rate-limited; try web_fetch on a known page)." };
    }
    return { ok: false, text: `Unknown web tool ${name}.` };
  } catch (error) {
    signal.throwIfAborted();
    return { ok: false, text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
