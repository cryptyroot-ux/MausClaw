# Native Computer Tool — Design (adapted from RootClaw concept)

Date: 2026-11-03
Status: design (awaiting approval)
Scope: add a built-in native computer execution capability to MausClaw's `server/agent-runtime/`, following the existing `native-shell-tool.ts` / `native-file-tools.ts` / `native-git-tool.ts` patterns. Concept adapted from RootClaw's `computer-exec-tools.ts` (`computer_exec` tool), re-implemented for MausClaw's `CapabilityProvider` contract (`contracts.ts`) without RootClaw's Docker/SSH/VPS dependencies.

---

## 1. Intent and why

RootClaw has a `computer_exec` tool (`server/drivers/computer-exec-tools.ts`) that runs shell commands inside a bot's container (VPS or Local VM) via `docker exec`. MausClaw's native engine already has `native-shell-tool.ts` (local shell in workspace root), `native-file-tools.ts`, `native-git-tool.ts`, and `native-web-tool.ts`, but lacks a dedicated "computer execution" capability that is scoped and gated separately from shell/file/git.

Adding a native computer tool to MausClaw's agent engine lets the model run commands in a controlled compute context (local workspace or remote container) through MausClaw's own `CapabilityProvider` contract, with budget, approval, and sandbox enforcement from `CapabilityGrant`.

This is the **only** RootClaw feature assessed as safe to bring into `server/agent-runtime/`. Saved-steps, waits, Postiz, host layer, plan-verify, tool-loop-guard, and evals remain outside `agent-runtime/` (separate packages) per prior audit.

---

## 2. Goals

- Add a `native-computer-tool.ts` in `server/agent-runtime/` implementing `CapabilityProvider` from `contracts.ts`.
- Capability id: `computer_exec` (or `native_computer_exec` — see naming decision below).
- Run shell commands in a sandboxed working directory (bot workspace root by default).
- Respect `CapabilityGrant` (allowed/denied, approval mode, risk level).
- Enforce timeout, output caps, and abort via `AbortSignal`.
- Integrate into `turn-runtime.ts` alongside existing native providers (file, shell, git, web, tool_search, ask_user).
- No dependency on RootClaw's `vps-ssh.ts`, `vps-computer.ts`, `container-computer.ts`, `env-path.ts`, `config.ts`, or Docker/SSH.

---

## 3. Non-goals

- Do NOT copy RootClaw's `computer-exec-tools.ts` code directly (it depends on RootClaw-specific modules and a different `CapabilityProvider` interface).
- Do NOT add Docker/SSH/VPS/container execution. MausClaw's native computer tool runs locally in the workspace root (like `native-shell-tool.ts`), with remote execution left as future work.
- Do NOT add `tool-loop-guard` (duplicates `verifier.ts` + `runVerifyLoop`).
- Do NOT add `plan-verify` (duplicates `server/intelligence/planner.ts` + `verifier.ts`).
- Do NOT add saved-steps, waits, Postiz, or host layer into `agent-runtime/`.

---

## 4. Anti-goals (failure modes)

- The new tool must not break existing `native-shell-tool.ts`, `native-file-tools.ts`, `native-git-tool.ts`, or `native-web-tool.ts`.
- The new tool must not bypass `CapabilityGrant` allow/deny or approval mode.
- The new tool must not leak control-plane environment variables (API keys, tokens) into the child process.
- The new tool must not allow path traversal outside the configured workspace root.
- The new tool must not hang indefinitely (timeout + abort required).

---

## 5. Constraints

- Language: TypeScript, same as rest of `server/agent-runtime/`.
- Interface: Must implement `CapabilityProvider` from `contracts.ts` (`list`, `validate`, `mount`, `invoke`, `close`, `describe`).
- Context: `CapabilityProvider` receives `{ grant, signal }` on invoke. Workspace root must come from turn context (botId → workspaceDir), passed via provider construction or invoke context.
- Error contract: `CapabilityResult` with `ok`, `content`, `error` fields.
- Concurrency: Mutating tool (risk: write) → sequential execution consistent with other mutating native tools.
- Follow MausClaw AGENTS.md comment rules (comments only for what code cannot say).

---

## 6. Approaches considered

### Approach A: Direct copy of RootClaw's `computer-exec-tools.ts`

- **Pros:** Zero design work; behavior matches RootClaw exactly.
- **Cons:** Imports RootClaw-specific modules (`vps-ssh.ts`, `vps-computer.ts`, `container-computer.ts`, `env-path.ts`, `config.ts`, `chat-mcp-tools.ts`). Uses RootClaw's own `CapabilityProvider` interface, not MausClaw's `contracts.ts`. Depends on Docker/SSH/VPS which MausClaw may not have. **Rejected.**

### Approach B: Adapt `native-shell-tool.ts` pattern with a new `native-computer-tool.ts` (RECOMMENDED)

- **Pros:** Follows existing MausClaw conventions exactly. Implements MausClaw's `CapabilityProvider`. No RootClaw dependencies. Runs locally in workspace root. Easy to test and maintain.
- **Cons:** Does not support Docker/SSH/VPS remote execution (out of scope anyway). **Selected.**

### Approach C: Add as a flag/mode inside `native-shell-tool.ts`

- **Pros:** No new file.
- **Cons:** Blurs shell vs computer semantics. `native-shell-tool.ts` is already "shell"; adding "computer" as a mode makes the file do two things. **Rejected.**

---

## 7. Decided implementation (Approach B)

### 7.1 File: `server/agent-runtime/native-computer-tool.ts`

Following `native-shell-tool.ts` structure:

```ts
// Native computer tool for the MausClaw agent engine. Runs a shell command in a
// controlled compute context (workspace root by default) with timeout, output cap,
// and abort. Built-in capability (no MCP server needed).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_COMMAND_CHARS = 4_000;
const STREAM_CAP_BYTES = 64 * 1024;
const TOTAL_CAP_BYTES = 128 * 1024;
const TRUNCATED = "[output truncated]";

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

export class NativeComputerCapabilityProvider implements CapabilityProvider {
  readonly id = "native-computer-exec";   // or "computer_exec" — naming decision below
  readonly kind = "native-tool" as const;
  private readonly ctx: ComputerToolContext;
  private closed = false;

  constructor(ctx: ComputerToolContext) {
    this.ctx = ctx;
  }

  list(grant: CapabilityGrant): ReadonlyArray<CapabilityDescriptor> {
    if (this.closed) return [];
    if (grant.denied.has("computer_exec")) return [];
    if (grant.allowed.size > 0 && !grant.allowed.has("computer_exec")) return [];
    return [{
      id: "computer_exec",
      name: "computer_exec",
      description: "Run a shell command in the computer's workspace and return exit code, stdout and stderr.",
      schema: {
        type: "object",
        properties: {
          command: { type: "string", maxLength: MAX_COMMAND_CHARS },
          cwd: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: MAX_TIMEOUT_MS },
        },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "write" as const,
      sideEffect: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }];
  }

  validate(call: CapabilityCall, grant: CapabilityGrant): void { ... }
  async mount(): Promise<void> { /* no process */ }
  async invoke(call: CapabilityCall, context: {...}): Promise<CapabilityResult> { ... }
  async close(): Promise<void> { this.closed = true; }
  describe(): string { return "native computer execution tool"; }
}
```

### 7.2 Naming decision

- Capability id: `computer_exec` (matches RootClaw's tool name for familiarity) OR `native_computer_exec` (MausClaw-prefixed to avoid collision). **Pending user decision.**
- File name: `native-computer-tool.ts` (matches `native-shell-tool.ts`, `native-file-tools.ts`, `native-git-tool.ts`, `native-web-tool.ts`).
- Class name: `NativeComputerCapabilityProvider`.

### 7.3 Integration in `turn-runtime.ts`

Add to the `providers` array in `runNativeTurn` (after existing native providers):

```ts
providers.push(new NativeFileCapabilityProvider({ root: fileRoot }, scope));
providers.push(new NativeShellCapabilityProvider({ root: fileRoot }, scope));
providers.push(new NativeGitCapabilityProvider({ root: fileRoot }, scope));
providers.push(new NativeWebCapabilityProvider({ root: fileRoot }, scope));
providers.push(new NativeComputerCapabilityProvider({ root: fileRoot }, scope));  // NEW
```

Also add `computer_exec` to the `allowed`/`denied` set parsing loop in `turn-runtime.ts` if `scope` contains a `computer` selector (similar to how `mcp` selectors are handled).

### 7.4 Security

- `cwd` defaults to `ctx.root` (workspace root). If `args.cwd` is provided, resolve inside `ctx.root` (path traversal check like `safeResolve` in `native-file-tools.ts`).
- `env` strips control-plane secrets (reuse `stripControlPlaneEnv` pattern from `native-shell-tool.ts`).
- Timeout: default 60s, max 120s. Kill process tree on timeout.
- Output cap: 64 KiB per stream, 128 KiB total (truncate with notice).
- Risk: `write` (mutating). sideEffect: `true`. Approval required unless grant mode is `full`.

### 7.5 Testing

- Unit test: `native-computer-tool.test.ts` following `native-shell-tool.test.ts` pattern.
- Test: valid command returns ok + stdout; invalid command returns error; timeout kills process; path traversal blocked; grant deny blocks tool; abort signal stops process.

---

## 8. What's left to the builder

- Confirm capability id: `computer_exec` vs `native_computer_exec`.
- Confirm file root source: `turn.botId ? workspaceDir(turn.botId) : process.cwd()` (same as existing providers).
- Decide whether `computer_exec` needs its own selector kind in `tool-scope.ts` (e.g. `{ kind: "native", name: "computer_exec" }`) or reuses existing native tool scope logic.
- Write the actual implementation and unit tests.
- Register the provider in `turn-runtime.ts`.
- Add any needed e2e tests.

---

## 9. Approval

This design is ready for review. Please confirm:

1. Is the scope correct (only native computer execution into `agent-runtime/`, nothing else from RootClaw)?
2. Is Approach B (new `native-computer-tool.ts` following `native-shell-tool.ts` pattern) acceptable?
3. Capability id: `computer_exec` or `native_computer_exec`?
4. Should I proceed to write the implementation code after your approval?
