# MausClaw Native Engine Perfection Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 8 native engine improvements from MausClaw-Pivot to MausClaw, making MausClaw's native engine superior while maintaining 100% native (no external engines).

**Architecture:** MausClaw's native engine (`createNativeChatEngine`) currently uses a single adapter, hardcoded `enabled: true`, heuristic verifier only, and no task-based routing. Pivot's native engine has per-model adapter resolution with fallback cache, task-based model routing (6 task types), BudgetGuard per-run, LLM verifier with SuccessCriteria, feature flag gate, and more. We port these improvements one by one.

**Tech Stack:** TypeScript, Node.js 24, pnpm, Vitest

**Spec:** Based on byte-by-byte diff of `/tmp/MausClaw-Pivot/server/drivers/native-engine.ts` vs `/root/MausClaw/server/drivers/native-engine.ts`

## Global Constraints

- Version: 0.2.0, Node >=24, pnpm 10.33.0
- All changes must pass `pnpm typecheck` and `pnpm lint`
- All changes must not break existing tests
- Follow existing code patterns in MausClaw
- Only ADD new fields/types (contract freeze)
- Do NOT re-introduce external engine drivers

## Review Focus

1. **Adapter resolution must not break existing single-model flows** — the new `getAdapterForModel` must return the same adapter for the default model
2. **Feature flag must default to enabled** — MausClaw should keep intelligence on by default (unlike Pivot which defaults off)
3. **LLM verifier must fall back to heuristic** — if model caller fails, must not crash
4. **BudgetGuard must not block on errors** — guard errors should be non-fatal
5. **Orchestrator verify signature change** — must not break callers that pass only output

---

### Task 1: Per-Model Adapter Resolution with Fallback Cache

**Files:**
- Modify: `server/drivers/native-engine.ts`

**Interfaces:**
- Consumes: `createOpenAICompatibleModelAdapter`, `probeCapabilities`, `ModelAdapter`, `ProviderModelRef`
- Produces: `getAdapterForModel(modelId: string): ModelAdapter`, `fallbackAdapterCache: Map<string, ModelAdapter>`

- [ ] **Step 1: Add `baseAdapter` variable and `fallbackAdapterCache`**

Change `const adapter` to `const baseAdapter` and add cache map.

- [ ] **Step 2: Add `getAdapterForModel` function**

Implement per-model adapter resolution with caching.

- [ ] **Step 3: Change `adapters.resolve` to use `getAdapterForModel`**

Change from `resolve: () => adapter` to `resolve: (ref) => getAdapterForModel(ref.modelId)`.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: per-model adapter resolution with fallback cache in native engine"
```

---

### Task 2: Feature Flag Gate

**Files:**
- Modify: `server/drivers/native-engine.ts`
- Import: `isIntelligenceEnabled` from `../intelligence/feature-flag.ts`

**Interfaces:**
- Consumes: `isIntelligenceEnabled(config, env)` → boolean
- Produces: intelligence enabled based on env/config instead of hardcoded true

- [ ] **Step 1: Import `isIntelligenceEnabled`**

Add import from `../intelligence/feature-flag.ts`.

- [ ] **Step 2: Replace `enabled: true` with `isIntelligenceEnabled(undefined, process.env)`**

In the `intelligence` object, change `enabled: true` to `enabled: isIntelligenceEnabled(undefined, process.env)`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: feature flag gate for intelligence in native engine"
```

---

### Task 3: LLM Verifier with SuccessCriteria

**Files:**
- Modify: `server/drivers/native-engine.ts`
- Import: `createModelCaller` from `../intelligence/model-caller.ts`, `Verifier` from `../intelligence/verifier.ts`

**Interfaces:**
- Consumes: `createModelCaller(adapter, modelId)`, `Verifier`, `PlanStep`
- Produces: LLM-based verifier with SuccessCriteria, fallback to heuristic

- [ ] **Step 1: Add imports**

Add imports for `createModelCaller` and `Verifier`.

- [ ] **Step 2: Replace `verify: heuristicVerifier` with LLM verifier**

Implement async verifier that creates PlanStep with successCriteria, uses LLM Verifier, falls back to heuristic on error.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: LLM verifier with SuccessCriteria in native engine"
```

---

### Task 4: Task-Based Model Routing (6 Task Type)

**Files:**
- Modify: `server/drivers/native-engine.ts`

**Interfaces:**
- Consumes: `modelRouterConfig` with rules per task type
- Produces: fallback candidates enhanced with task-based routing

- [ ] **Step 1: Add `modelRouterConfig`**

Add modelRouterConfig with 6 task types, primary + fallbacks, costTable.

- [ ] **Step 2: Enhance `decide` with task-based routing**

In the intelligence `decide` function, add fallback candidates from modelRouterConfig based on `input.hasCode` / `input.hasImages`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: task-based model routing (6 task types) in native engine"
```

---

### Task 5: BudgetGuard Per-Run Wired

**Files:**
- Modify: `server/drivers/native-engine.ts`
- Import: `BudgetGuard` from `../routing/budget-guard.ts`

**Interfaces:**
- Consumes: `BudgetGuard`, `check(cost, threadId)`, `record(cost, threadId)`
- Produces: budget check/record per-run in decide function

- [ ] **Step 1: Import `BudgetGuard`**

Add import from `../routing/budget-guard.ts`.

- [ ] **Step 2: Wire BudgetGuard into `decide`**

Add BudgetGuard check/record in the decide function, blocking if budget exceeded.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: BudgetGuard per-run wired into native engine decide"
```

---

### Task 6: Intelligence Modules Injection

**Files:**
- Modify: `server/drivers/native-engine.ts`

**Interfaces:**
- Consumes: `createIntelligenceLayer` from `../agent-runtime/intelligence-layer.ts`
- Produces: intelligence layer with BudgetGuard, modelRouter, LLM Verifier, fallbackChain, threadId

- [ ] **Step 1: Add intelligence modules to `createIntelligenceLayer` call**

Pass `budgetGuard`, `pivotModelRouter`, `routingBudget`, `planner`, `executor`, `verifier`, `threadId`, `fallbackChain` to `createIntelligenceLayer`.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/drivers/native-engine.ts
git commit -m "feat: intelligence modules injection in native engine"
```

---

### Task 7: Orchestrator Verify Passes Step (SuccessCriteria)

**Files:**
- Modify: `server/agent-runtime/orchestrator.ts`

**Interfaces:**
- Consumes: `verify(output, step?)` — step has successCriteria, description, text, id
- Produces: orchestrator passes step to verifier

- [ ] **Step 1: Update verify type signature**

Change `verify?: (output: string) => ...` to `verify?: (output: string, step?: { successCriteria?: string; description?: string; text?: string; id?: string }) => ...`

- [ ] **Step 2: Update verify call to pass step**

Change `dependencies.intelligence.verify(stepResult.output)` to `dependencies.intelligence.verify(stepResult.output, step)`.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/agent-runtime/orchestrator.ts
git commit -m "feat: orchestrator verify passes step with SuccessCriteria"
```

---

### Task 8: nginx Proxy-Trust Bypass

**Files:**
- Modify: `server/request-auth.ts`

**Interfaces:**
- Produces: `isLocalhostProxy(req: IncomingMessage): boolean`

- [ ] **Step 1: Add `isLocalhostProxy` function**

Add function that checks if direct TCP peer is localhost (127.0.0.1, ::1, etc.).

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/request-auth.ts
git commit -m "feat: nginx proxy-trust bypass (isLocalhostProxy)"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 3: Run agent-runtime tests**

Run: `pnpm vitest run server/agent-runtime/`
Expected: All pass

- [ ] **Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: port 8 native engine improvements from Pivot to MausClaw"
```
