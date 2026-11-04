// Native shell (Bash) tool for the MausClaw agent engine. Runs a command in the
// workspace root with a timeout and captured output. No MCP server needed.
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATE_NOTICE = "\n\n[Output truncated at 1 MB. Re-run with a narrower command or redirect to a file.]";

export interface ShellToolContext {
  readonly root: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sandboxMode?: "workspace-write" | "read-only" | "full";
  /** Run the command inside the OS sandbox (bot box / bubblewrap). Returns null when
   *  the sandbox is unavailable; the caller must fail closed rather than run on the host. */
  readonly spawnBoxed?: (command: string, cwd: string, env: NodeJS.ProcessEnv, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }) => Promise<ShellToolResult | null>;
}

export interface ShellToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

function stripControlPlaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  // Allowlist: only pass safe env vars, never credentials.
  const SAFE = /^(PATH|HOME|PWD|USER|LANG|LC_|TERM|SHELL|TMPDIR|TMP|TEMP|NODE_|PYTHON|GOPATH|GOROOT|JAVA_HOME|CARGO|RUSTUP|NVM|NPM_CONFIG|XDG_|DISPLAY|COLORTERM|TERM_PROGRAM|SHLVL|_)$/i;
  for (const [name, value] of Object.entries(env ?? {})) {
    if (SAFE.test(name)) out[name] = value;
  }
  return out;
}

const WRITE_INDICATORS = /\b(rm|mv|cp|chmod|chown|mkdir|rmdir|touch|dd|tee|truncate|install|ln|rsync|scp)\b|\b(python3?|node|perl|ruby|awk)\b.*-c\b|[>]{1,2}|\bsed\b.*-i\b|\bgit\b.*\b(checkout|reset|clean|push|commit|merge|rebase)\b|\b(vi|nano|vim)\b/;

function isWriteCommand(command: string): boolean {
  return WRITE_INDICATORS.test(command);
}

export async function runShellTool(ctx: ShellToolContext, args: Record<string, unknown>, signal?: AbortSignal): Promise<ShellToolResult> {
  const command = String(args?.command ?? "").trim();
  if (!command) return { ok: false, content: "command is required", error: "command is required", exitCode: null, durationMs: 0 };

  const sandboxMode = ctx.sandboxMode ?? "workspace-write";
  if (sandboxMode === "read-only" && isWriteCommand(command)) {
    return { ok: false, content: "Command blocked: read-only sandbox mode does not allow write operations.", error: "sandbox_blocked", exitCode: null, durationMs: 0 };
  }

  const timeout = Math.min(Math.max(1000, Number(args?.timeout) || DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const description = args?.description ? String(args.description) : "";
  const start = Date.now();

  const env = stripControlPlaneEnv(ctx.env ?? process.env);
  env.PATH = process.env.PATH ?? "/usr/bin:/bin";
  env.HOME = process.env.HOME ?? ctx.root;
  env.PWD = ctx.root;

  // OS-enforced isolation via the bot box. When a boxed spawn runner is provided it is
  // the only path; a null result means the sandbox is unavailable and we fail closed.
  if (ctx.spawnBoxed) {
    const boxed = await ctx.spawnBoxed(command, ctx.root, env, { signal, timeoutMs: timeout });
    if (!boxed) {
      return { ok: false, content: "native shell requires OS sandbox which is unavailable", error: "isolation_unavailable", exitCode: null, durationMs: Date.now() - start };
    }
    return {
      ok: boxed.ok,
      content: `${description ? `[${description}]\n` : ""}${boxed.content}`,
      ...(boxed.error ? { error: boxed.error } : {}),
      exitCode: boxed.exitCode,
      durationMs: boxed.durationMs,
    };
  }

  return new Promise<ShellToolResult>((resolve) => {
    const controller = new AbortController();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: ctx.root,
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

    // Wire external abort signal to controller
    if (signal) {
      if (signal.aborted) { controller.abort(); }
      else { signal.addEventListener("abort", () => controller.abort(), { once: true }); }
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      let output = stdout;
      if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
      if (output.length > MAX_OUTPUT_BYTES) output = output.slice(0, MAX_OUTPUT_BYTES) + TRUNCATE_NOTICE;
      const header = description ? `[${description}]\n` : "";
      const exitCode = typeof code === "number" ? code : null;
      const reason = timedOut ? `timed out after ${timeout}ms` : (killed ? "killed by abort signal" : (code !== 0 ? `exit code ${code}` : ""));
      const exitInfo = timedOut ? `timed out (${durationMs}ms)` : `exit code: ${exitCode ?? "?"} (${durationMs}ms)`;
      resolve({ ok: !timedOut && exitCode === 0, content: `${header}${output}\n${exitInfo}${reason ? `\n${reason}` : ""}`.trim(), error: reason || undefined, exitCode, durationMs });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut || err.name === "AbortError") {
        killed = true;
        const output = (stdout + (stderr ? "\n--- stderr ---\n" + stderr : "")).slice(0, MAX_OUTPUT_BYTES);
        const reason = timedOut ? `timed out after ${timeout}ms` : "interrupted";
        resolve({ ok: false, content: `${description ? `[${description}]\n` : ""}${output}\n${reason} (${durationMs}ms)`, error: reason, exitCode: null, durationMs });
      } else {
        resolve({ ok: false, content: `error: ${err.message}`, error: err.message, exitCode: null, durationMs });
      }
    });
  });
}

export const SHELL_TOOL_DESCRIPTOR = {
  id: "bash",
  name: "bash",
  description: "Execute a shell command in the workspace. Supports pipes, redirects, &&. Times out at 2 min by default (max 10 min).",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      description: { type: "string", description: "Short description of what the command does." },
      timeout: { type: "integer", minimum: 1000, maximum: 600000, description: "Timeout in ms (default 120000, max 600000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  risk: "write" as const,
  sideEffect: true,
  timeoutMs: 600_000,
};
