// Runs a command already wrapped by the bot box (server/bot-box/box.ts) inside its
// bubblewrap sandbox, capturing output with a timeout and abort support. Returns
// null when the wrapper is absent so callers can fail closed instead of running
// on the host.
import { closeSync } from "node:fs";
import { spawn, type StdioOptions } from "node:child_process";
import type { WrappedSpawn } from "../bot-box/box.ts";

export interface BoxedRunResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface BoxedRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export async function runBoxedSpawn(
  wrapped: WrappedSpawn | null,
  options: BoxedRunOptions = {}
): Promise<BoxedRunResult | null> {
  if (!wrapped) return null;
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = MAX_OUTPUT_BYTES } = options;
  const start = Date.now();
  const controller = new AbortController();
  const stdio: StdioOptions = ["ignore", "pipe", "pipe", ...wrapped.extraFds] as unknown as StdioOptions;
  const child = spawn(wrapped.command, wrapped.args, {
    env: wrapped.env,
    stdio,
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  });
  // The parent no longer needs the extra descriptors (e.g. the seccomp filter fd).
  for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let killed = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  const abort = () => {
    killed = true;
    try { child.kill("SIGKILL"); } catch {}
  };
  if (signal) {
    if (signal.aborted) { abort(); }
    else { signal.addEventListener("abort", abort, { once: true }); }
  }
  controller.signal.addEventListener("abort", abort, { once: true });

  child.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
    if (stdout.length > maxOutputBytes) stdout = stdout.slice(0, maxOutputBytes);
  });
  child.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
    if (stderr.length > maxOutputBytes) stderr = stderr.slice(0, maxOutputBytes);
  });

  return new Promise<BoxedRunResult>((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      let output = stdout;
      if (stderr) output += (output ? "\n--- stderr ---\n" : "") + stderr;
      if (output.length > maxOutputBytes) output = output.slice(0, maxOutputBytes) + "\n\n[Output truncated]";
      const exitCode = typeof code === "number" ? code : null;
      const timedOutMsg = timedOut ? `timed out after ${timeoutMs}ms` : "";
      const killedMsg = killed ? "killed by abort signal" : "";
      const exitCodeMsg = code !== 0 ? `exit code ${code}` : "";
      const reason = timedOutMsg || killedMsg || exitCodeMsg;
      const statusMsg = timedOut ? `timed out (${durationMs}ms)` : `exit code: ${exitCode ?? "?"} (${durationMs}ms)`;
      resolve({
        ok: !timedOut && !killed && exitCode === 0,
        content: `${output}\n${statusMsg}${reason ? `\n${reason}` : ""}`.trim(),
        error: reason || undefined,
        exitCode,
        durationMs,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const output = (stdout + (stderr ? "\n--- stderr ---\n" + stderr : "")).slice(0, maxOutputBytes);
      resolve({
        ok: false,
        content: `${output}\nerror: ${err.message} (${durationMs}ms)`.trim(),
        error: err.message,
        exitCode: null,
        durationMs,
      });
    });
  });
}
