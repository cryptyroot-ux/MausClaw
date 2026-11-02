# Phase B/C/D/E — Deep Research & Mapping

Date: 2026-10-28
Status: research, execution in bounded slices
Scope: tool search, hooks, sandbox, checkpoints, fallback providers, session tree,
live probe, legacy loop retirement, external benchmarks.

## 1. Tool Search (deferred MCP schemas) — Claude ToolSearch pattern

### Problem
MausClaw loads ALL MCP tool schemas upfront (TOOL_COUNT=128 limit). With many MCP servers, this bloats
context and can exceed provider tool-schema limits. Claude Code defers MCP schemas behind ToolSearch
by default, loading them on demand.

### Design
- Add a `tool_search` capability (native tool) that searches MCP tool names/descriptions.
- MCP tools are registered but not sent to the model until searched.
- The model calls `tool_search("keyword")` → returns matching tool names → model can then call them.
- Implementation: maintain a registry of all MCP tools (name, description, server). Search by keyword.
- In turn-runtime: when building toolDescriptors, only include "core" tools (native file/shell/git/web)
  + tools that have been searched/loaded. MCP tools are loaded on demand.
- Invalidation: new MCP server → re-index.

### Effort: medium. Feasible.

## 2. Hooks (PreToolUse/PostToolUse/Stop/PreCompact)

### Problem
No extensibility point for user-configurable automation. Claude Code has hooks at PreToolUse,
PostToolUse, Stop, SubagentStart, PreCompact. MausClaw has `mausclaw-hook.ts` (Claude Code hook shim) but
no native hook system.

### Design
- Hook registry: `server/agent-runtime/hooks.ts` with `registerHook(event, handler)`.
- Events: `pre_tool_use`, `post_tool_use`, `stop`, `pre_compact`, `session_start`, `session_end`.
- Handler: `(context) => { allow: boolean; message?: string; modifiedArgs?: unknown }`.
- Invocation points in runtime.ts: before invoke (pre_tool_use), after invoke (post_tool_use),
  before compaction (pre_compact), at turn end (stop).
- Hooks can be user-configured via config or skill-defined.
- Hook results can block/modify tool calls.

### Effort: medium. Feasible.

## 3. Sandbox Boundary (Codex-style)

### Problem
MausClaw's shell tool runs with `shell: true` and cwd=workspace, but no real sandbox. Codex has
workspace-write/read-only/full/custom. MausClaw needs a sandbox boundary for shell safety.

### Design
- Sandbox modes: `workspace-write` (default, can write inside workspace), `read-only` (no writes),
  `full` (unrestricted), `custom` (allowlist).
- Shell tool checks sandbox mode before execution: in read-only, reject write commands.
- Implementation: simple path check (command doesn't traverse outside workspace) + mode flag.
- For "full" mode, allow any command. For "read-only", block commands that write (heuristic: rm, mv,
  >, >>, tee, etc.) — imperfect but better than nothing.
- Config: `sandboxMode` in bot config or global config.

### Effort: medium. Feasible.

## 4. Checkpoints/Rollback (Hermes pattern)

### Problem
MausClaw has run journal (SQLite) but no rollback. Hermes has checkpoints/rollback. MausClaw already has
`server/checkpoints.ts` (shadow git repo for checkpointing). But it's not wired into the agent loop.

### Design
- Before each mutating tool (risk "write"/"destructive"), create a checkpoint (shadow git snapshot).
- On failure/uncertain side effect, offer rollback.
- Checkpoint storage: reuse `server/checkpoints.ts` (shadow git per bot/thread).
- Integration: in runtime.ts, before invoke of mutating tool, call `createCheckpoint()`. On failure,
  emit `run.checkpoint_available` event with rollback option.
- Rollback: restore from checkpoint.

### Effort: medium. Feasible (checkpoints.ts already exists).

## 5. Fallback Provider Chains

### Problem
MausClaw has retry (transient) but no fallback to another provider. Hermes has fallback provider chains
with credential refresh on 401/403.

### Design
- Add `fallbackProviders: ProviderModelRef[]` to AgentRunRequest.
- In runtime.ts: if adapter.generate() throws a terminal error, try next provider in fallback chain.
- Credential refresh: on 401/403, mark key rejected (already done via noteKeyRejected) and try fallback.
- Integration: runtime.ts adapter resolution loop.

### Effort: medium. Feasible.

## 6. Session Tree (Pi-style)

### Problem
MausClaw uses thread-based sessions (linear). Pi uses JSONL tree with branch summaries. Hermes uses
SQLite with child session lineage.

### Design
- Large refactor. MausClaw's message-db stores messages per thread. To add tree structure, need:
  - `parent_thread_id` on threads.
  - Branch points (when user edits/regenerates).
  - Branch summary (compaction of the branch).
- This is a significant data model change.

### Effort: large. Defer.

## 7. Live Capability Probe

### Problem
Capability probe is heuristic only. No actual API call to verify capabilities.

### Design
- Add `probeLive(adapter, modelId)` that makes a minimal generate call (e.g., "say ok" with a trivial tool).
- Cache result per (provider, model).
- Requires API key (not testable in CI without secrets).
- Can be triggered manually or on first use.

### Effort: small. But needs API key for testing. Implement + document.

## 8. Retire Legacy Loop

### Problem
Legacy loop in native-turn-runtime.ts is unreachable in production but still present (40+ tests depend on it).
Full removal requires migrating tests to native path + moving key-rejection (done).

### Design
- Move key-rejection: DONE (all 4 adapters).
- Migrate tests: add `agentEngine: "mausclaw-native"` to sendTurn calls, verify native path produces same errors.
- Remove legacy loop block.
- Risk: native path may not handle all error cases the same way.

### Effort: medium-high. High risk (test migration). Defer to dedicated slice.

## 9. External Benchmarks

### Problem
No SWE-bench/Terminal-Bench/CodeClash/ProgramBench integration. Harness skeleton exists (evals/).

### Design
- evals/runners/ already has run-evals.ts (internal tasks).
- External benchmarks need: dataset download, harness setup, Docker (for SWE-bench).
- Terminal-Bench: pin dataset + harness version.
- CodeClash: requires git repos.
- ProgramBench: requires third-party audit.

### Effort: large. Needs external resources. Document + plan.

## Execution priority (feasible now, no external deps)

1. **Tool search** (medium, high impact) — deferred MCP schemas.
2. **Sandbox boundary** (medium, security) — workspace-write/read-only/full/custom.
3. **Hooks** (medium, extensibility) — PreToolUse/PostToolUse/Stop/PreCompact.
4. **Checkpoints/rollback** (medium, reliability) — reuse checkpoints.ts.
5. **Fallback provider chains** (medium, reliability) — try next provider.
6. **Live capability probe** (small, needs API key for testing) — implement + document.
7. **Retire legacy loop** (medium-high, high risk) — defer.
8. **Session tree** (large) — defer.
9. **External benchmarks** (large, needs resources) — defer, plan only.

## What I will execute now
Given "presisi" and bounded slices, I will execute in order:
1. Tool search (deferred MCP schemas)
2. Sandbox boundary
3. Hooks
4. Checkpoints/rollback
5. Fallback provider chains

Each as a separate commit, pushed. Items 6-9 documented as deferred with plan.

Live capability probe (7) I'll implement the function + document (no real API test).
