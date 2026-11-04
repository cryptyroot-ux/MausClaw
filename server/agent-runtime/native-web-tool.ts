// Native web tools: fetch (HTTP GET) and search (DuckDuckGo HTML, no API key).
import { URL } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_MAX_BYTES = 100_000;
const SEARCH_MAX_RESULTS = 10;

function privateAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  if (isIP(a) === 4) {
    const parts = a.split(".").map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (isIP(a) === 6) {
    // IPv4-mapped IPv6: ::ffff:w.x.y.z. Node normalizes a URL host like
    // [::ffff:127.0.0.1] to ::ffff:7f00:1 (hex tail), while a direct call may
    // pass ::ffff:127.0.0.1 (dotted tail). Extract the embedded IPv4 either way
    // so private IPv4 ranges inside an IPv6 literal are not missed.
    if (a.startsWith("::ffff:")) {
      const parts = a.split(":").filter((p) => p !== "");
      // Case A: URL-normalized IPv4-mapped IPv6 like ::ffff:7f00:1 (pure hex tail).
      const tailParts = parts.slice(-2);
      if (tailParts.every((p) => /^[0-9a-fA-F]{1,4}$/.test(p))) {
        const hexTail = tailParts.map((p) => p.padStart(4, "0")).join("");
        const v4 = parseInt(hexTail, 16);
        const b = [
          String((v4 >>> 24) & 0xff),
          String((v4 >>> 16) & 0xff),
          String((v4 >>> 8) & 0xff),
          String(v4 & 0xff),
        ].join(".");
        return privateAddress(b);
      }
      // Case B: direct IPv4-mapped IPv6 like ::ffff:127.0.0.1 (dotted tail).
      const dotted = a.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
      if (dotted) return privateAddress(dotted[1]);
      // Malformed ::ffff: cannot be trusted → fail closed.
      return true;
    }
    if (a === "::1") return true;
    if (a.toLowerCase().startsWith("fe80")) return true;
    if (a.toLowerCase().startsWith("fc") || a.toLowerCase().startsWith("fd")) return true;
    return false;
  }
  return false;
}

export { privateAddress, isPrivateUrl };

async function isPrivateUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return true; }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return privateAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.some((a) => privateAddress(a.address));
  } catch {
    return true;
  }
}

export interface WebToolContext {
  readonly root: string;
}

export interface WebToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
}

export async function runWebTool(_ctx: WebToolContext, args: Record<string, unknown>): Promise<WebToolResult> {
  const op = String(args?.operation ?? "fetch").trim();
  if (op === "fetch") {
    const url = String(args?.url ?? "").trim();
    if (!url) return { ok: false, content: "", error: "url is required" };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, content: "", error: "invalid url" }; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, content: "", error: "only http/https allowed" };
    if (await isPrivateUrl(url)) return { ok: false, content: "", error: "private or local addresses are not allowed" };
    try {
      const res = await fetch(url, { headers: { "user-agent": "MausClaw-Native/1.0" }, signal: AbortSignal.timeout(30_000), redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc) {
          const redirectUrl = new URL(loc, url).href;
          if (await isPrivateUrl(redirectUrl)) return { ok: false, content: "", error: "redirect to private address blocked" };
        }
      }
      if (!res.ok) return { ok: false, content: "", error: `HTTP ${res.status}` };
      const text = await res.text();
      const clipped = text.length > FETCH_MAX_BYTES ? text.slice(0, FETCH_MAX_BYTES) + "\n[truncated]" : text;
      return { ok: true, content: clipped };
    } catch (e) {
      return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (op === "search") {
    const query = String(args?.query ?? "").trim();
    if (!query) return { ok: false, content: "", error: "query is required" };
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
      const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (MausClaw-Native)" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return { ok: false, content: "", error: `HTTP ${res.status}` };
      const html = await res.text();
      // Parse result links + snippets
      const results: string[] = [];
      const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      const links = [...html.matchAll(linkRegex)];
      const snippets = [...html.matchAll(snippetRegex)];
      for (let i = 0; i < Math.min(links.length, SEARCH_MAX_RESULTS); i++) {
        const href = links[i][1].replace(/.*uddg=/, "").split("&")[0];
        const title = links[i][2].replace(/<[^>]*>/g, "").trim();
        const snippet = (snippets[i]?.[1] ?? "").replace(/<[^>]*>/g, "").trim();
        let decoded = href;
        try { decoded = decodeURIComponent(href); } catch {}
        results.push(`${i + 1}. ${title}\n   ${decoded}\n   ${snippet}`);
      }
      if (results.length === 0) return { ok: true, content: "No results found." };
      return { ok: true, content: results.join("\n\n") };
    } catch (e) {
      return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, content: `Unknown operation: ${op}. Supported: fetch, search`, error: `Unknown operation: ${op}` };
}

export const WEB_TOOL_DESCRIPTOR = {
  id: "web",
  name: "web",
  description: "Fetch a URL or search the web. Operations: fetch (get page text), search (DuckDuckGo results).",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["fetch", "search"], description: "fetch or search (default fetch)" },
      url: { type: "string", description: "URL to fetch (for fetch)" },
      query: { type: "string", description: "Search query (for search)" },
    },
    additionalProperties: false,
  },
  risk: "read" as const,
  sideEffect: false,
  timeoutMs: 30_000,
};
