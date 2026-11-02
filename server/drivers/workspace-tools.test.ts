import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspacePaths, executeWorkspaceTool, globToRegExp, parseUnifiedDiff, shellEnvironment, workspaceToolReadOnly, workspaceToolView, type WorkspaceToolsConfig } from "./workspace-tools.ts";

let base: string;
let root: string;
let config: WorkspaceToolsConfig;
const run = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => executeWorkspaceTool(name, args, config, signal);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ws-tools-"));
  root = join(base, "root");
  mkdirSync(root);
  config = { root };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("path safety", () => {
  it("refuses traversal and absolute paths outside the root", async () => {
    writeFileSync(join(base, "secret.txt"), "s");
    expect((await run("read_file", { path: "../secret.txt" })).ok).toBe(false);
    expect((await run("read_file", { path: join(base, "secret.txt") })).text).toMatch(/outside the workspace/);
    expect((await run("write_file", { path: "../x.txt", content: "x" })).ok).toBe(false);
    expect(existsSync(join(base, "x.txt"))).toBe(false);
  });
  it("refuses a symlink that leads out, for reads and writes", async () => {
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "f.txt"), "out");
    symlinkSync(join(base, "outside"), join(root, "link"));
    expect((await run("read_file", { path: "link/f.txt" })).text).toMatch(/symbolic link/);
    expect((await run("write_file", { path: "link/new.txt", content: "x" })).ok).toBe(false);
  });
  it("allows read roots read-only and write roots for writes", async () => {
    const skills = join(base, "skills");
    mkdirSync(skills);
    writeFileSync(join(skills, "SKILL.md"), "# skill");
    symlinkSync(skills, join(root, "skills"));
    config = { root, readRoots: [skills] };
    expect((await run("read_file", { path: "skills/SKILL.md" })).ok).toBe(true);
    expect((await run("read_file", { path: join(skills, "SKILL.md") })).ok).toBe(true);
    expect((await run("write_file", { path: join(skills, "SKILL.md"), content: "x" })).text).toMatch(/read-only/);
    config = { root, writeRoots: [skills] };
    expect((await run("write_file", { path: join(skills, "n.md"), content: "x" })).ok).toBe(true);
  });
  it("unrestricted lifts confinement", () => {
    expect(createWorkspacePaths({ root, unrestricted: true }).resolve("/etc/hosts", "read")).toBe("/etc/hosts");
  });
});

describe("file tools", () => {
  it("reads line ranges with numbers", async () => {
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
    const result = await run("read_file", { path: "a.txt", offset: 2, limit: 2 });
    expect(result.text).toContain("lines 2–3 of 4; next offset 4");
    expect(result.text).toContain("2\ttwo\n3\tthree");
    expect(result.text).not.toContain("four");
  });
  it("writes, then edits with a uniqueness check", async () => {
    expect((await run("write_file", { path: "d/b.ts", content: "let a = 1;\nlet a2 = 1;\n" })).ok).toBe(true);
    const dup = await run("edit_file", { path: "d/b.ts", old_string: "= 1;", new_string: "= 2;" });
    expect(dup.ok).toBe(false);
    expect(dup.text).toMatch(/occurs 2 times/);
    expect((await run("edit_file", { path: "d/b.ts", old_string: "let a = 1;", new_string: "let a = 3;" })).ok).toBe(true);
    expect((await run("edit_file", { path: "d/b.ts", old_string: "= 1;", new_string: "= 9;", replace_all: true })).ok).toBe(true);
    expect(readFileSync(join(root, "d/b.ts"), "utf8")).toBe("let a = 3;\nlet a2 = 9;\n");
    expect((await run("edit_file", { path: "d/b.ts", old_string: "missing", new_string: "x" })).text).toMatch(/not found/);
  });
  it("applies a unified diff with offset hunks, creates and deletes, all or nothing", async () => {
    writeFileSync(join(root, "m.txt"), "a\nb\nc\nd\ne\n");
    writeFileSync(join(root, "gone.txt"), "bye\n");
    const patch = [
      "--- a/m.txt", "+++ b/m.txt", "@@ -3,2 +3,2 @@", " c", "-d", "+D",
      "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world",
      "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", "",
    ].join("\n");
    const result = await run("apply_patch", { patch });
    expect(result.ok, result.text).toBe(true);
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("a\nb\nc\nD\ne\n");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hello\nworld\n");
    expect(existsSync(join(root, "gone.txt"))).toBe(false);
    const bad = await run("apply_patch", { patch: "--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-a\n+A\n--- a/m.txt\n+++ b/m.txt\n@@ -1 +1 @@\n-zzz\n+y\n" });
    expect(bad.ok).toBe(false);
    expect(readFileSync(join(root, "m.txt"), "utf8")).toBe("a\nb\nc\nD\ne\n");
  });
  it("parses headers with timestamps", () => {
    expect(parseUnifiedDiff("--- a/x\t2024\n+++ b/x\t2024\n@@ -1 +1 @@\n-a\n+b\n")[0]!.newPath).toBe("x");
  });
});

describe("search tools", () => {
  beforeEach(() => {
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const NEEDLE = 1;\n");
    writeFileSync(join(root, "src", "deep", "b.ts"), "const x = 'needle';\n");
    writeFileSync(join(root, "src", "c.md"), "NEEDLE in docs\n");
    writeFileSync(join(root, "node_modules", "pkg", "i.ts"), "NEEDLE\n");
  });
  for (const rg of [true, false]) {
    it(`greps with ${rg ? "ripgrep" : "the JS fallback"}`, async () => {
      if (!rg) process.env.MAUSCLAW_NO_RG = "1";
      try {
        const { ok, text } = await run("grep", { pattern: "NEEDLE", glob: "*.ts" });
        expect(ok).toBe(true);
        if (!rg) {
          expect(text).toBe("src/a.ts:1:export const NEEDLE = 1;");
        } else {
          expect(text).toContain("src/a.ts:1:export const NEEDLE = 1;");
          expect(text).not.toContain("c.md");
        }
        expect((await run("grep", { pattern: "needle", ignore_case: true, path: "src/deep" })).text).toContain("b.ts:1:");
      } finally { delete process.env.MAUSCLAW_NO_RG; }
    });
  }
  it("globs and lists", async () => {
    const found = (await run("glob", { pattern: "**/*.ts" })).text.split("\n").sort();
    expect(found).toEqual(["src/a.ts", "src/deep/b.ts"]);
    expect(globToRegExp("src/*.{ts,md}").test("src/c.md")).toBe(true);
    const listing = (await run("list_dir", { depth: 2 })).text;
    expect(listing).toContain("src/");
    expect(listing).toContain("  a.ts (25 B)");
  });
});

describe("shell", () => {
  it("runs in the workspace with exit code and output", async () => {
    const result = await run("shell", { command: "pwd; echo err >&2; exit 3" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("exit code 3");
    expect(result.text).toContain(root);
    expect(result.text).toContain("err");
    expect((await run("shell", { command: "echo hi", cwd: "." })).ok).toBe(true);
    expect((await run("shell", { command: "true", cwd: ".." })).ok).toBe(false);
  });
  it("times out and kills on abort", async () => {
    const timed = await run("shell", { command: "sleep 30", timeout_ms: 1000 });
    expect(timed.text).toContain("timeout");
    const abort = new AbortController();
    const started = Date.now();
    const pending = run("shell", { command: "sleep 30" }, abort.signal);
    setTimeout(() => abort.abort(), 200);
    const stopped = await pending;
    expect(stopped.text).toContain("the turn was stopped");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("starts in the background with a log", async () => {
    const result = await run("shell", { command: "echo bg-out", background: true });
    expect(result.text).toMatch(/pid \d+/);
    const log = /Output goes to (\S+)/.exec(result.text)![1]!;
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(join(root, log), "utf8")).toContain("bg-out");
  });
  it("keeps the server's secrets out of the environment", () => {
    const env = shellEnvironment(root, { PATH: "/bin", GH_TOKEN: "x", OPENAI_API_KEY: "y" });
    expect(env.PATH).toBe("/bin");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("approval view", () => {
  it("asks for shell and writes, never for reads", () => {
    expect(workspaceToolView("read_file", { path: "a" }).ask).toBe(false);
    expect(workspaceToolView("shell", { command: "ls" })).toMatchObject({ ask: true, title: "shell" });
    expect(workspaceToolView("write_file", { path: "a", content: "" }).ask).toBe(true);
    expect(workspaceToolReadOnly("grep")).toBe(true);
    expect(workspaceToolReadOnly("apply_patch")).toBe(false);
  });
});
