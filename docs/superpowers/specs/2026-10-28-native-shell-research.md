# Native Shell (Bash) Tool — Research & Design

Date: 2026-10-28
Status: research + implementation
Scope: built-in shell execution capability for MausClaw native engine.

## 1. Why native shell

MausClaw has no built-in shell. Commands run only via MCP servers or computer-use MCP. Top agents (Claude
Code, Codex, OpenCode, Hermes, Pi) all have a Bash/shell tool. Without it, MausClaw cannot run builds,
tests, git, or any CLI workflow natively. This is the second-biggest gap after file tools.

## 2. Design (Claude Code / Codex inspired)

### 2.1 Bash tool
- Input: `command` (string, required), `description` (string), `timeout` (ms, default 120000, max 600000),
  `run_in_background` (boolean, default false).
- Output: stdout + stderr (merged or separate), exit code, duration.
- Uses shell (`/bin/sh` or `cmd.exe`) so pipes, redirects, && work.
- cwd = workspace root (sandbox). env = minimal (PATH, HOME, plus workspace).
- Timeout: kill process tree on timeout.
- Output cap: 1MB (truncate with notice).
- Background: spawn detached, return immediately with process id (Phase A2b).

### 2.2 Security (Codex-style sandbox)
- Default: workspace-write (cwd = workspace, can write inside workspace).
- No network by default? (Codex has network toggle). MausClaw: allow network (too restrictive otherwise), but
  document the risk.
- Strip control-plane env (API keys, tokens) from child env (reuse stripControlPlaneEnv).
- Timeout hard cap 10 min.
- No shell injection: command is passed to shell, but args are not separately quoted (shell: true). The
  model is trusted (it's the agent). This matches Claude Code.

### 2.3 Concurrency
- Shell is mutating (risk: write) → runs sequentially (not concurrent with other mutating tools).
- Multiple shell calls in one turn run sequentially.

## 3. Implementation

- Use `exec` (promisified) with `shell: true`, `cwd`, `timeout`, `maxBuffer: 1MB`, `env`.
- On timeout, exec kills the process; detect `killed` + `signal` and report "timed out".
- Capture stdout + stderr separately, merge in output with labels.
- Return exit code + duration + truncated output.
- Background mode: spawn detached, return pid + "started in background". (Phase A2b)

## 4. Integration

- `NativeShellCapabilityProvider` implementing CapabilityProvider, kind "native-tool".
- Tools: `bash` (id: "bash").
- Risk: "write" (mutating), sideEffect: true, approval required unless full mode.
- Register in turn-runtime.ts alongside file tools.

## 5. Path safety

- cwd = workspace root (validated).
- env strips control-plane secrets (reuse existing).
- No path traversal (cwd is fixed).

## 6. Testing

- Unit: echo, exit code, timeout, stderr capture, large output truncation.
- Integration: native-only.e2e (optional, run a command in the turn).

## 7. Risks

- Shell injection: model is trusted (agent). Sandbox via cwd + env. Acceptable for now.
- Long-running commands: timeout kills. Background mode for long tasks (Phase A2b).
- Output flooding: 1MB cap.

## 8. Open questions

- Should shell be gated behind a feature flag? Recommendation: default on (like file tools).
- Should we restrict to workspace cwd only? Recommendation: yes (workspace-write default).
- Background mode now or later? Recommendation: Phase A2 (foreground only), A2b (background) later.
