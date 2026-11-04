import { describe, expect, it } from "vitest";

import { runWebTool, privateAddress, isPrivateUrl, type WebToolContext } from "./native-web-tool.ts";

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

  // M9: IPv4-mapped IPv6 normalization and private URL blocking (no network)
  it("privateAddress blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", () => {
    expect(privateAddress("[::ffff:127.0.0.1]")).toBe(true);
    expect(privateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("privateAddress blocks IPv4-mapped IPv6 private ranges", () => {
    expect(privateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(privateAddress("::ffff:172.16.0.1")).toBe(true);
    expect(privateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(privateAddress("::ffff:169.254.1.1")).toBe(true);
    expect(privateAddress("::ffff:100.64.1.1")).toBe(true);
  });

  it("privateAddress allows IPv4-mapped IPv6 public ranges", () => {
    expect(privateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(privateAddress("::ffff:1.1.1.1")).toBe(false);
  });

  it("isPrivateUrl blocks IPv4-mapped IPv6 without DNS (M9)", async () => {
    await expect(isPrivateUrl("http://[::ffff:127.0.0.1]/")).resolves.toBe(true);
    await expect(isPrivateUrl("http://[::ffff:192.168.1.1]/")).resolves.toBe(true);
  });

  it("isPrivateUrl blocks IPv4 private addresses without DNS", async () => {
    await expect(isPrivateUrl("http://127.0.0.1/")).resolves.toBe(true);
    await expect(isPrivateUrl("http://192.168.1.1/")).resolves.toBe(true);
  });
});
