import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runFileTool, type FileToolContext } from "./native-file-tools.ts";

let root: string;
let ctx: FileToolContext;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nft-")); ctx = { root }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("native file tools", () => {
  it("write creates a file", () => {
    const r = runFileTool(ctx, "write", { file_path: "a.txt", content: "hello" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("created");
  });

  it("read returns numbered lines", () => {
    writeFileSync(join(root, "a.txt"), "line1\nline2\nline3", "utf8");
    const r = runFileTool(ctx, "read", { file_path: "a.txt" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("1\tline1");
    expect(r.content).toContain("2\tline2");
  });

  it("edit replaces exact text", () => {
    writeFileSync(join(root, "a.txt"), "hello world", "utf8");
    const r = runFileTool(ctx, "edit", { file_path: "a.txt", old_string: "world", new_string: "MausClaw" });
    expect(r.ok).toBe(true);
    const read = runFileTool(ctx, "read", { file_path: "a.txt" });
    expect(read.content).toContain("hello MausClaw");
  });

  it("edit fails on ambiguous match without replace_all", () => {
    writeFileSync(join(root, "a.txt"), "x\nx", "utf8");
    const r = runFileTool(ctx, "edit", { file_path: "a.txt", old_string: "x", new_string: "y" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("2 times");
  });

  it("edit with replace_all replaces all", () => {
    writeFileSync(join(root, "a.txt"), "x\nx", "utf8");
    const r = runFileTool(ctx, "edit", { file_path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
    expect(r.ok).toBe(true);
    const read = runFileTool(ctx, "read", { file_path: "a.txt" });
    expect(read.content).toContain("1\ty");
    expect(read.content).toContain("2\ty");
  });

  it("glob finds files", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.ts"), "x", "utf8");
    writeFileSync(join(root, "sub", "b.ts"), "x", "utf8");
    writeFileSync(join(root, "c.js"), "x", "utf8");
    const r = runFileTool(ctx, "glob", { pattern: "**/*.ts" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("c.js");
  });

  it("grep finds matches", () => {
    writeFileSync(join(root, "a.txt"), "hello world\nfoo bar\nhello again", "utf8");
    const r = runFileTool(ctx, "grep", { pattern: "hello" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("hello world");
    expect(r.content).toContain("hello again");
  });

  it("grep files_with_matches mode", () => {
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    writeFileSync(join(root, "b.txt"), "nope", "utf8");
    const r = runFileTool(ctx, "grep", { pattern: "hello", output_mode: "files_with_matches" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("a.txt");
    expect(r.content).not.toContain("b.txt");
  });

  it("path traversal is blocked", () => {
    const r = runFileTool(ctx, "read", { file_path: "../../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("outside the workspace");
  });

  it("read on missing file errors", () => {
    const r = runFileTool(ctx, "read", { file_path: "nope.txt" });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("not found");
  });

  it("edit on missing file errors", () => {
    const r = runFileTool(ctx, "edit", { file_path: "nope.txt", old_string: "a", new_string: "b" });
    expect(r.ok).toBe(false);
  });

  it("binary detection", () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const r = runFileTool(ctx, "read", { file_path: "bin.dat" });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("binary file");
  });
});
