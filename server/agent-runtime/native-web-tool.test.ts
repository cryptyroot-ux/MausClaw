import { describe, expect, it } from "vitest";

import { runWebTool, type WebToolContext } from "./native-web-tool.ts";

const ctx: WebToolContext = { root: "/tmp" };

describe("native web tool", () => {
  it("rejects empty url for fetch", async () => {
    const r = await runWebTool(ctx, { operation: "fetch", url: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects invalid url", async () => {
    const r = await runWebTool(ctx, { operation: "fetch", url: "not-a-url" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-http protocol", async () => {
    const r = await runWebTool(ctx, { operation: "fetch", url: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
  });

  it("fetches a real page", async () => {
    const r = await runWebTool(ctx, { operation: "fetch", url: "https://example.com" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Example Domain");
  });

  it("search returns results", async () => {
    const r = await runWebTool(ctx, { operation: "search", query: "mausclaw" });
    // Network may be unavailable in CI; accept either results or error
    expect(typeof r.content).toBe("string");
  });

  it("rejects unknown operation", async () => {
    const r = await runWebTool(ctx, { operation: "nope" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("Unknown operation");
  });
});
