# MausClaw Project Status Report

**Generated:** 2026-10-28  
**Branch:** `feature/native-agent-engine`  
**Base Commit:** `927343a3e` (docs: deep research on remaining gaps)  
**Working Tree:** 15 modified files (see Git Status below)

---

## Executive Summary

MausClaw is a **standalone agent platform** forked from MausClaw (Apache-2.0). Unlike the upstream app, MausClaw:
- Does **not** require external CLI/ACP engines (Claude Code, Codex, OpenCode, Hermes, Pi, Antigravity)
- Uses **provider API adapters** for all model access
- Runs an **MausClaw-owned native agent engine** (`mausclaw-native`) with SQLite run journal and capability orchestration
- Has a **unified capability runtime** governing MCP, native tools, skills, browser, and computer use

**Current Phase:** Native agent engine migration — legacy driver loop being retired, 40+ tests migrating to native path.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Provider Catalog + Auth                                        │
│  (server/model-catalog/, server/drivers/*.ts)                   │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Protocol Adapters (chat-completions, Responses, Anthropic,    │
│  Gemini, Grok, Meta, MiniMax, Mistral, Cerebras, OpenAI)      │
│  (server/drivers/*.ts → server/agent-runtime/*-adapter.ts)     │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  MausClaw Agent Engine — Native Loop                                 │
│  • Admission, model rounds, tool orchestration                  │
│  • Context, state, retry, recovery, steering, budgets           │
│  • Request-size recovery + summarization compaction             │
│  (server/agent-runtime/runtime.ts, turn-runtime.ts,            │
│   native-turn-runtime.ts, model-adapter.ts, contracts.ts)       │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Capability Runtime                                             │
│  • mount → validate grant → invoke → close                      │
│  • MCP servers, Native tools, Skills, Browser/Computer/Data     │
│  (server/agent-runtime/capability-runtime.ts,                  │
│   native-*-capability-provider.ts, chat-capability-runtime.ts)  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Contracts (`server/agent-runtime/contracts.ts`)
- **ModelAdapter** — Provider-neutral generation interface
- **CapabilityProvider** — One lifecycle: mount → invoke → close
- **AgentEngine** — `run()`, `interrupt()`, `steer()`, event bus
- **AgentRunStore** — SQLite-backed run journal + compaction records

---

## What Works Today (Verified)

| Feature | Status | Evidence |
|---------|--------|----------|
| Native agent loop (`mausclaw-native`) | ✅ Working | 198 tests pass, lint/typecheck/locale clean |
| SQLite run journal + capability journal | ✅ Working | `server/agent-runtime/run-store.ts` |
| Natural cancellation & retry classification | ✅ Working | `server/drivers/retry.ts`, engine-errors.ts |
| Request-size recovery + summarization compaction | ✅ Working | `agent_compactions` table, `run.compacted` event |
| OpenAI-compatible / Grok / Groq / Meta / MiniMax / Mistral / Cerebras drivers | ✅ Working | All in `server/drivers/`, using shared engine |
| Tool-output shaping (oversized → capped in prompt, stored in `agent_tool_outputs`) | ✅ Working | Read via `tool_output_read` capability |
| Multimodal user images + tool-result images | ✅ Working | Gated by model capability |
| Isolated native-only acceptance fixture | ✅ Working | Loopback provider, real MCP tool, approval card |
| Background compaction precompute (OpenCode-style) | ✅ Working | `server/agent-runtime/capability-probe.ts` |
| **Legacy loop removal** | ✅ **Done** | Commit `e34ccfc06` |
| **Sandbox Boundary** | ✅ **Done** | Commit `f638333be` — 4 modes (workspace-write/read-only/full/custom), `sandbox.ts` in native-shell-tool.ts + turn-runtime.ts |
| Tool search (deferred MCP tool discovery) | ✅ Working | As `CapabilityProvider` |

### Layer 2 — In Progress / Remaining

| Feature | Status | Notes |
|---------|--------|-------|
| **Hooks completion** | 🟡 Partial | Wiring exists; block/modify tool call not fully applied |
| **Checkpoints rollback** | 🟡 Partial | `createCheckpoint` called; no `rollback()` + event yet |
| **Fallback Provider Chains** | 🔴 Not started | Spec exists, no implementation |
| **Live Capability Probe** | 🟡 Mock only | Mock test passes; needs real API key for live validation |

### Layer 3 (Orchestration) — 0% Implementation

| Area | Status | Notes |
|------|--------|-------|
| Multi-agent coordination | 🔴 Spec only | `docs/specs/` only |
| Task decomposition / planning | 🔴 Spec only | |
| Cross-thread / cross-bot orchestration | 🔴 Spec only | |
| Resource-aware scheduling | 🔴 Spec only | |

---

## Active Development: Layer 2 Completion → Layer 3 Design

### Current Branch: `feature/native-agent-engine`

**Completed (Layer 1):**
- Native agent engine — 198 tests passing
- Legacy loop removal — commit `e34ccfc06`
- Sandbox boundary — commit `f638333be`

**In Progress (Layer 2):**
1. **Hooks completion** — `server/agent-runtime/hooks.ts` wiring exists; need block/modify tool call enforcement
2. **Checkpoints rollback** — `createCheckpoint` called in turn-runtime; need `rollback()` + `run.checkpoint_rolled_back` event
3. **Fallback Provider Chains** — spec in `docs/specs/`; no implementation in `model-adapter.ts` / `runtime.ts`
4. **Live Capability Probe** — `server/agent-runtime/capability-probe.ts` has `probeLive()` mock test; needs real API key validation

**Layer 3 (Orchestration) — Design Phase Only**
- Specs in `docs/specs/` and `docs/superpowers/specs/`
- No implementation started
- **Discussion required before any code**

---

## Parallel Work Plan (From `/root/.opencode/plan/mausclaw-parallel-execution.md`)

### Agent A: Session Tree (`feature/session-tree`)
- `server/message-db.ts` — schema + fork/resume functions
- `server/routes/thread-*.ts` — new fork/resume endpoints
- `server/agent-runtime/session-tree.ts` — new module
- `server/agent-runtime/session-tree.test.ts` — new tests
- `docs/superpowers/specs/` — research/mapping docs

### Agent B: Legacy Loop Retirement (`feature/retire-legacy-loop`) — **CURRENT**
- `server/agent-runtime/native-turn-runtime.ts` — remove legacy loop block
- `server/drivers/openai-chat.test.ts` — migrate 40+ tests to native path
- `server/agent-runtime/runtime.ts` — only if needed for native path equivalence

### Contract Freeze (Both Agents)
- Do NOT rename/remove: `ModelCapabilities`, `CapabilitySession`, `CapabilityProvider`, `ProviderInstance`, `SendTurnInput`, `AgentRunRequest`, `AgentEngine`, `ModelAdapter`
- Only ADD new fields/types
- `BotRecord.toolScope`, `ThreadState` fields: additive only

---

## Infrastructure & Deployment

### Systemd Services
| Service | Status | Description |
|---------|--------|-------------|
| `mausclaw-test.service` | failed | Test service on port 8798, no-pair mode |
| `mausclaw-backup.service` + timer | configured | Encrypted workspace backup |
| `pango-portal.service` | active | Pango Hub auth (port 20200) |

### Nginx / TLS
- **Domain:** `maus.pango.fun` → proxies to `127.0.0.1:8799`
- **Cert:** Let's Encrypt via certbot
- **File Manager:** `files.pango.fun` → `127.0.0.1:20201` (Basic Auth + app auth)
- **9Router Gateway:** `https://files.pango.fun/v1` (OpenAI-compatible, `9router.key` in systemd credentials)

### Backups
- `/root/mausclaw-full-backup-20261026-165846.tar.gz` (1.1 GB) — full workspace backup
- `/root/openclaw_backup_20261023-131955.tar.gz` (193 MB) — earlier backup
- Backup script: `/root/.mausclaw/backup-now.sh` (run by `mausclaw-backup.service`)

---

## Development Environment

### Requirements
- Node.js 24+
- pnpm 10.33.0

### Key Commands
```bash
pnpm install          # Install dependencies
pnpm build            # TypeScript build (app + server + Vite)
pnpm dev:server       # Harness server → 127.0.0.1:8799
pnpm dev              # Vite app → http://127.0.0.1:5199
pnpm dev:desktop      # Electron shell (macOS/Ubuntu)
pnpm typecheck        # tsc -b + server tsconfig
pnpm test             # vitest run + broker:test + test:electron + test:packaged-server
pnpm lint             # oxlint --deny-warnings
```

### Test Structure
- **Unit** — registry, bus, store (fake driver in `server/testing/fake-driver.ts`)
- **Driver Contract** — `claude.test.ts`, `codex.test.ts` (scripted fake CLIs)
- **API Smoke** — `index.test.ts` (real server against throwaway home)
- **E2E** — Electron tests, CUA smoke, packaged server smoke

---

## Skills & Extensions

### Active Skills (from `/root/MausClaw/skills/`)
- `create-verification-skill` — generates verification skills
- `data-dashboards` — dashboard generation
- `phone-harness` — phone testing agents

### Verification Skill (`.claude/skills/verify-mausclaw/`)
Follows `docs/verification/README.md` — uses `pnpm control:mausclaw` with fake engine fixtures

### Documentation Structure
```
docs/
├── verification/           # 47 verification fixtures (chat-turns, openai-tools, etc.)
├── plans/                  # 16 implementation plans
├── specs/                  # 3 architecture specs
├── design/                 # 4 issue designs
├── requirements/           # 4 issue requirements
├── superpowers/            # Superpowers framework docs
│   ├── plans/              # 23 superpowers plans
│   └── specs/              # superpowers specs
└── screenshots/            # 67+ UI screenshots
```

---

## Known Gaps / Risks

| Area | Status | Notes |
|------|--------|-------|
| **Session Tree (fork/resume/branch)** | 🔴 Not started | Agent A work — Pi-style JSONL tree, parent pointers, branch summary |
| **Legacy Loop Full Removal** | 🟡 In progress | 40+ tests migrating; `native-turn-runtime.ts` stripped but shim remains |
| **External Engine Support** | ⚪ By design | Not supported in this fork — native-only |
| **Browser/Computer Use** | ✅ Working | CUA driver bundled, Playwright injected |
| **MCP Server Handshakes** | ✅ Working | 6 servers: codebase-memory, github, last30days, mem0, playwright, rea |
| **Skill Library (412 unique skills)** | ✅ Imported | 30-skill per-turn index cap |
| **Windows Packaging** | 🟡 Pending | `package:win` workflow exists, needs verification |
| **Linux .deb / AppImage** | 🟡 Pending | `package:linux` workflow, Ubuntu 24.04 runner |

---

## Git Status Detail

```bash
# On branch feature/native-agent-engine
# Changes not staged for commit:
 M server/agent-runtime/driver-opt-in.test.ts
 M server/agent-runtime/model-adapter.ts
 M server/agent-runtime/native-turn-runtime.ts
 M server/agent-runtime/runtime.ts
 M server/drivers/anthropic.ts
 M server/drivers/cerebras.ts
 M server/drivers/gemini.ts
 M server/drivers/grok.ts
 M server/drivers/meta.ts
 M server/drivers/minimax.ts
 M server/drivers/mistral.ts
 M server/drivers/native-engine.ts
 M server/drivers/openai-chat.test.ts
 M server/drivers/openai-compat.ts
 M server/drivers/openai-responses.ts
```

---

## Next Steps

### Layer 2 Completion — All Complete ✅
| Item | Commit | Status |
|------|--------|--------|
| Hooks block/modify (`pre_tool_use` allow/modifyArguments) | `511cc78eb` | Done |
| Checkpoints rollback (`rollback()` + `run.checkpoint_rolled_back`) | `511cc78eb` + `a970847dc` | Done |
| Fallback Provider Chains (terminal error → next provider) | `50413d6ad` | Done |
| Live Capability Probe (`probeLive()` wired to engine) | `6d8da6380` | Done |

### Layer 3 (Orchestration) — Option A Confirmed & Implemented ✅
**Decision:** Orchestration layer sits **above** the Agent Engine (`Orchestrator.runPlan()` calls `AgentEngine.run()` per step). Design doc: `docs/superpowers/specs/2026-10-28-layer-3-orchestrator-option-a-design.md`.

**Implemented** (commit `6b4e2b746`):
- `contracts.ts`: additive Layer 3 types (PlanStep, PlanResult, OrchestratorContext, OrchestratorStore, OrchestrationEvent, Orchestrator) — contract freeze respected
- `orchestrator.ts`: `createOrchestrator()` with sequential `runPlan()`, plan + step-level approval gates, context variable carry, step failure stop, DAG dependency stub, `OrchestrationEvent` stream
- `orchestrator-store.ts`: SQLite store wrapper following `run-store.ts` pattern
- `message-db.ts`: `agent_orchestrator_plans` / `agent_orchestrator_steps` tables + CRUD + `recoverUnsettledOrchestratorPlans`
- `orchestrator.test.ts`: 9 tests passing
- Verification: 146 tests pass, typecheck clean, lint clean

### Agent A Coordination (Session Tree)
1. Create `feature/session-tree` branch from `main` at `927343a3e`
2. Implement DB schema changes in `message-db.ts` (nullable columns for fork/resume)
3. Add fork/resume endpoints in `server/routes/thread-*.ts`
4. Build `session-tree.ts` module with Pi-style JSONL tree logic

### Integration
1. Merge Agent A first (touches DB)
2. Agent B rebases on updated main
3. Full integration test: `pnpm typecheck && pnpm lint && vitest run server/`
4. Verify `native-only.e2e` + `openai-tools.e2e` + sealed PATH test pass

---

## Related Projects (Same Server)

| Project | Path | Status |
|---------|------|--------|
| **MausClaw (upstream install)** | `/root/MausClaw-install/` | Deployed at `maus.pango.fun`, gates G1-G9 passing |
| **Pango Portal** | `/root/pango-portal/` | Active auth service on 20200 |
| **9Router Gateway** | `/root/.9router/` | Model gateway at `files.pango.fun/v1` |
| **Hermes Agent (LUNA)** | `/usr/local/lib/hermes-agent/` | Runtime for this conversation |
| **Agent-Reach** | `/root/.agent-reach/` | Multi-platform research skill |

---

## Quick Reference: Key Files

| File | Purpose |
|------|---------|
| `server/contracts.ts` | Driver SPI + canonical runtime events |
| `server/agent-runtime/contracts.ts` | Native engine contracts (ModelAdapter, AgentEngine, CapabilityProvider) |
| `server/agent-runtime/runtime.ts` | Native loop entry point |
| `server/agent-runtime/turn-runtime.ts` | Core turn execution logic |
| `server/agent-runtime/native-turn-runtime.ts` | Driver-facing native runtime (legacy removed) |
| `server/agent-runtime/model-adapter.ts` | Provider adapter registry |
| `server/agent-runtime/capability-runtime.ts` | Capability mount/invoke/close |
| `server/drivers/builtIn.ts` | Driver registration |
| `server/index.ts` | HTTP + SSE API |
| `server/message-db.ts` | SQLite schema (threads, messages, runs) |
| `server/agent-runtime/run-store.ts` | Run journal + compaction store |

---

*This document reflects the state as of commit `6b4e2b746` on branch `feature/native-agent-engine`. Update after each major merge.*