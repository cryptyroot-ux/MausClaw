# MausClaw Audit Remediation — Implementation Plan

**Based on:** `docs/superpowers/specs/2026-11-04-mausclaw-audit-remediation-design.md` (approved)  
**Baseline:** `c24f4a9bc3430501a452416d7e221b4b6e802613`  
**Scope:** MausClaw only. No deployment, no live service mutation, no PR publish, no RootClaw changes.

## Phases (in order)

### Phase 1 — M1: Capability authority, approval, and containment (P0)
Root cause: `turn-runtime.ts` mounts native providers unconditionally and `CompositeCapabilityRuntime`/`Native*CapabilityProvider` only enforce grant allow/deny lists. Approval mode (`ask`/`full`) and the safety floor are consulted for MCP/chat tools but not for native shell/file/git/web/computer providers. A denied/hidden tool can still be dispatched by name.

Files to change:
- `server/agent-runtime/turn-runtime.ts` — gate native provider mounting on `toolsEnabled`/`computerUse`; pass scope+grant checks at dispatch.
- `server/agent-runtime/capability-runtime.ts` — make dispatch policy require approval-consistent allow/deny for every capability, and prevent hidden-tool bypass.
- New or extended provider wrapper — enforce `approval.floored`/`approval.ask` before native mutating invocation; read-only still respects safety floor.

Tests to add:
- Native tool in `ask` mode is not executed until approval granted; deny/expire/cancel/timeout stop execution.
- `toolsEnabled: false` / `computerUse: false` prevents mounting and dispatch.
- Model returning a hidden tool name is rejected by dispatch scope.
- File/grep escape via ancestor symlink (M7 companion).

Acceptance:
- No native effect occurs in `ask` mode before approval.
- Full access still permitted but never bypasses safety floor.

### Phase 2 — M7/M9: Filesystem and web boundaries
Root cause: `safeResolve` checks leaf/parent realpath but not every ancestor symlink for paths whose intermediates do not exist; glob/grep traversal follows escaping symlinks. `privateAddress` does not normalize IPv4-mapped IPv6, and DNS resolution/fetch are separate steps allowing rebinding.

Files:
- `server/agent-runtime/native-file-tools.ts` — canonical ancestor walk/no-follow resolution; apply to read/write/edit/glob/grep.
- `server/agent-runtime/native-web-tool.ts` — normalize IPv6/IPv4-mapped; pin resolved destination; validate every redirect; injected DNS/fetch tests only.

Tests:
- `escape/newdir/file.txt` write rejected; grep outside root rejected.
- `[::ffff:127.0.0.1]` fetch blocked; redirect to private blocked; no real network in tests.

### Phase 3 — M2/M3/M4: Protocol completion and provider/model identity
Root cause: adapters emit raw provider finish markers (`end_turn`, `STOP`, `completed`) while `runtime.ts` accepts only `stop`; multi-call events are merged but IDs can collide (Gemini uses function name); adapter resolver ignores `providerId` and uses `OpenAI-compatible` for any non-default model ID.

Files:
- `server/agent-runtime/anthropic-adapter.ts`, `gemini-adapter.ts`, `responses-adapter.ts` — normalize terminal markers into engine finish-reason set; unique call IDs.
- `server/agent-runtime/runtime.ts` — accept normalized finish reasons; batch contract validates unique IDs before dispatch.
- `server/drivers/native-engine.ts` — resolve adapter by full `ProviderModelRef`; reject unsupported provider/model before network dispatch.

Tests:
- All three valid protocol completions accepted; `failed: invalid_model_response` eliminated on the fixture path.
- Two valid tool calls in one round accepted; repeated Gemini function name gets unique ID.
- Non-default model with Gemini `providerId` uses Gemini endpoint/key, not default Anthropic.

### Phase 4 — M5/M6: Uncertain effects, process lifecycle, durable recovery
Root cause: runtime processes the whole batch then settles; uncertain results stop after later effects. Shell timeout kills child bash but not the whole process tree; result is ordinary failure without uncertainty.

Files:
- `server/agent-runtime/runtime.ts` — batch stops on first uncertain/failed mutating result; no provider cascade after uncertain; status `recovery_required` emitted before next batch.
- `server/agent-runtime/native-shell-tool.ts`, `native-computer-tool.ts` — terminate process tree on timeout/abort; report `uncertain_side_effect` when child effects may outlive the tool response.
- `server/message-db.ts` / run store — startup reconciliation distinguishes live runs; do not globally mark another active run interrupted.

Tests:
- First tool uncertain → second tool not invoked; recovery status.
- Delayed writer child process killed on timeout; no marker after tool returns.
- No live-provider calls; fixture-based.

### Phase 5 — M8/M10: Verification evidence, orchestration wiring, budgets
Root cause: verifier receives capability names only; negative verdict does not fail run; model-caller can start with no signal and zero fetch. Orchestrator attached but normal chat uses `engine.run()`; fallback tiers route to same primary model; budget excludes verifier/compaction calls.

Files:
- `server/agent-runtime/runtime.ts` — verification requires evidence; negative verdict or verifier error fails run when verification required; optional verifier not-run ≠ pass.
- `server/agent-runtime/model-caller.ts` — require signal; validate before starting request.
- `server/drivers/native-engine.ts`, `server/agent-runtime/intelligence-layer.ts` — route only configured provider/model pairs; budget includes all engine model calls.

Tests:
- Verifier `ok:false` → run not completed.
- Model caller with no signal starts zero fetches.

### Phase 6 — Distribution, CI, evaluation evidence
Root cause: `compose.yaml`/`Dockerfile` install Claude Code, Codex, Grok CLI by default; image smoke step creates variables without inspecting image; CI preflight/schema drift; eval runners do not fail on failed rows and mix incomparable scores.

Files:
- `compose.yaml`, `Dockerfile`, `deploy/local/Dockerfile`, `.github/workflows/docker.yml` — remove default external engine CLI installation; keep MausClaw-native API drivers only; inspect `rea-agents` before classifying.
- CI workflow — actual image content/build/boot assertions; lint, typecheck, build, runtime jobs reachable.
- Eval runners — nonzero exit on failed tasks, retained capped/infra/unrun outcomes, comparable model/revision/environment.

Tests:
- Native-only distribution assertion (no external CLI packages installed by default).
- CI job graph reaches typecheck/build/runtime; report pre-existing failures separately.

## Per-phase workflow
1. Add/extend regression test that fails on baseline.
2. Implement single root-cause fix; one change at a time.
3. Run focused tests + lint + typecheck; verify no regressions.
4. Record disposition per finding (reproduced / source-confirmed / not reproduced / needs evidence).
5. Only then proceed to next phase.

## Reporting
After each phase: summary of changes, test results (pass/fail/count), any unavailable checks, and whether next phase is ready.
