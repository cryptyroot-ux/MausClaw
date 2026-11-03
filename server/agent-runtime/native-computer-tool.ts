// Native computer execution tool for the MausClaw agent engine. Runs a shell
// command in a sandboxed working directory (workspace root by default) with a
// timeout, per-stream and total output caps, and abort support. Built-in
// capability, no MCP server needed.
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_COMMAND_CHARS = 4_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const STREAM_CAP_BYTES = 64 * 1024;
export const TOTAL_CAP_BYTES = 128 * 1024;

export interface ComputerToolContext {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ComputerToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export const COMPUTER_TOOL_DESCRIPTOR = {
  id: "computer_exec",
  name: "computer_exec",
  description: "Run a shell command in the computer's workspace and return exit code, stdout and stderr.",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", maxLength: MAX_COMMAND_CHARS },
      cwd: { type: "string" },
      timeout_ms: { type: "integer", minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
    },
    required: ["command"],
    additionalProperties: false,
  },
  risk: "write" as const,
  sideEffect: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

/** Resolve a cwd input inside `root`, rejecting anything that escapes (incl. symlink escape). Falls back to `root`. */
function safeCwd(root: string, input: string | undefined): string {
  if (!input) return root;
  const resolved = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return root;
  try {
    const real = realpathSyncSafe(resolved);
    const realRel = relative(root, real);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return root;
  } catch {
    try {
      const parentReal = realpathSyncSafe(resolve(resolved, ".."));
      const parentRel = relative(root, parentReal);
      if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) return root;
    } catch {}
  }
  return resolved;
}

function realpathSyncSafe(p: string): string {
  const fs = require("node:fs");
  return fs.realpathSync(p);
}

/** Only pass through safe, non-credential environment variables to the child process. */
function stripControlPlaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const SAFE = /^(PATH|HOME|PWD|USER|LANG|LC_|TERM|SHELL|TMPDIR|TMP|TEMP|NODE_|PYTHON|GOPATH|GOROOT|JAVA_HOME|CARGO|RUSTUP|NVM|NPM_CONFIG|XDG_|DISPLAY|COLORTERM|TERM_PROGRAM|SHLVL|_)$/i;
  const BLOCKED = /^(API|TOKEN|SECRET|KEY|PASS|CREDENTIAL)/i;
  for (const [name, value] of Object.entries(env ?? {})) {
    if (BLOCKED.test(name)) continue;
    if (SAFE.test(name)) out[name] = value;
  }
  return out;
}

export async function runComputerTool(ctx: ComputerToolContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerToolResult> {
  const command = String(args?.command ?? "").trim();
  if (!command) return { ok: false, content: "command is required", error: "command is required", exitCode: null, durationMs: 0 };

  const timeout = Math.min(Math.max(MIN_TIMEOUT_MS, Number(args?.timeout_ms) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const cwd = safeCwd(ctx.root, args?.cwd as string | undefined);
  const start = Date.now();

  const env = stripControlPlaneEnv(ctx.env ?? process.env);
  env.PATH = process.env.PATH ?? "/usr/bin:/bin";
  env.HOME = process.env.HOME ?? ctx.root;
  env.PWD = cwd;

  return new Promise<ComputerToolResult>((resolve) => {
    const controller = new AbortController();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) { controller.abort(); }
      else { signal.addEventListener("abort", () => controller.abort(), { once: true }); }
    }

    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < STREAM_CAP_BYTES) {
        const room = STREAM_CAP_BYTES - stdout.length;
        stdout += data.toString("utf8").slice(0, room);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < STREAM_CAP_BYTES) {
        const room = STREAM_CAP_BYTES - stderr.length;
        stderr += data.toString("utf8").slice(0, room);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      let out = stdout;
      let err = stderr;
      const total = Buffer.byteLength(out) + Buffer.byteLength(err);
      if (total > TOTAL_CAP_BYTES) {
        const over = total - TOTAL_CAP_BYTES;
        if (err.length > over) {
          err = err.slice(0, err.length - over) + `\n[output truncated]`;
        } else if (out.length > over) {
          out = out.slice(0, out.length - over) + `\n[output truncated]`;
        }
      }
      let output = out;
      if (err) output += (output ? "\n--- stderr ---\n" : "") + err;
      const exitCode = typeof code === "number" ? code : null;
      const reason = timedOut ? `timed out after ${timeout}ms` : (killed ? "killed by abort signal" : (code !== 0 ? `exit code ${code}` : ""));
      const exitInfo = timedOut ? `timed out (${durationMs}ms)` : `exit code: ${exitCode ?? "?"} (${durationMs}ms)`;
      const ok = !timedOut && !killed && exitCode === 0;
      resolve({ ok, content: `${output}\n${exitInfo}${reason ? `\n${reason}` : ""}`.trim(), error: reason || undefined, exitCode, durationMs });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut || err.name === "AbortError") {
        killed = true;
        const output = (stdout + (stderr ? "\n--- stderr ---\n" + stderr : "")).slice(0, TOTAL_CAP_BYTES);
        const reason = timedOut ? `timed out after ${timeout}ms` : "interrupted";
        resolve({ ok: false, content: `${output}\n${reason} (${durationMs}ms)`, error: reason, exitCode: null, durationMs });
      } else {
        resolve({ ok: false, content: `error: ${err.message}`, error: err.message, exitCode: null, durationMs });
      }
    });
  });
}
