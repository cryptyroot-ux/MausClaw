# MausClaw — Research, Design, and Planning Index

Last updated: 2026-10-27
Repo: <https://github.com/cryptyroot-ux/MausClaw>
Branch: `feature/native-agent-engine` (mirrored to `main`)

This is the entry point for MausClaw architecture and delivery work. The documents are grouped by purpose and listed in reading order.

## 1. Design and acceptance

| Document | Purpose | Status |
|---|---|---|
| [`specs/2026-10-26-mausclaw-native-agent-platform-design.md`](specs/2026-10-26-mausclaw-native-agent-platform-design.md) | Approved architecture: MausClaw owns the loop, state, context, tools, retries, recovery, and provider adapters | Approved |
| [`specs/2026-10-26-mausclaw-cli-free-acceptance-contract.md`](specs/2026-10-26-mausclaw-cli-free-acceptance-contract.md) | What counts as proof: deterministic local API acceptance, optional approved live smoke, failure semantics | Approved |

## 2. Implementation plans

| Document | Purpose | Status |
|---|---|---|
| [`plans/2026-10-26-mausclaw-native-runtime-milestone-1.md`](plans/2026-10-26-mausclaw-native-runtime-milestone-1.md) | Milestone 1: engine loop, SQLite journal, OpenAI-compatible adapter, capability bridge, driver path | Complete (`f8fa7ba`…`21e5044`) |
| [`plans/2026-10-26-mausclaw-native-runtime-production-opt-in.md`](plans/2026-10-26-mausclaw-native-runtime-production-opt-in.md) | Milestone 2 + follow-ups: native-only registry, all API drivers, steering, nudge, multimodal, compaction, tool-output shaping | Active; Tasks 1–4 complete |
| [`plans/2026-10-26-native-runtime-typecheck.md`](plans/2026-10-26-native-runtime-typecheck.md) | Historical typecheck repair | Complete (`52f4f33`) |
| [`specs/2026-10-26-native-runtime-typecheck-design.md`](specs/2026-10-26-native-runtime-typecheck-design.md) | Design for the typecheck repair | Complete |

## 3. External research

| Document | Purpose | Status |
|---|---|---|
| [`specs/2026-10-27-native-engine-external-research.md`](specs/2026-10-27-native-engine-external-research.md) | Claude Code, Codex, OpenCode, Hermes, Pi, Antigravity: context, tools, reliability, planning, eval; MausClaw gap table and P0–P2 roadmap | Complete |
| [`specs/2026-10-27-mausclaw-platform-independence-audit.md`](specs/2026-10-27-mausclaw-platform-independence-audit.md) | Three-layer target (Agent Engine / Model Gateway / Capability Runtime), current-boundary audit, five-phase migration, independence proof | Phase 1a complete; Phase 1b pending |

## 4. Verification recipes

| Document | Covers |
|---|---|
| [`../verification/openai-tools.md`](../verification/openai-tools.md) | Real isolated server, loopback provider, real MCP tool, approval, cancellation; OpenAI-compatible/Groq/Meta |
| [`../verification/chat-ui.md`](../verification/chat-ui.md) | Real React renderer; native provider env (`MAUSCLAW_UI_NATIVE_URL/KEY/MODEL`) |
| [`../verification/chat-turns.md`](../verification/chat-turns.md) | Chat turn semantics, waits, approvals, Stop |
| [`../verification/context-compaction.md`](../verification/context-compaction.md) | Upstream context-compaction recipe (legacy engine labels) |
| [`../verification/automatic-recovery.md`](../verification/automatic-recovery.md) | Recovery behaviour |

Permanent tests:

```sh
pnpm exec vitest run server/agent-runtime
pnpm exec vitest run server/native-only.e2e.test.ts server/openai-tools.e2e.test.ts
AGENT_BROWSER_EXECUTABLE_PATH=/path/to/chrome pnpm exec vitest run server/native-ui.e2e.test.ts
pnpm typecheck && pnpm lint
```

## 5. What the engine does now

- MausClaw-owned agent loop; no external CLI/ACP engine is registered or launched.
- Seven API drivers on the native loop: OpenAI-compatible, Grok, Groq, Meta, MiniMax, Mistral, Cerebras.
- Durable run/capability journal; `recovery_required` for uncertain side effects.
- Steering between model rounds; announcement nudge; optional-tool downgrade.
- Request-size recovery and LLM summarization compaction (`agent_compactions`, `run.compacted`).
- Multimodal input: user images and tool-result images, gated by model capability.
- Tool-output shaping: large outputs are truncated in the prompt, retained in `agent_tool_outputs`, and readable
  through the internal `tool_output_read` capability.

## 6. Open roadmap (from the external research)

P0:

1. ~~Summarization compaction~~ (done).
2. ~~Tool-output shaping~~ (done).
3. Eval harness: 30–50 repo tasks + a Terminal-Bench subset; cost/tokens/time/resolve rate.
4. Parallel read-only tools; serialize writes.
5. Budget caps (tokens/cost/time) with explicit stop reasons.

P1: subagents with isolated context, plan artifact + verification gate, lifecycle hooks, prompt caching,
tool search/deferred MCP schemas.

P2: provider-native compaction, session search/memory flush, checkpoint/rollback, knowledge base.

## 7. Operational notes

- `server/index.test.ts` is upstream's fake Claude/Codex HTTP suite and is excluded from the native default.
  Set `MAUSCLAW_LEGACY_ENGINE_TESTS=1` only in an engine-enabled checkout.
- No live API smoke, canary, or deployment is part of these docs.
