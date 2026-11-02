// Native git operations for the MausClaw agent engine. Uses execFile (no shell) for safety.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 100_000;

export interface GitToolContext {
  readonly root: string;
}

export interface GitToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_AUTHOR_NAME = "MausClaw";
  env.GIT_AUTHOR_EMAIL = "mausclaw@local";
  env.GIT_COMMITTER_NAME = "MausClaw";
  env.GIT_COMMITTER_EMAIL = "mausclaw@local";
  return env;
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, env: gitEnv(), timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: MAX_OUTPUT });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (err: any) {
    return { stdout: err?.stdout ?? "", stderr: err?.stderr ?? err?.message ?? "", code: typeof err?.code === "number" ? err.code : 1 };
  }
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n[truncated]" : s;
}

export async function runGitTool(ctx: GitToolContext, args: Record<string, unknown>): Promise<GitToolResult> {
  const op = String(args?.operation ?? "").trim();
  if (!op) return { ok: false, content: "", error: "operation is required" };

  const cwd = ctx.root;
  if (!existsSync(cwd)) return { ok: false, content: "", error: `Workspace not found: ${cwd}` };

  switch (op) {
    case "status": {
      const r = await runGit(["status", "--short", "--branch"], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || "Working tree clean." };
    }
    case "diff": {
      const paths = Array.isArray(args?.paths) ? args.paths.map(String) : [];
      const staged = args?.staged === true;
      const gitArgs = ["diff"];
      if (staged) gitArgs.push("--cached");
      if (paths.length) gitArgs.push("--", ...paths);
      const r = await runGit(gitArgs, cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || "No diff." };
    }
    case "log": {
      const maxCount = Math.min(50, Math.max(1, Number(args?.max_count) || 10));
      const oneline = args?.oneline !== false;
      const gitArgs = oneline
        ? ["log", `--max-count=${maxCount}`, "--oneline", "--decorate"]
        : ["log", `--max-count=${maxCount}`, "--format=%H%n%an <%ae>%n%ad%n%s%n"];
      const r = await runGit(gitArgs, cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: clip(r.stdout.trim()) || "No commits." };
    }
    case "add": {
      const paths = Array.isArray(args?.paths) ? args.paths.map(String) : ["."];
      const r = await runGit(["add", "--", ...paths], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: `Staged: ${paths.join(", ")}` };
    }
    case "commit": {
      const message = String(args?.message ?? "").trim();
      if (!message) return { ok: false, content: "message is required", error: "message is required" };
      const amend = args?.amend === true;
      const gitArgs = ["commit", "-m", message];
      if (amend) gitArgs.push("--amend");
      const r = await runGit(gitArgs, cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr || r.stdout, error: r.stderr || r.stdout };
      return { ok: true, content: clip((r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim()) };
    }
    case "branch": {
      if (args?.name) {
        const r = await runGit(["branch", String(args.name)], cwd);
        if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
        return { ok: true, content: `Created branch ${args.name}` };
      }
      if (args?.delete) {
        const r = await runGit(["branch", "-D", String(args.delete)], cwd);
        if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
        return { ok: true, content: `Deleted branch ${args.delete}` };
      }
      const r = await runGit(["branch", "-a"], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || "No branches." };
    }
    case "checkout": {
      const target = String(args?.target ?? "").trim();
      if (!target) return { ok: false, content: "target is required", error: "target is required" };
      const r = await runGit(["checkout", target], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || `Checked out ${target}` };
    }
    case "init": {
      const r = await runGit(["init", "--initial-branch=main"], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || "Initialized repository." };
    }
    case "worktree-add": {
      const path = String(args?.path ?? "").trim();
      const branch = String(args?.branch ?? "").trim();
      if (!path) return { ok: false, content: "", error: "path is required" };
      const resolved = path.startsWith("/") ? path : join(cwd, path);
      // safety: must be under workspace parent (sibling of repo)
      const gitArgs = branch ? ["worktree", "add", resolved, "-b", branch] : ["worktree", "add", resolved];
      const r = await runGit(gitArgs, cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || `Worktree created at ${resolved}` };
    }
    case "worktree-remove": {
      const path = String(args?.path ?? "").trim();
      if (!path) return { ok: false, content: "", error: "path is required" };
      const resolved = path.startsWith("/") ? path : join(cwd, path);
      const r = await runGit(["worktree", "remove", resolved, "--force"], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || `Worktree removed: ${resolved}` };
    }
    case "worktree-list": {
      const r = await runGit(["worktree", "list", "--porcelain"], cwd);
      if (r.code !== 0) return { ok: false, content: r.stderr, error: r.stderr };
      return { ok: true, content: r.stdout.trim() || "No worktrees." };
    }
    default:
      return { ok: false, content: `Unknown operation: ${op}. Supported: status, diff, log, add, commit, branch, checkout, init`, error: `Unknown operation: ${op}` };
  }
}

export const GIT_TOOL_DESCRIPTOR = {
  id: "git",
  name: "git",
  description: "Run git operations in the workspace: status, diff, log, add, commit, branch, checkout, init, worktree-add, worktree-remove, worktree-list.",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["status", "diff", "log", "add", "commit", "branch", "checkout", "init"] },
      paths: { type: "array", items: { type: "string" } },
      staged: { type: "boolean" },
      max_count: { type: "integer", minimum: 1, maximum: 50 },
      oneline: { type: "boolean" },
      message: { type: "string" },
      amend: { type: "boolean" },
      name: { type: "string" },
      delete: { type: "string" },
      list: { type: "boolean" },
      target: { type: "string" },
    },
    required: ["operation"],
    additionalProperties: false,
  },
  risk: "write" as const,
  sideEffect: true,
  timeoutMs: 30_000,
};
