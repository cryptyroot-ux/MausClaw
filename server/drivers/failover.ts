import { classifyError, HttpStatusError } from "./retry.ts";

/** Why a native turn should move to the next AI in the bot's fallback chain. */
export type FailoverKind = "quota" | "auth" | "server" | "model" | "context";

/** Cooldowns for a failed chain entry; the chain returns to it once they pass. */
export const SERVER_HOLD_MS = 10 * 60_000;
export const CONTEXT_HOLD_MS = 10 * 60_000;
export const MODEL_HOLD_MS = 6 * 60 * 60_000;

/** Only failures that left nothing behind move on: never an abort, never once output reached the person, and never a
 * request the person caused (400/422). `error` is what remained after retry.ts gave up; `tooLarge` is an overflow that
 * emergency compaction and the smaller resend could not fix. */
export function failoverKind(error: Error, state: { aborted: boolean; produced: boolean; tooLarge?: boolean }): FailoverKind | null {
  if (state.aborted || state.produced) return null;
  if (state.tooLarge) return "context";
  const { transient, reason } = classifyError(error);
  if (reason === "quota") return "quota";
  if (reason === "auth") return "auth";
  if (reason === "unknown_model" || (reason === "not_found" && error instanceof HttpStatusError)) return "model";
  if (transient && (reason === "rate_limited" || reason === "overloaded" || reason === "server_error" || reason === "connection_reset" || reason === "timeout")) return "server";
  return null;
}

/** The runtime.error fields the host's limit clock and quota switch read: an engine-wide limit, a model held until
 * a reset, or a signed-out stop. */
export function failoverHold(kind: FailoverKind, now = Date.now()): { limit?: "engine" | "model"; limitResetsAt?: number; stopReason?: "auth_required" } {
  switch (kind) {
    case "quota": return { limit: "engine" };
    case "auth": return { stopReason: "auth_required" };
    case "server": return { limit: "model", limitResetsAt: now + SERVER_HOLD_MS };
    case "context": return { limit: "model", limitResetsAt: now + CONTEXT_HOLD_MS };
    case "model": return { limit: "model", limitResetsAt: now + MODEL_HOLD_MS };
  }
}
