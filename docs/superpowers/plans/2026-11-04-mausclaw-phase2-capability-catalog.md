# MausClaw Phase 2 — Capability Catalog and Safe Tool Scheduling

**Date:** 2026-11-04
**Base commit:** `c24f4a9bc` (Phase 1 merged to main)
**Status:** Approved for execution

---

## Phase 2 Requirements (from spec §13)

1. **Enforce unique namespaced capability IDs and a single invocation gateway**
2. **Add bounded deferred discovery for MCP tools and Skills; initially expose only selected schemas to the adapter**
3. **Revalidate after hooks; prevent ambiguous provider fallback after dispatch**
4. **Add mixed safe-read concurrency, serial mutation ordering, repeated-read reuse, and repeated-effect protection**
5. **Keep MCP unknown-risk by default; preserve current per-turn mount/close and approval flow**

---

## Task Breakdown

### Task 1: Namespaced Capability IDs and Duplicate Rejection
**Files:** `contracts.ts`, `capability-runtime.ts`, `native-file-capability-provider.ts`, `native-git-capability-provider.ts`, `native-shell-capability-provider.ts`, `native-web-capability-provider.ts`, `native-computer-capability-provider.ts`, `chat-capability-runtime.ts`, `tool-search-capability-provider.ts`, `skills.ts` (`SkillCapabilityProvider`)

**Changes:**
- Add `parallelSafe?: boolean` and `concurrencyKey?: string` to `CapabilityDescriptor` in `contracts.ts`
- Enforce namespace prefixes: `native:<name>`, `mcp:<server>/<tool>`, `skill:<name>`
- Reject duplicate capability IDs at session composition time (`CompositeCapabilityRuntime` constructor, `InMemoryCapabilitySession.register()`)
- Update all native providers to use namespaced IDs
- Update MCP bridge (`chat-capability-runtime.ts`) to use `mcp:<server>/<tool>` format
- Update `SkillCapabilityProvider` to use `skill:<name>` format (already partially done)

### Task 2: Single CapabilityInvocationGateway (No Fallback After Dispatch)
**Files:** `capability-runtime.ts` (`CompositeCapabilityRuntime`), `contracts.ts` (if new types needed)

**Changes:**
- Create `CapabilityInvocationGateway` class that wraps `CompositeCapabilityRuntime` or replaces its `invoke` logic
- Single provider resolution: exactly one provider per capability ID (no cascade)
- After pre-tool-use hooks, **revalidate** the call against grant and schema
- On any non-ok result (denied, interrupted, invalid_arguments, closed, failed, uncertain), return immediately — **no fallback to another provider**
- Remove the fallback cascade loop from `CompositeCapabilityRuntime.invoke()`

### Task 3: Deferred Tool Discovery — CapabilityCatalog / ToolSurface
**Files:** New `capability-catalog.ts`, `agent-turn-kernel.ts`, `runtime.ts`, `chat-mcp-tools.ts`, `capability-runtime.ts`

**Changes:**
- Create `CapabilityCatalog` class: holds all registered providers, supports `search(query, limit)`, `get(capabilityId)`, `listInitial(grant)`
- Create `ToolSurface` class: the subset of capabilities actually sent to the model in a given turn
- Initial surface: native tools (file, git, shell, web, computer), `tool_search`, `tool_output_read`, `ask_user`
- `tool_search` becomes the primary discovery mechanism — searches catalog on demand
- MCP: mount servers **on-demand** when a tool from that server is first invoked (or searched for), not at turn start
- Skills: only list enabled skills when explicitly searched or when `skill:` capability is invoked

### Task 4: Safe Tool Scheduling
**Files:** `agent-turn-kernel.ts`, `runtime.ts`, `contracts.ts` (already added `parallelSafe`, `concurrencyKey`)

**Changes:**
- Read-only tools with `parallelSafe=true` run concurrently (bounded by a concurrency limit, e.g., 8)
- Mutating tools (`risk !== "read"` or `sideEffect=true`) always run sequentially
- Tools sharing a `concurrencyKey` serialize with each other
- Repeated-read reuse: cache results for identical `(capabilityId, arguments)` within a turn; return cached result on subsequent calls
- Repeated-effect protection: track dispatched mutating calls; reject re-dispatch of same capability+args within a turn with "duplicate_effect" error

### Task 5: MCP Unknown-Risk Default (Preserve Per-Turn Lifecycle)
**Files:** `chat-mcp-tools.ts`, `chat-capability-runtime.ts`

**Changes:**
- Verify MCP tools default to `risk: "write"`, `sideEffect: true` (already done in `chat-capability-runtime.ts`)
- Ensure per-turn mount/close lifecycle preserved (already done)
- Mount-on-demand integration with Task 3

### Task 6: Full Verification
**Commands:** `pnpm exec vitest run`, `pnpm run typecheck`, `pnpm run lint`

**Expected:** All 388+ tests pass, typecheck clean, lint clean

---

## Implementation Order

1. **Task 1** — Contracts and provider ID changes (foundational)
2. **Task 2** — Gateway (depends on Task 1)
3. **Task 3** — Catalog/Surface + deferred discovery (depends on Task 1, 2)
4. **Task 4** — Scheduling (depends on Task 2, 3)
4. **Task 5** — MCP risk verification (independent, verify existing)
5. **Task 6** — Verification

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Update test expectations in parallel; no safety assertion weakening |
| Duplicate ID detection misses cases | Check at both `InMemoryCapabilitySession.register()` and `CompositeCapabilityRuntime` construction |
| Hook revalidation breaks existing hook users | Revalidate only grant/schema, not arguments; hooks that modify args must produce valid args |
| Deferred MCP mount breaks approval flow | Mount before approval check, same turn; preserve per-turn close |
| Repeated-read cache causes stale data | Cache keyed by `(capabilityId, JSON.stringify(arguments))`; only for `risk="read" && sideEffect=false` |

---

## Success Criteria

- All Phase 0/1 safety assertions preserved (approval, safety-floor, recovery, task-checker, tool-scope)
- Capability IDs are namespaced and unique
- No provider fallback after dispatch
- `tool_search` works as primary discovery; MCP mounts on-demand
- Mixed read/write scheduling with `parallelSafe` and `concurrencyKey`
- Repeated-read reuse and repeated-effect protection functional
- 388+ tests pass, typecheck clean, lint clean