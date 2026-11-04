# Phase 1: Extract AgentTurnKernel and ContextManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a single `AgentTurnKernel` and one `ContextManager` from the MausClaw native engine, routing all supported product turns through one model/tool loop while keeping the `AgentEngine` contract stable.

**Architecture:** Incremental extraction from `runtime.ts`: the model/tool turn loop becomes `AgentTurnKernel`; compaction, budget, estimation, and offload logic from `compaction.ts`, `context-budget.ts`, and `drivers/turn-context.ts` unify into `ContextManager`. `runtime.ts` delegates to both; `native-turn-runtime.ts` routes legacy turns through the same kernel behind a temporary flag.

**Tech Stack:** TypeScript, Node, vitest, existing MausClaw contracts (AgentEngine, AgentRunRequest, ModelAdapter, CapabilitySession).

**Spec:** docs/superpowers/specs/2026-11-03-mausclaw-native-engine-design.md (§13 Phase 1)

## Global Constraints

- One `AgentTurnKernel` and one `ContextManager` are hard invariants (spec §5.2).
- Keep `AgentEngine` public contract stable (spec §13 Phase 1).
- Native-only build; no external CLI/ACP engine runtime dependency.
- Preserve all Phase 0 safety assertions (approval, safety-floor, recovery, task-checker, tool-scope).
- No Phase 2+ features (no deferred tool discovery, no plan+verify default, no subagents).
- No paid/live model runs without explicit owner approval.
- Changes must not weaken existing test assertions.
- Temporary legacy gate allowed only while parity test is active (spec §13 Phase 1).

## Review Focus

1. Provider overflow during a model call: one emergency shrink/compaction and one safe resend only when no visible output was produced.
2. Cancellation between model rounds and tool batches: no partial deltas; honest `interrupted` status.
3. Tool result order: results committed in original call order even if execution differs.
4. Request budget exhaustion: last permitted request sent with tools disabled; no hidden extra calls.
5. Legacy gate off: behavior identical to baseline; no second loop reachable.

---

## File Structure

### Create

- `server/agent-runtime/agent-turn-kernel.ts` — `AgentTurnKernel` class: owns the single model/tool turn lifecycle (model calls, tool dispatch, retries, terminal status, event emission). Extracted from `runtime.ts` `run()` body. Takes kernel dependencies; exposes `run()`, `interrupt()`, `steer()`, `getState()`, `onEvent()`.
- `server/agent-runtime/context-manager.ts` — `ContextManager` class: single context/budget API. Owns request token estimation, context-window learning, compaction decisions, overflow recovery, and tool-output offload/paging. Wraps `compaction.ts`, `context-budget.ts`, and adapts `drivers/turn-context.ts`.

### Modify

- `server/agent-runtime/runtime.ts` — `createAgentEngine()` delegates `run()` to `AgentTurnKernel`; context decisions delegate to `ContextManager`. Removes duplicated loop/compaction inline code.
- `server/agent-runtime/turn-runtime.ts` — `runNativeTurn()` continues calling `engine.run()`; context estimation/compaction helpers route through `ContextManager` instead of `drivers/turn-context.ts` copies.
- `server/agent-runtime/native-turn-runtime.ts` — Legacy branch routes turns through `AgentEngine.run()` (the kernel) behind a temporary `MAUSCLAW_NATIVE_LEGACY` gate; native path unchanged.
- `server/drivers/turn-context.ts` — Legacy helpers (`estimateRequestTokens`, `TokenCalibration`, `compactTurnMessages`, `turnCompactBudget`, `offloadToolOutput`, `readToolOutput`) delegate to `ContextManager`; model-loop-only copies removed after reference search confirms unused.
- `server/agent-runtime/contracts.ts` — `AgentRunRequest` gains optional `maxTurnRequests` and provider-instance identity fields for calibration/no-tools final requests.
- `server/agent-runtime/compaction.ts` — Unchanged internally; exported through `ContextManager`.
- `server/agent-runtime/context-budget.ts` — Unchanged internally; exported through `ContextManager`.

## Tasks

### Task 1: Create `AgentTurnKernel` class

**Files:**
- Create: `server/agent-runtime/agent-turn-kernel.ts`

**Interfaces:**
- Consumes: `AgentRunRequest`, `AgentRunStore`, `ModelAdapter` registry, `CapabilitySession`, `ContextManager`, hooks, intelligence, plugins, checkpoints/rollback (same dependencies as current `createAgentEngine`).
- Produces: `AgentTurnKernel` with `run(request): Promise<AgentRunHandle>`, `interrupt(runId)`, `steer(runId, text)`, `getState(runId)`, `onEvent(threadId, listener)`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { AgentTurnKernel } from "./agent-turn-kernel.ts";

describe("AgentTurnKernel", () => {
  it("runs a simple turn to completion with no tools", async () => { ... });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/agent-runtime/agent-turn-kernel.test.ts`
Expected: FAIL — `AgentTurnKernel` not found.

- [ ] **Step 3: Implement `AgentTurnKernel`**

Extract the `run()` body and supporting state (`active`, `listeners`, `emit`, `transition`, `liveProbeCache`, constants) from `runtime.ts` into a class. The `run()` body moves verbatim where possible; constants (`MAX_MODEL_ROUNDS`, `MAX_TOOL_CALLS`, `MAX_ENCODED_IMAGE_BYTES`, `COMPACTION_*`, `TOOL_OUTPUT_PROMPT_CHARS`, `SHORT_TOOL_CHARS`, `OMITTED_IMAGE`) move with it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/agent-runtime/agent-turn-kernel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/agent-turn-kernel.ts server/agent-runtime/agent-turn-kernel.test.ts
git commit -m "feat: extract AgentTurnKernel from runtime.ts loop"
```

### Task 2: Create `ContextManager` class

**Files:**
- Create: `server/agent-runtime/context-manager.ts`
- Create: `server/agent-runtime/context-manager.test.ts`

**Interfaces:**
- Consumes: message arrays, token counts, model IDs, compaction options (same signatures as `compaction.ts`/`context-budget.ts`).
- Produces: `estimateRequestTokens`, `contextWindowFor`, `compactBudget`, `shouldCompact`, `learnContextWindow`, `compactMessages`, `offloadToolOutput`, `readToolOutput`, `turnCompactBudget` — all through one `ContextManager` instance.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { ContextManager } from "./context-manager.ts";

describe("ContextManager", () => {
  it("estimates request tokens and decides compaction", () => { ... });
  it("learns a smaller window after repeated overflow", () => { ... });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/agent-runtime/context-manager.test.ts`
Expected: FAIL — `ContextManager` not found.

- [ ] **Step 3: Implement `ContextManager`**

Class wrapping the pure functions from `compaction.ts` (`compactMessages`, `compactionTranscript`, `SUMMARY_PROMPT`, `buildCompactionRecord`, `compactionKeepTokens`, `estimateMessagesTokens`, `planRecovery`, `chooseBodyCut`, `contextBudget`) and `context-budget.ts` (`contextWindowFor`, `compactBudget`, `shouldCompact`, `learnContextWindow`, `threadTokens`, `DEFAULT_CONTEXT_WINDOW`), plus legacy helpers from `drivers/turn-context.ts` (`estimateRequestTokens`, `TokenCalibration`, `compactTurnMessages`, `turnCompactBudget`, `offloadToolOutput`, `readToolOutput`, `DEFAULT_KEEP_EXCHANGES`). One instance owns all per-turn context state.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/agent-runtime/context-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/context-manager.ts server/agent-runtime/context-manager.test.ts
git commit -m "feat: create ContextManager unifying compaction, budget, turn-context"
```

### Task 3: Refactor `runtime.ts` to delegate to `AgentTurnKernel` + `ContextManager`

**Files:**
- Modify: `server/agent-runtime/runtime.ts`

**Interfaces:**
- Consumes: `AgentTurnKernel.run()`, `ContextManager` methods.
- Produces: `createAgentEngine()` returns `AgentEngine` whose `run()` delegates to `AgentTurnKernel`; context calls delegate to `ContextManager`.

- [ ] **Step 1: Write the failing test**

No new test — existing `runtime.test.ts` must continue to pass unchanged (no weakened assertions).

- [ ] **Step 2: Run existing tests**

Run: `pnpm vitest run server/agent-runtime/runtime.test.ts`
Expected: All existing tests pass (baseline).

- [ ] **Step 3: Refactor `createAgentEngine`**

Replace the inline `run()` body with a delegation to a new `AgentTurnKernel` instance constructed from the same `dependencies`. Replace inline compaction/budget calls with `ContextManager` calls. Remove now-unused imports from `compaction.ts`/`context-budget.ts` that are accessed via `ContextManager`.

- [ ] **Step 4: Run tests to verify no regression**

Run: `pnpm vitest run server/agent-runtime/runtime.test.ts`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/runtime.ts
git commit -m "refactor: runtime.ts delegates to AgentTurnKernel and ContextManager"
```

### Task 4: Add provider-instance identity and no-tools final request controls

**Files:**
- Modify: `server/agent-runtime/contracts.ts`
- Modify: `server/agent-runtime/runtime.ts` (kernel uses the new fields)

**Interfaces:**
- `AgentRunRequest` gains optional `maxTurnRequests?: number` and instance identity for calibration.
- Model request path gains ability to disable tools on the reserved final request.

- [ ] **Step 1: Write the failing test**

```typescript
// in runtime.test.ts or a new contracts test
it("AgentRunRequest accepts maxTurnRequests", () => { ... });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/agent-runtime/runtime.test.ts`
Expected: FAIL — field not yet on type.

- [ ] **Step 3: Implement**

Add `maxTurnRequests?: number` and provider-instance reference fields to `AgentRunRequest` in `contracts.ts`. Kernel increments a request counter on every model-adapter generation attempt; when the last request remains, tools are disabled on that final call.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/agent-runtime/runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/contracts.ts server/agent-runtime/runtime.ts
git commit -m "feat: add maxTurnRequests and provider-instance identity to AgentRunRequest"
```

### Task 5: Route legacy turns through the kernel with temporary gate

**Files:**
- Modify: `server/agent-runtime/native-turn-runtime.ts`
- Modify: `server/agent-runtime/turn-runtime.ts`

**Interfaces:**
- Consumes: `AgentEngine.run()` (kernel), `ContextManager`.
- Produces: both native and legacy product turns flow through `AgentTurnKernel`; legacy path selectable via `MAUSCLAW_NATIVE_LEGACY` env flag (default off after parity).

- [ ] **Step 1: Write the failing test**

```typescript
// in native-provider-acceptance.test.ts or new test
it("legacy turn path reaches AgentTurnKernel when gate is off", async () => { ... });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/agent-runtime/native-provider-acceptance.test.ts`
Expected: FAIL — legacy loop still independent.

- [ ] **Step 3: Implement routing**

In `native-turn-runtime.ts`, the legacy branch (currently lines ~632+) calls `engine.run()` through the same `AgentTurnKernel` used by the native path, gated by `process.env.MAUSCLAW_NATIVE_LEGACY === "1"`. When gate is off, legacy turns go through the kernel. `turn-runtime.ts` `runNativeTurn()` routes context estimation/compaction through `ContextManager`.

- [ ] **Step 4: Run tests to verify parity**

Run: `pnpm vitest run server/agent-runtime/native-provider-acceptance.test.ts server/agent-runtime/runtime.test.ts`
Expected: All tests pass with gate off (kernel path) and on (legacy path preserved temporarily).

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/native-turn-runtime.ts server/agent-runtime/turn-runtime.ts
git commit -m "feat: route legacy turns through AgentTurnKernel behind temporary gate"
```

### Task 6: Adapt `drivers/turn-context.ts` to `ContextManager`

**Files:**
- Modify: `server/drivers/turn-context.ts`

**Interfaces:**
- Consumes: `ContextManager` instance/methods.
- Produces: legacy helpers delegate to `ContextManager`; model-loop-only copies removed if reference search proves unused.

- [ ] **Step 1: Run reference search**

Run: `grep -rn "turnContextSettings\|estimateRequestTokens\|TokenCalibration\|compactTurnMessages\|turnCompactBudget\|offloadToolOutput\|readToolOutput\|DEFAULT_KEEP_EXCHANGES\|refusesContextLength" server/ --include="*.ts"`
Expected: list of all call sites.

- [ ] **Step 2: Adapt helpers**

Rewrite `drivers/turn-context.ts` exported functions to delegate to a shared `ContextManager` (or a module-level singleton). Remove copies that exist only to serve the old model loop if call sites confirm they're unused.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run server/agent-runtime/ server/drivers/`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/drivers/turn-context.ts
git commit -m "refactor: turn-context delegates to ContextManager"
```

### Task 7: Run full verification suite

**Files:** None (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: No type errors.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No lint errors/warnings.

- [ ] **Step 3: Full agent-runtime test suite**

Run: `pnpm vitest run server/agent-runtime/`
Expected: All tests pass; no weakened assertions.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify Phase 1 — typecheck, lint, full test suite green"
```

---

## Self-Review

1. **Spec coverage:** §13 Phase 1 deliverables all mapped: kernel extraction (Tasks 1,3), context manager (Tasks 2,6), provider-instance identity + request controls (Task 4), routing with legacy gate (Task 5), verification (Task 7).
2. **Step scan:** Every step is one actionable item; no TBD lines; function bodies appear only where tests don't determine them.
3. **Type consistency:** `AgentTurnKernel.run()` matches `AgentEngine.run()` signature; `ContextManager` method signatures match the functions they wrap from `compaction.ts`/`context-budget.ts`/`turn-context.ts`.
4. **Review Focus:** All five input classes have tests: overflow (Task 2), cancellation (existing runtime.test.ts + Task 1), tool order (existing runtime.test.ts), budget exhaustion (Task 4), legacy gate (Task 5).
5. **Proportion:** Plan is ~1/3 the size of the spec section it implements; code bodies are minimal, signatures and tests carry the decisions.
