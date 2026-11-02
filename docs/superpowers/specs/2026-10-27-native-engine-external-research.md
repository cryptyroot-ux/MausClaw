# MausClaw Native Engine — External Research and Capability Roadmap

Date: 2026-10-27
Scope: context management, tool orchestration, reliability, planning/verification, and evaluation in
Claude Code, Codex, OpenCode, Hermes Agent, Pi, and Google Antigravity — and what the MausClaw native engine
should adopt next.

This is a source-grounded comparison, not a benchmark. Vendor documentation describes intended
behaviour; it does not prove task quality. Section 5 defines the measurements needed before MausClaw claims
to match or beat another engine.

## 1. What each engine actually does

### Claude Code / Claude Agent SDK

- **Loop.** A turn is one model round plus tool execution; the loop repeats until a text-only answer,
  then emits a result with usage, cost, and session id. `maxTurns` and `maxBudgetUsd` bound the loop.
- **Tools.** Built-in Read/Edit/Write/Glob/Grep/Bash/Web/ToolSearch plus orchestration tools
  (`Agent`, `Skill`, `AskUserQuestion`, task tracking). Read-only tools run concurrently; mutating
  tools run sequentially. MCP schemas are deferred behind tool search by default.
- **Context.** System prompt, CLAUDE.md, tool schemas, history, and tool outputs all accumulate.
  Automatic compaction summarizes older history near the window limit; a `PreCompact` hook can archive
  the transcript; `/compact` is manual. The docs explicitly warn that early instructions can be lost,
  so persistent rules belong in CLAUDE.md, which is re-injected every request.
- **Subagents.** A subagent returns only its final response, so the parent context grows by a summary,
  not by the subtask transcript. Subagents get scoped tools and can override effort.
- **Control.** Permission modes (`default`, `acceptEdits`, `plan`, `dontAsk`, `auto`,
  `bypassPermissions`), allow/deny rules, hooks at PreToolUse/PostToolUse/Stop/SubagentStart/PreCompact,
  and session resume/fork.
- **Planning.** Plan mode explores and proposes without editing; hooks and permissions enforce the
  boundary.
- Source: <https://code.claude.com/docs/en/agent-sdk/agent-loop>

### OpenAI Codex

- **Loop.** The harness builds a prompt, samples the model, executes requested tools, appends results,
  and repeats until an assistant message ends the turn. Conversation history is part of every prompt,
  so context-window management is an explicit harness responsibility.
- **Context.** Codex has inline automatic compaction (`codex-rs/core/src/compact.rs`), a summarization
  prompt and summary prefix, a compacted user-message cap (20k tokens), and retained tool-output rules.
  Compaction can be local or provider-native (Responses compaction), with hooks and analytics around it.
- **Workspace instructions.** AGENTS.md (and project configuration) shape behaviour; the harness
  composes prompt fragments rather than relying on one giant system prompt.
- **Permissions.** Two independent controls: a sandbox (workspace-write, read-only, danger-full-access)
  and an approval policy. Modes are Ask for approval, Approve for me (automatic review), Full access,
  and Custom. Approval review does not expand the sandbox.
- **Reliability.** Sandbox boundaries, approval review, resumable threads, and session/rollout history.
- Sources: <https://developers.openai.com/codex/permission-modes>,
  <https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>

### OpenCode

- **Loop.** A session-oriented agent runtime with providers, tools, agents, and a background service.
- **Context.** Compaction replaces older conversation with a summary and keeps about 15k tokens of
  recent conversation verbatim (configurable `keep.tokens`). It keeps a buffer of 15% of the window
  (minimum 16k) free, and on a provider "too long" rejection it retries with progressively smaller
  prompts (`SHRINK_STEPS = [0.85, 0.7, 0.5, 0.35]`).
- **Compaction details.** The summarization request can reuse the normal request's prompt cache.
  Later compactions update the existing summary from the checkpoint. Background compaction can
  precompute a summary at ~85% of the threshold and swap it in later; it is skipped for small sessions,
  after model switches, and after an overflow rejection. Provider-native compaction is supported for
  OpenAI Responses models.
- **Agents/plugins.** Agent definitions, plugins, skills, and a session API; compaction is an explicit,
  observable session event.
- Sources: <https://opencode.ai/docs/compaction>, <https://github.com/sst/opencode/blob/dev/packages/core/src/session/compaction.ts>

### Hermes Agent (Nous Research)

- **Loop.** `AIAgent` owns prompt assembly, provider/API-mode selection, interruptible model calls,
  tool execution, history, compression, retries, fallback, and budgets. Three API modes converge on an
  internal OpenAI-style message format.
- **Tool execution.** Single call runs inline; multiple calls run concurrently in a thread pool, except
  interactive tools; results are reinserted in call order. Dangerous commands go through an approval
  callback. Agent-level tools (`todo`, `memory`, `session_search`, `delegate_task`) are intercepted
  before the registry.
- **Context.** Preflight compression above 50% of the model window; gateway compression above 85%.
  Memory is flushed to disk first, middle turns are summarized, the last 20 messages are protected,
  and tool call/result pairs are never split. Compression creates a child session lineage.
- **Reliability.** 500-iteration default budget (subagents capped at 50), fallback provider chains,
  credential refresh on 401/403, interruptible calls, resumable SQLite sessions, checkpoints/rollback.
- **Extensibility.** Context-engine plugins (including a lossless knowledge-DAG alternative), skills
  with progressive disclosure, hooks, cron, subagent delegation, code execution.
- Sources: <https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop>,
  <https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin>

### Pi (badlogic/pi-mono)

- **Loop.** A session is a tree of entries; the active branch supplies history. Steering messages enter
  after the current assistant turn; follow-up messages wait until pending work finishes; abort returns
  queued messages to the editor.
- **Context.** Auto-compaction triggers when `contextTokens > contextWindow - reserveTokens` (default
  reserve 16k). It keeps about 20k recent tokens, walks backwards to find the cut point, summarizes the
  older span with a structured format, passes the previous summary iteratively, and records
  `firstKeptEntryId`. A context-overflow error or a length stop can trigger one compact-and-retry.
- **Sessions.** JSONL tree; compaction adds an entry and leaves the original entries intact. Branch
  summarization preserves context when switching branches.
- **Extensibility.** Skills load full instructions on demand; extensions can transform context and add
  tools/commands; trust decides which project resources load; tools use OS permissions.
- Sources: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md>,
  <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/how-pi-works.md>

### Google Antigravity

- **Form factor.** Agent-first IDE plus an asynchronous Manager surface; agents plan, execute, and
  verify across editor, terminal, and browser.
- **Artifacts.** Task lists, implementation plans, walkthroughs, screenshots, and browser recordings are
  first-class deliverables for human review. Verification is treated as part of the work, not an
  afterthought.
- **Planning.** `/plan` explores without side effects, interviews the user when requirements are
  ambiguous, produces an Implementation Plan artifact, and waits for approval before execution.
  `/grill-me` is a Socratic requirements interview; `/boost` is a multi-agent deep-reasoning hierarchy;
  `/teamwork-preview` coordinates long-horizon agent teams.
- **Subagents.** `invoke_subagent` creates an isolated context window (no parent history), with
  inherit/branch/share workspace options, built-in research/browser/self agents, async lifecycle
  (running/idle/killed), messaging, transcript sharing, and a nesting limit of 10. Permissions bubble
  to the parent UI; subagents inherit sandbox scopes.
- **Learning.** Agent actions retrieve from and contribute to a knowledge base, so successful subtask
  trajectories become reusable knowledge.
- Sources: <https://antigravity.google/blog/introducing-google-antigravity/>,
  <https://antigravity.google/docs/plan/>, <https://antigravity.google/docs/subagents/>

## 2. Cross-engine patterns

1. **The loop is commodity; the harness is the product.** Every engine runs model → tool → result →
   model. What differs is context shaping, tool interfaces, permissions, recovery, and evaluation.
2. **Context is the scarce resource.** Leaders do not just truncate: they summarize, keep a verbatim
   recent window, protect tool call/result pairs, precompute summaries, and use subagents so subtask
   transcripts never enter the parent window.
3. **Compaction must be observable and recoverable.** Claude Code emits `compact_boundary`; OpenCode
   emits compaction events; Pi records `firstKeptEntryId`; Hermes creates a child session lineage.
   Users can archive or inspect the original transcript.
4. **Tool outputs are the biggest hidden cost.** Large reads and command output dominate context. The
   best harnesses cap tool output, retain full output out-of-band, and load detail on demand.
5. **Parallelism follows risk.** Read-only tools run concurrently; writes and shell commands serialize.
   Ordering is preserved in the transcript regardless of completion order.
6. **Planning is a reviewable artifact, not a hidden thought.** Antigravity's plan artifact, Claude
   Code's plan mode, and Hermes/Pi task tools all make the plan inspectable and approvable.
7. **Reliability is explicit.** Budgets, fallbacks, checkpoints, resumable sessions, interruptible
   calls, and recovery states are first-class.
8. **Evaluation is the differentiator.** SWE-bench Verified, Terminal-Bench, CodeClash, and ProgramBench
   measure different things; cost, tokens, and human interventions matter alongside resolve rate.

## 3. MausClaw native engine today

Already present:

- MausClaw-owned loop, provider-neutral model adapter, capability grants, approvals, cancellation, retry,
  recovery (`recovery_required`), SQLite run/capability journal.
- Steering between model rounds; announcement nudge; optional-tool downgrade; request-size recovery
  with history shrinking.
- Multimodal input (user images, tool-result images) with vision-capability gating.
- Seven API drivers on the native loop; external CLI/ACP engines filtered from the registry.

Not yet present (relative to the leaders):

| Capability | MausClaw now | Leader pattern |
|---|---|---|
| Lossy summarization compaction | Truncation/shrink only | LLM summary + keep window + iterative summary |
| Precompute/background compaction | No | OpenCode precompute, Claude PreCompact hook |
| Subagents / delegation | No | Claude `Agent`, Hermes `delegate_task`, Antigravity `invoke_subagent` |
| Plan artifact + approval gate | No | Antigravity `/plan`, Claude plan mode |
| Parallel tool execution | Sequential | Claude read-only concurrency, Hermes thread pool |
| Tool search / deferred schemas | No | Claude ToolSearch, MCP deferral |
| Prompt caching awareness | No | Claude/OpenCode cache reuse, stable prefix |
| Hooks / lifecycle extension | No | Claude hooks, Hermes plugin hooks, Antigravity hooks |
| Budget caps (tokens/cost/time) | Rounds/tool calls only | Claude maxTurns/maxBudget, Hermes iteration budget |
| Checkpoint/rollback | No | Hermes checkpoints, Pi session tree, Antigravity worktrees |
| Session search / long-term memory | Basic memory files | Hermes `session_search`, Antigravity knowledge base |
| Eval harness | Fixtures only | SWE-bench, Terminal-Bench, CodeClash, ProgramBench |

## 4. Prioritized roadmap

### P0 — makes the engine credible

1. **Summarization compaction** (not just truncation). Trigger near 70–85% of the known window; reserve
   ~16k; keep ~20k recent tokens; summarize older spans with a dedicated prompt; preserve the task,
   files touched, test results, decisions, and open risks; feed the previous summary iteratively.
   Record a `compaction` entry in the run journal and emit an event.
2. **Tool-output shaping.** Cap per-tool output in the prompt; keep the full output in the run journal
   or a content-addressed store; let the model request more by reference. Prevents one `cat` from
   consuming the window.
3. **Eval harness.** 30–50 deterministic repo tasks plus a Terminal-Bench subset; measure resolve rate,
   cost, tokens, wall time, tool calls, compactions, retries, and human interventions. No claims without
   this.
4. **Parallel read-only tools.** Run read-only calls concurrently, serialize writes/destructive calls,
   preserve result order. Add per-call timeouts and partial-batch handling.
5. **Budget caps.** Max tokens/cost/time per run, with explicit stop reasons and a final summary.

### P1 — makes the engine strong

6. **Subagents.** Isolated context, scoped tools, optional worktree, result summary returned to the
   parent; budget inheritance and a nesting limit.
7. **Plan artifact + verification gate.** A structured plan (objective, steps, files, acceptance
   criteria, tests) that the user can approve; execution checks each step against its verification.
8. **Hooks.** PreToolUse, PostToolUse, PreCompact, Stop, SubagentStart/Stop; hooks can block or inject
   context without consuming the model window.
9. **Prompt caching.** Stable prefix ordering, cache-aware compaction, avoid rewriting the system prompt
   every turn.
10. **Tool search / deferred MCP schemas.** Keep the base tool set small; load MCP tool schemas on demand.

### P2 — makes the engine distinctive

11. **Provider-native compaction** where the provider supports an opaque checkpoint.
12. **Session search and memory flush** before compaction; bounded curated memory with explicit writes.
13. **Checkpoint/rollback** for file mutations and worktrees.
14. **Knowledge base / self-improvement** from successful trajectories, with review and provenance.

## 5. Evaluation plan

Benchmarks:

- **SWE-bench Verified** — 500 human-filtered real GitHub issues; report % resolved, cost, tokens.
- **Terminal-Bench 4.0** — terminal tasks; report resolution rate, cost, tokens; confidence intervals.
- **CodeClash** — goal-oriented development, not single tasks.
- **ProgramBench** — building software artifacts from scratch.
- **Internal MausClaw suite** — the repo's own acceptance fixtures plus 30–50 curated tasks with deterministic
  checks.

Protocol:

- Fix model, temperature, tool set, and system prompt; run each task at least 3 times; report mean and
  95% confidence interval.
- Record full traces (model rounds, tool calls, compactions, retries, approvals, recovery states).
- Measure **cost per resolved task**, not only resolve rate; a 2% gain at 3× cost is not automatically
  an improvement.
- Separate model quality from harness quality: the same model must be run through MausClaw and through the
  comparison harness before claiming a harness win.
- Never train on benchmark tasks; keep a held-out internal set.

## 6. Immediate next slice

Implement **summarization compaction** on top of the existing request-size recovery:

- Add a `compaction` record to the run journal (summary, first kept message, token estimate, trigger).
- Trigger when the estimated prompt exceeds `window - reserve` (default reserve 16k); use the configured
  context window when known, otherwise a conservative default.
- Summarize with the same adapter and model (or a configured cheaper model); a failed summary falls back
  to the existing shrink path, never to a silent data loss.
- Keep the last N messages/tokens verbatim and never split a tool call/result pair.
- Emit a `compaction` event so the UI can show what happened; keep the full transcript in the journal.
- Tests: threshold trigger, pair integrity, summary failure fallback, repeated compaction, and a
  no-progress guard.

## Sources

- Claude Code agent loop: <https://code.claude.com/docs/en/agent-sdk/agent-loop>
- Building effective agents (Anthropic): <https://www.anthropic.com/engineering/building-effective-agents>
- Codex permissions: <https://developers.openai.com/codex/permission-modes>
- Codex compaction: <https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs>
- OpenCode compaction: <https://opencode.ai/docs/compaction>
- OpenCode source: <https://github.com/sst/opencode/blob/dev/packages/core/src/session/compaction.ts>
- Hermes agent loop: <https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop>
- Hermes context engine: <https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin>
- Pi compaction: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md>
- Pi architecture: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/how-pi-works.md>
- Antigravity introduction: <https://antigravity.google/blog/introducing-google-antigravity/>
- Antigravity plan: <https://antigravity.google/docs/plan/>
- Antigravity subagents: <https://antigravity.google/docs/subagents/>
- SWE-bench: <https://www.swebench.com/>
- Terminal-Bench: <https://www.tbench.ai/>
- Lost in the Middle: <https://arxiv.org/abs/2307.03172>
- Context Rot: <https://research.trychroma.com/context-rot>
