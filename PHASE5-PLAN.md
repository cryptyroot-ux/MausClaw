# Phase 5 (M7/M8/M9) Implementation Plan

## M7 — Filesystem boundary (already implemented)
- `safeResolve` in `native-file-tools.ts`: canonical ancestor walk, symlink rejection
- `safeCwd` in `native-computer-tool.ts`: path validation with realpath fallback
- Shell tool uses `ctx.root` directly as cwd (set by caller)

## M9 — Web boundary (already implemented)
- `native-web-tool.ts`: IP normalization, IPv4-mapped IPv6, private address blocking, redirect validation

## M8 — Verification, orchestration, routing, budgets (NEEDS WORK)

### Issues found:
1. `model-router.ts:76` — `provider: ""` in ModelAssignment (hard-coded empty provider)
2. `RoutingRule` has no `provider` field — no way to associate models with providers
3. No validation that fallbacks belong to configured/available providers
4. Model-caller requirements/signals not validated before starting a request

### Changes:
1. Add `provider` field to `RoutingRule` and `ModelRouterConfig`
2. Fix `model-router.ts` to populate `provider` from routing rule instead of `""`
3. Add provider validation — fallbacks must only select from configured providers
4. Add model-caller validation before dispatch (check requirements/signals)

### Tests (RED → GREEN):
- model-router.test.ts: provider is populated correctly (not empty)
- model-router.test.ts: fallbacks restricted to configured providers
- model-router.test.ts: validation rejects unknown providers
- intelligence tests: model-caller validation before request