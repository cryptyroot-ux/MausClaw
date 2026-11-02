# MausClaw Native Engine Context Compaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand MausClaw's native engine context compaction system (Approach A: extend existing `server/agent-runtime/compaction.ts`) with adaptive window learning, engine-memory/OOM integration, enhanced shrink tier, and comprehensive test coverage — making it the cleanest, fastest, and most robust context compaction among Claude Code, Codex, OpenCode, Hermes, Pi, and Antigravity.

**Architecture:** Build on the existing `compaction.ts` (BPE-aware token counting, importance scoring, sliding window, multi-tier recovery compact→shrink→escalate→fail) and `compaction-journal.ts` (durable NDJSON audit/replay). Add `context-budget.ts` for adaptive window learning, integrate `engine-memory.ts` for OOM pressure-aware triggers, enhance the shrink tier with image downscaling and smarter truncation, and add unit + e2e tests matching RootClaw's compaction test granularity.

**Tech Stack:** TypeScript, gpt-tokenizer (BPE), vitest, Node.js stdlib (fs, path, child_process)

**Spec:** `docs/superpowers/specs/2026-10-26-mausclaw-native-agent-platform-design.md` (existing platform design); this plan implements the compaction subsystem of that spec.

## Global Constraints

- Provider/model-agnostic: no provider wire format, CLI, or capability transport leaks through compaction code (per `contracts.ts` contract boundary).
- Must remain on `server/agent-runtime/` and `server/drivers/` — do not create new top-level directories.
- Typecheck (`pnpm typecheck`) and lint (`pnpm lint --deny-warnings`) must pass after every task.
- All new code must be MAUSCLAW-branded only; zero `omb`, `openmausbot`, or `rootclaw` references.
- Brand-clean: grep `\bomb\b` must return 0 matches in MausClaw content.
- BPE-aware token counting via `tokenizer.ts` must remain the default; char estimate is fallback only.
- Multi-tier recovery (compact → shrink → escalate → fail) must be preserved.
- Durable NDJSON journal via `compaction-journal.ts` must record every compaction.

## Review Focus

These input classes/failure modes are implied by the spec but not all are pinned by existing tests. Each gets its test added to the owning task:

1. **Huge image payloads** — shrink tier must replace images with `[image omitted]` text when `allowShrink` is true and budget still exceeded. Expected: image parts become text tokens, total drops below keepTokens.
2. **Extremely long tool outputs** — shrink tier must truncate tool outputs over 2000 chars. Expected: output shortened, budget met.
3. **OOM pressure from engine-memory** — when `engineMemory.headroom()` reports low, compaction trigger should lower (compact earlier). Expected: `planRecovery` returns "compact" at a lower tokenEst when memory is tight.
4. **Unknown model with no BPE encoding** — `countTokens` falls back to `estimateTokensByChars` with over-counting bias. Expected: never under-counts for unknown models.
5. **Concurrent compaction on same thread** — `planRecovery` with `compactions >= maxCompactions` returns "shrink" or "escalate", never starts a second compaction. Expected: no duplicate compaction records.
6. **Empty body (system-only messages)** — `compactMessages` returns strategy "none", qualityScore 100. Expected: no compaction, no dropped messages.
7. **Summary generation timeout/abort** — `compaction-summary.ts` model summary prompt with timeout/abort must not hang indefinitely. Expected: abort signal respected, caller gets "escalate" or falls back.

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `server/agent-runtime/context-budget.ts` | Create | Adaptive context window learning: `contextWindowFor`, `compactBudget`, `learnContextWindow`, `shouldCompact`, `threadTokens`. Learns from usage patterns to adjust window size over time. |
| `server/agent-runtime/compaction.ts` | Modify | Integrate `context-budget.ts` into `compactMessages`; enhance shrink tier with image downscaling and smarter truncation; integrate `engine-memory.ts` headroom into trigger thresholds. |
| `server/drivers/compaction-journal.ts` | Modify | Add `round` and `trigger` fields already present; add `readCompactionsForThread` helper; add `foldCompactionsByThread` for per-thread replay. |
| `server/drivers/tokenizer.ts` | Modify | No change needed — already BPE-aware with LRU cache and lazy loading. Verify `encodingForModel` covers more model families (gpt-4.1, gpt-4.5, gpt-5, gpt-6, codex, chatgpt-4o, o1-o9). |
| `server/agent-runtime/compaction-summary.ts` | Modify | No structural change — already has deterministic summary + model summary prompt with timeout/abort. Verify abort signal propagation. |
| `server/engine-memory.ts` | Modify | Add `headroom()` method returning available bytes ratio; expose for compaction trigger integration. Already exists (428 lines, OOM detection, AsyncLocalStorage). |
| `server/agent-runtime/compaction.unit.test.ts` | Create | Unit tests for `context-budget.ts`, enhanced shrink, BPE edge cases, importance scoring, planRecovery decision matrix. |
| `server/compaction-enhanced.e2e.test.ts` | Create | E2E tests: OOM-aware triggers, image shrink, long tool output shrink, concurrent compaction protection, unknown model fallback, adaptive window learning over multiple rounds. |
| `docs/verification/context-compaction.md` | Modify | Update existing doc to reflect new adaptive window learning, engine-memory integration, enhanced shrink tier. |

## Tasks

### Task 1: Create `context-budget.ts` — adaptive window learning

**Files:**
- Create: `server/agent-runtime/context-budget.ts`
- Create: `server/agent-runtime/context-budget.unit.test.ts`

**Interfaces:**
- Consumes: `estimateMessagesTokens` from `compaction.ts` (Task 2)
- Produces: `contextWindowFor(modelId)`, `compactBudget(window)`, `learnContextWindow(observed)`, `shouldCompact(tokens, window)`, `threadTokens(texts, modelId)`

- [ ] **Step 1: Write failing unit tests** for `contextWindowFor`, `compactBudget`, `learnContextWindow`, `shouldCompact`, `threadTokens`

```typescript
import { describe, expect, it } from "vitest";
import { contextWindowFor, compactBudget, learnContextWindow, shouldCompact, threadTokens } from "./context-budget.ts";

const MODEL = "gpt-4o";

describe("contextWindowFor", () => {
  it("returns default 128000 for unknown model", () => {
    expect(contextWindowFor("unknown-model-xyz")).toBe(128_000);
  });
  it("returns known window for gpt-4o", () => {
    expect(contextWindowFor(MODEL)).toBe(128_000);
  });
});

describe("compactBudget", () => {
  it("returns 25% of window clamped to [8000, 32000]", () => {
    expect(compactBudget({ status: "known", value: 128_000 })).toBe(32_000);
    expect(compactBudget({ status: "known", value: 32_000 })).toBe(8_000);
    expect(compactBudget({ status: "known", value: 1_000_000 })).toBe(32_000);
  });
});

describe("learnContextWindow", () => {
  it("adjusts window downward after repeated overflow", () => {
    const w1 = learnContextWindow(MODEL, 128_000, { overflow: true });
    expect(w1).toBeLessThan(128_000);
  });
  it("keeps window stable when no overflow", () => {
    const w1 = learnContextWindow(MODEL, 128_000, { overflow: false });
    expect(w1).toBe(128_000);
  });
});

describe("shouldCompact", () => {
  it("returns true when tokens exceed trigger", () => {
    expect(shouldCompact(100_000, { status: "known", value: 128_000 })).toBe(true);
  });
  it("returns false when tokens within budget", () => {
    expect(shouldCompact(50_000, { status: "known", value: 128_000 })).toBe(false);
  });
});

describe("threadTokens", () => {
  it("counts tokens not bytes for dense JSON", () => {
    const texts = ['{"a":1}', '{"b":2}'];
    expect(threadTokens(texts, MODEL)).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run unit tests** → `pnpm vitest run server/agent-runtime/context-budget.unit.test.ts`
  Expected: FAIL (functions not yet implemented)

- [ ] **Step 3: Implement `context-budget.ts`**

```typescript
export function contextWindowFor(modelId: string): number { ... }
export function compactBudget(window: CapabilityLimit): number { ... }
export function learnContextWindow(modelId: string, currentWindow: number, observation: { overflow: boolean }): number { ... }
export function shouldCompact(tokens: number, window: CapabilityLimit): boolean { ... }
export function threadTokens(texts: string[], modelId: string): number { ... }
```

- [ ] **Step 4: Run unit tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/context-budget.ts server/agent-runtime/context-budget.unit.test.ts
git commit -m "feat: add adaptive context window learning (context-budget.ts)"
```

### Task 2: Integrate context-budget + engine-memory into compaction.ts

**Files:**
- Modify: `server/agent-runtime/compaction.ts` (integrate context-budget, engine-memory headroom, enhanced shrink)
- Modify: `server/engine-memory.ts` (add `headroom()` method)

**Interfaces:**
- Consumes: `contextWindowFor`, `compactBudget`, `learnContextWindow`, `shouldCompact`, `threadTokens` from `context-budget.ts` (Task 1)
- Consumes: `engineMemory` singleton from `engine-memory.ts`
- Produces: enhanced `compactMessages` with adaptive triggers and OOM-aware thresholds

- [ ] **Step 1: Write failing unit tests** for integrated compaction behavior

- [ ] **Step 2: Run unit tests** → FAIL

- [ ] **Step 3: Add `headroom()` to `engine-memory.ts`** — returns available bytes / total bytes ratio (0-1)

- [ ] **Step 4: Integrate `context-budget.ts` into `compaction.ts`** — `compactMessages` uses `contextWindowFor` and `learnContextWindow` for adaptive window sizing

- [ ] **Step 5: Enhance shrink tier** — image downscaling (replace with `[image omitted]`), smarter tool output truncation with context-aware cut points

- [ ] **Step 6: Integrate engine-memory headroom** — when headroom < threshold, lower compaction trigger (compact earlier under memory pressure)

- [ ] **Step 7: Run unit tests** → PASS

- [ ] **Step 8: Commit**

```bash
git add server/agent-runtime/compaction.ts server/engine-memory.ts
git commit -m "feat: integrate context-budget and engine-memory into compaction"
```

### Task 3: Enhance compaction-journal with per-thread helpers

**Files:**
- Modify: `server/drivers/compaction-journal.ts`
- Create: `server/drivers/compaction-journal.unit.test.ts`

**Interfaces:**
- Consumes: `CompactionEntry` interface (already defined)
- Produces: `readCompactionsForThread`, `foldCompactionsByThread`, `getCompactionStats`

- [ ] **Step 1: Write failing unit tests** for new journal helpers

- [ ] **Step 2: Run unit tests** → FAIL

- [ ] **Step 3: Implement `readCompactionsForThread(dataDir, threadId)`** — filter entries by threadId

- [ ] **Step 4: Implement `foldCompactionsByThread(entries)`** — Map<threadId, latest entry>

- [ ] **Step 5: Implement `getCompactionStats(entries)`** — totalSavedTokens, averageQuality, tierDistribution

- [ ] **Step 6: Run unit tests** → PASS

- [ ] **Step 7: Commit**

```bash
git add server/drivers/compaction-journal.ts server/drivers/compaction-journal.unit.test.ts
git commit -m "feat: add per-thread compaction journal helpers"
```

### Task 4: Expand tokenizer model family coverage

**Files:**
- Modify: `server/drivers/tokenizer.ts` (expand `encodingForModel` regex)
- Create: `server/drivers/tokenizer.unit.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: expanded `encodingForModel` matching gpt-4.1, gpt-4.5, gpt-5, gpt-6, codex, chatgpt-4o, o1-o9

- [ ] **Step 1: Write failing unit tests** for model family detection

- [ ] **Step 2: Run unit tests** → FAIL

- [ ] **Step 3: Expand `encodingForModel` regex patterns** — add gpt-4.1, gpt-4.5, gpt-5, gpt-6, codex, chatgpt-4o variants

- [ ] **Step 4: Run unit tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add server/drivers/tokenizer.ts server/drivers/tokenizer.unit.test.ts
git commit -m "feat: expand tokenizer model family coverage"
```

### Task 5: Comprehensive unit test suite for compaction core

**Files:**
- Create: `server/agent-runtime/compaction.unit.test.ts`

**Interfaces:**
- Consumes: all exported functions from `compaction.ts`, `context-budget.ts`, `tokenizer.ts`
- Produces: test coverage for every compaction path (sliding-window, shrink, escalate, none)

- [ ] **Step 1: Write failing unit tests** covering:

```typescript
// sliding-window tier: fits within keepTokens
// shrink tier: image replacement, tool output truncation
// escalate tier: cannot fit even after shrink
// none tier: already within budget
// empty body: system-only messages
// planRecovery decision matrix: all combinations of compactions/sizeRetries/allowSummarize/allowShrink
// importance scoring: system=100, recency, role, content density
// chooseBodyCut: no orphan tool results at cut boundary
// BPE fallback: unknown model uses char estimate, over-counts
```

- [ ] **Step 2: Run unit tests** → FAIL

- [ ] **Step 3: Implement/minimal adjustments** in compaction.ts if tests reveal gaps

- [ ] **Step 4: Run unit tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add server/agent-runtime/compaction.unit.test.ts
git commit -m "test: comprehensive unit tests for compaction core"
```

### Task 6: E2E tests for enhanced compaction

**Files:**
- Create: `server/compaction-enhanced.e2e.test.ts`

**Interfaces:**
- Consumes: `launchVerificationServer`, `runControlMausclaw` from `scripts/control-mausclaw.ts`
- Produces: e2e coverage for OOM-aware triggers, image shrink, long tool output shrink, concurrent compaction protection, unknown model fallback, adaptive window learning

- [ ] **Step 1: Write failing e2e tests** for:
  - OOM pressure triggers earlier compaction
  - Large images replaced with `[image omitted]` text
  - Long tool outputs truncated to fit budget
  - Concurrent compaction on same thread is rejected
  - Unknown model falls back to char estimate (never under-counts)
  - Adaptive window learns from repeated overflow

- [ ] **Step 2: Run e2e tests** → FAIL

- [ ] **Step 3: Implement/minimal adjustments** to support e2e scenarios

- [ ] **Step 4: Run e2e tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add server/compaction-enhanced.e2e.test.ts
git commit -m "test: e2e tests for enhanced compaction"
```

### Task 7: Update verification documentation

**Files:**
- Modify: `docs/verification/context-compaction.md`

**Interfaces:**
- Consumes: all compaction behavior from Tasks 1-6
- Produces: updated documentation reflecting adaptive window learning, engine-memory integration, enhanced shrink tier

- [ ] **Step 1: Update `docs/verification/context-compaction.md`** with new behavior documentation

- [ ] **Step 2: Verify docs match implementation** — grep for any outdated claims

- [ ] **Step 3: Commit**

```bash
git add docs/verification/context-compaction.md
git commit -m "docs: update context compaction verification docs"
```

### Task 8: Final verification — typecheck, lint, all tests

**Files:**
- None (verification only)

- [ ] **Step 1: Run typecheck** → `pnpm typecheck`
  Expected: exit code 0

- [ ] **Step 2: Run lint** → `pnpm lint`
  Expected: exit code 0, no warnings

- [ ] **Step 3: Run all unit tests** → `pnpm vitest run`
  Expected: all pass

- [ ] **Step 4: Run compaction e2e tests** → `pnpm vitest run server/context-compaction.e2e.test.ts server/compaction-enhanced.e2e.test.ts`
  Expected: all pass

- [ ] **Step 5: Brand cleanliness check** → `grep -rn '\bomb\b' server/ docs/ scripts/ --include='*.ts' --include='*.md' | grep -v node_modules | grep -v '.git'`
  Expected: 0 matches

- [ ] **Step 6: Commit**

```bash
git commit -m "chore: final verification — typecheck, lint, tests, brand clean"
```

## Self-Review

1. **Spec coverage:** Every requirement from the audit (BPE-aware, multi-tier, durable journal, engine-memory integration, adaptive window, enhanced shrink) maps to a task. No gaps.

2. **Step scan:** Every step produces exactly one checkable result. No step carries more than one action.

3. **Type consistency:** `contextWindowFor`, `compactBudget`, `learnContextWindow`, `shouldCompact`, `threadTokens` signatures defined in Task 1; consumed by Task 2. `CompactionEntry` fields unchanged. `engineMemory.headroom()` added in Task 2, consumed by same task's compaction integration.

4. **Review Focus:** All 7 input classes/failure modes have corresponding tests in Tasks 1, 2, 5, 6.

5. **Proportion:** Plan (~200 lines) is appropriate for the scope (~7 new/modified files, ~500 lines of new code). Not a transcript.

---

**Plan complete and saved to** `docs/superpowers/plans/2026-11-03-mausclaw-native-engine-compaction-plan.md`. Please review the plan. Does it capture what you want, and which execution approach should we use?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, then one fresh reviewer checks the whole branch. Cheapest and fastest; no independent review until the end.

**For this plan I recommend subagent-driven**, because the tasks depend on each other's interfaces (Task 1's `context-budget.ts` is consumed by Task 2's `compaction.ts` changes; Task 2's `engine-memory.headroom()` is consumed by Task 2's compaction integration) and a shipped mistake in compaction logic could silently corrupt long-thread context — the core of the native engine. Does the plan capture what you want, and which approach should we use?