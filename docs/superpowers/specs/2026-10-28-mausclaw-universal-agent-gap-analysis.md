# MausClaw Universal Agent Platform — Deep Gap Analysis

Date: 2026-10-28
Status: research, awaiting direction
Scope: full audit of MausClaw-native against Claude Code, Codex, OpenCode, Hermes Agent, Pi, Antigravity —
what is missing to make MausClaw a universal agent platform, not a chat/trading bot platform.

## 0. Vision (user-stated, restated)

MausClaw is NOT an application riding an external agent engine. It is a **standalone agent platform** with
three non-mixing layers:

1. **Agent Engine** — owns the turn: admission, model rounds, tool orchestration, state, context,
   retry, recovery, steering, budget.
2. **LLM Provider/Model** — catalog, auth, protocol adapter. No loop.
3. **Capability System** — MCP, skills, native tools, browser/computer, data; one lifecycle
   `mount → invoke → close`, one permission/failure policy.

Target: architecture like GrokBot (own engine) but with **broader provider/model freedom** than any
single CLI agent. Must be **super power**: context management, tool orchestration, reliability,
planning/verification, and measurable eval. Must **beat** Claude Code, Codex, OpenCode, Hermes, Pi,
Antigravity on the dimensions MausClaw can win (provider freedom, multi-bot, 24/7, cost).

## 1. What top agents actually provide (source-grounded)

| Capability | Claude Code | Codex | OpenCode | Hermes | Pi | Antigravity |
|---|---|---|---|---|---|---|
| Agent loop (round+tool) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Native file tools (Read/Edit/Write/Glob/Grep) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Shell execution (Bash) | ✅ | ✅ (sandbox) | ✅ | ✅ | ✅ | ✅ (terminal) |
| Git operations | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Worktree isolation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Web search/fetch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Browser automation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (first-class) |
| Computer use | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Skills | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Subagents (isolated context) | ✅ (Agent tool) | ✅ | ✅ | ✅ (delegate_task) | ✅ | ✅ (invoke_subagent, nesting 10) |
| Plan mode / task tracking | ✅ (plan mode, TodoWrite) | ✅ (AGENTS.md) | ✅ | ✅ (todo tool) | ✅ | ✅ (/plan, Implementation Plan artifact, task list) |
| Verification (screenshots, recordings) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (first-class artifacts) |
| Context compaction | ✅ (auto, PreCompact hook) | ✅ (inline, provider-native) | ✅ (85%, 64k min, SHRINK_STEPS) | ✅ (50%/85%, last 20 protected) | ✅ (reserve 16k, keep 20k, cut point) | ✅ (artifacts) |
| Background compaction | ✅ | ✅ | ✅ (precompute at 85%) | ✅ | ✅ | ✅ |
| Concurrent read-only tools | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hooks (PreToolUse/PostToolUse/Stop/PreCompact) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sandbox/permissions | ✅ (permission modes) | ✅ (workspace-write/read-only/full/custom) | ✅ | ✅ (approval callback) | ✅ (trust, OS perms) | ✅ (sandbox scopes bubble up) |
| Session resume/fork/tree | ✅ | ✅ | ✅ | ✅ (SQLite, checkpoints) | ✅ (JSONL tree, branch summary) | ✅ |
| Checkpoints/rollback | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Fallback provider chains | ✅ | ✅ | ✅ | ✅ (credential refresh on 401/403) | ✅ | ✅ |
| Tool search (deferred MCP schemas) | ✅ (ToolSearch) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Multi-provider | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (multi-model) |
| Capability detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Live probe | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Provider-native compaction | ✅ (Responses) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Eval harness | ✅ (SWE-bench, Terminal-Bench) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cost/token tracking | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## 2. What MausClaw already has (internal audit)

### Layer 1 — Agent Engine
- ✅ Agent loop (MAX_MODEL_ROUNDS=64, MAX_TOOL_CALLS=200) — `runtime.ts`
- ✅ Compaction (auto at ~85% threshold, proportional keep 8-32k, usage-aware trigger, graduated shrink, cap summary, max 3/run) — `runtime.ts` (C1 done)
- ✅ Request-size recovery (compact on overflow + shrinkMessages) — `runtime.ts`
- ✅ Retry (transient/terminal classification, backoff) — `retry.ts`
- ✅ Recovery (`recovery_required`, uncertain side effects) — `runtime.ts`
- ✅ Steering (NativeSteerState, queue) — `turn-runtime.ts`
- ✅ Budgets (maxTokens, maxCostUsd, maxWallTimeMs) — `runtime.ts`
- ✅ Run journal (SQLite: agent_runs, agent_capability_calls, agent_compactions, agent_tool_outputs) — `run-store.ts`
- ✅ Tool output shaping (8k cap + stored read via capability) — `runtime.ts` + `capability-runtime.ts`
- ✅ Announcement nudge (max 3) — `announcement.ts`
- ✅ Multimodal (user images, tool result images) — `turn-runtime.ts`
- ✅ Steering mid-turn — `NativeSteerState`
- ❌ Background precompute — not implemented
- ❌ Subagents — not implemented
- ❌ Plan mode / task tracking — not implemented
- ❌ Hooks (PreToolUse/PostToolUse/Stop/PreCompact) — not implemented
- ❌ Concurrent read-only tools — sequential only
- ❌ Checkpoints/rollback — not implemented
- ❌ Session tree/resume/fork — thread-based only
- ❌ Fallback provider chains — not implemented
- ❌ Tool search (deferred MCP schemas) — not implemented

### Layer 2 — Provider/Model
- ✅ 10 drivers registered (openai-compat, grok, groq, meta, minimax, mistral, cerebras, anthropic, gemini, openai-responses)
- ✅ 4 protocol adapters (OpenAI chat-completions, Anthropic Messages, Gemini, OpenAI Responses)
- ✅ Capability probe (context window from catalog, vision/audio heuristics, non-tool deny-list, operator hints, cache)
- ✅ ModelCapabilities contract (tools, parallelTools, streaming, contextWindow, imageInput/Output, audioInput/Output, structuredOutput, toolSchemaLimit)
- ❌ Live capability probe (actual API call) — heuristic only
- ❌ Provider-native compaction (Codex Responses compaction) — not implemented
- ❌ Fallback provider chains — not implemented
- ❌ Credential refresh on 401/403 — not implemented

### Layer 3 — Capability System
- ✅ MCP (via ChatCapabilitySession bridge)
- ✅ Skills (prompt injection + SkillCapabilityProvider)
- ✅ CompositeCapabilityRuntime (aggregates providers, one grant policy)
- ✅ CapabilityProvider interface (list, validate, mount, invoke, close, describe)
- ✅ SessionCapabilityProvider (wraps CapabilitySession)
- ✅ SkillCapabilityProvider (skills as capabilities)
- ✅ tool_output_read (run-scoped capability, grant-governed)
- ✅ Browser/computer (via MCP)
- ✅ Approval (ask/floor/question) — in ChatCapabilitySession
- ✅ Tool scope (allowed/denied sets)
- ❌ Native file tools (Read/Edit/Write/Glob/Grep) — **MISSING** (only via MCP)
- ❌ Shell execution (Bash) — **MISSING** (only via MCP/computer)
- ❌ Git operations — **MISSING**
- ❌ Worktree isolation — **MISSING**
- ❌ Web search/fetch (native) — only via browser MCP
- ❌ Tool search (deferred MCP schemas) — **MISSING**
- ❌ Concurrent read-only tools — sequential only
- ❌ Sandbox boundary — approval only, no sandbox
- ❌ Hooks (PreToolUse/PostToolUse/Stop/PreCompact) — **MISSING**

## 3. Critical gaps (what makes MausClaw NOT yet universal)

### Tier 1 — Blocking (without these, MausClaw cannot handle software dev tasks)
1. **Native file tools** (Read, Edit, Write, Glob, Grep) — top agents have built-in; MausClaw only via MCP.
   - Need: `server/agent-runtime/native-file-tools.ts` implementing CapabilityProvider with 5 tools.
   - Each tool: read (with line range), edit (string replace), write (create/overwrite), glob (pattern match), grep (regex search).
   - Must handle: binary detection, large file truncation, path safety (no traversal outside workspace).
2. **Shell execution** (Bash) — top agents have built-in; MausClaw only via MCP/computer.
   - Need: `server/agent-runtime/native-shell-tool.ts` implementing CapabilityProvider.
   - Must handle: timeout, output capture, working directory, environment, exit code.
   - Sandbox: restrict to workspace by default (Codex-style workspace-write).
3. **Subagents** — Claude/Antigravity unggul; MausClaw belum punya.
   - Need: `Agent` tool that spawns isolated engine run with scoped tools, returns summary.
   - Parent context grows by summary, not transcript.
   - Async lifecycle (running/idle/killed), messaging, nesting limit (10).
4. **Plan mode + task tracking** — Antigravity/Claude; MausClaw belum.
   - Need: Plan mode (explore without editing), Implementation Plan artifact, task list (TodoWrite equivalent).
   - Approval gate before execution.

### Tier 2 — Important (for quality parity)
5. **Concurrent read-only tools** — Claude runs read-only tools concurrently; MausClaw sequential. Need: classify tools as read-only (risk: "read") and run concurrently.
6. **Background compaction** — OpenCode precomputes at 85%; MausClaw compacts synchronously. Need: background precompute with invalidation.
7. **Hooks** — PreToolUse/PostToolUse/Stop/PreCompact. Need: hook registry + invocation points.
8. **Fallback provider chains** — Hermes; MausClaw has retry but not fallback. Need: try next provider on failure.
9. **Checkpoints/rollback** — Hermes; MausClaw has run journal but no rollback. Need: checkpoint before mutating tools, rollback on failure.
10. **Tool search** (deferred MCP schemas) — Claude ToolSearch; MausClaw loads all MCP schemas upfront. Need: deferred loading + search.
11. **Session tree/resume/fork** — Pi; MausClaw thread-based. Need: tree structure, branch summary.

### Tier 3 — Nice to have
12. **Git operations + worktree** — capability (MCP git server or native tool).
13. **Live capability probe** — actual API call.
14. **External benchmarks** — SWE-bench, Terminal-Bench, CodeClash, ProgramBench.
15. **Retire legacy loop** — key-rejection moved; tests not migrated.
16. **Session tree** — Pi-style JSONL tree.

## 4. What MausClaw already does well (strengths to preserve)

- **Multi-bot persistent 24/7** — no top agent does this natively.
- **Provider-independent** (4 protocols, 10 drivers) — broader than any single CLI.
- **Capability runtime** (composite, grant policy, skill provider) — good foundation.
- **Compaction** (proportional, usage-aware, graduated shrink) — competitive.
- **Approval + tool scope + safety floor** — good permission model.
- **Steering mid-turn** — matches Pi.
- **Budgets** (tokens/cost/time) — matches Claude.
- **MCP + skills + browser/computer** — good capability coverage.
- **Run journal (SQLite)** — good auditability.
- **Multi-provider fallback potential** — not yet implemented but architecture supports it.

## 5. Roadmap (universal, ordered by dependency)

### Phase A — Native tools (makes MausClaw a coding agent)
1. **A1. Native file tools** (Read, Edit, Write, Glob, Grep) — CapabilityProvider, path-safe, truncation.
2. **A2. Shell execution** (Bash) — CapabilityProvider, timeout, output capture, sandbox (workspace-write default).
3. **A3. Git operations** (status, diff, log, commit, branch, checkout) — CapabilityProvider, uses git CLI.
4. **A4. Worktree isolation** — mount creates worktree, close cleans up. CapabilityProvider.
5. **A5. Web search/fetch** (native) — CapabilityProvider, uses fetch + search API.

### Phase B — Orchestration (makes MausClaw a power agent)
6. **B1. Subagents** — Agent tool, isolated context, scoped tools, async lifecycle, nesting limit 10.
7. **B2. Plan mode + task tracking** — explore without editing, Implementation Plan artifact, task list.
8. **B3. Concurrent read-only tools** — classify by risk, run concurrently.
9. **B4. Tool search** (deferred MCP schemas) — search MCP tools on demand.

### Phase C — Reliability (makes MausClaw robust)
10. **C1. Background compaction** — precompute at 85%, invalidate on history/model/instructions change.
11. **C2. Hooks** — PreToolUse/PostToolUse/Stop/PreCompact, user-configurable.
12. **C3. Checkpoints/rollback** — checkpoint before mutating tools, rollback on failure.
13. **C4. Fallback provider chains** — try next provider on failure, credential refresh.
14. **C5. Session tree/resume/fork** — Pi-style JSONL tree, branch summary.

### Phase D — Capability (makes MausClaw complete)
15. **D1. Sandbox boundary** — workspace-write/read-only/full/custom (Codex-style).
16. **D2. Git worktree as capability** — mount creates worktree.
17. **D3. Live capability probe** — actual API call for model capabilities.
18. **D4. Retire legacy loop** — key-rejection in adapters (done), migrate tests.

### Phase E — Proof (makes MausClaw credible)
19. **E1. Independence proof** — sealed PATH, no child process (done, native-only.e2e).
20. **E2. Eval report** — SWE-bench Verified, Terminal-Bench (pinned), CodeClash, ProgramBench + third-party audit.
21. **E3. Cost per resolved task** — measure, not just resolve rate.

## 6. What is NOT a gap (MausClaw's strengths to preserve)

- Multi-bot persistent 24/7 — unique, no top agent does this.
- Provider-independent (4 protocols) — broader than any single CLI.
- Capability runtime (composite, grant policy) — good foundation.
- Compaction (proportional, usage-aware, graduated shrink) — competitive.
- Approval + tool scope + safety floor — good permission model.
- Steering mid-turn — matches Pi.
- Budgets (tokens/cost/time) — matches Claude.
- MCP + skills + browser/computer — good capability coverage.
- Run journal (SQLite) — good auditability.

## 7. Honest assessment

**MausClaw is NOT yet a universal agent platform.** It has a strong engine (Layer 1) and good provider independence (Layer 2), but **Layer 3 (Capability System) lacks the native tools** (file, shell, git) that make top agents useful for software development. Without native file tools and shell, MausClaw cannot do coding tasks natively — it depends on MCP servers for everything.

**The single biggest gap is native file tools + shell execution.** These are the foundation of every top agent. Everything else (subagents, plan mode, git) builds on them.

**Priority order for "super power":**
1. Native file tools (Read/Edit/Write/Glob/Grep) — makes MausClaw a coding agent.
2. Shell execution (Bash) + sandbox — makes MausClaw powerful.
3. Subagents + plan mode — makes MausClaw autonomous.
4. Concurrent tools + hooks + checkpoints — makes MausClaw robust.
5. Git + worktree — makes MausClaw a dev tool.
6. Background compaction + fallback + session tree — makes MausClaw production-grade.
7. Eval proof — makes MausClaw credible.

**Estimated effort:** Phase A (native tools + shell) = 1-2 weeks. Phase B (orchestration) = 1-2 weeks. Phase C (reliability) = 1 week. Phase D (capability) = 1 week. Phase E (proof) = 1 week. Total ~6-8 weeks for full universal platform.

## 8. Immediate next step

Start with **Phase A1: Native file tools** (Read, Edit, Write, Glob, Grep) as a CapabilityProvider. This is the foundation everything else builds on. It is Layer 3 (capability), doesn't touch the engine, and is independently testable.

Mau saya riset dahulu cara implement native file tools (path safety, binary detection, truncation, edit semantics) sebelum eksekusi? (jawab "riset"/"eksekusi")
