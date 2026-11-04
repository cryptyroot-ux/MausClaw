# Phase 4 (M5/M6) Implementation Plan

## M5: Process tree termination on timeout/abort
- `native-shell-tool.ts`: Add `detached: true` to spawn; kill process group on abort/timeout; add `uncertain?: boolean` to `ShellToolResult`; set `uncertain` when termination can't be confirmed
- `native-computer-tool.ts`: Same changes for `ComputerToolResult`
- `native-shell-capability-provider.ts`: Pass `uncertain` through to `CapabilityResult`
- `native-computer-capability-provider.ts`: Pass `uncertain` through to `CapabilityResult`

## M6: Startup reconciliation distinguishes runs with/without unsettled calls
- `message-db.ts`: Fix `recoverUnsettledAgentRuns` to only mark runs with ZERO capability calls as `interrupted`; runs with unsettled calls → `recovery_required`; runs with all settled calls → left as-is

## Tests (RED → GREEN)
- `native-shell-tool.test.ts`: process tree kills background children; `uncertain` field
- `native-computer-tool.test.ts`: process tree kills background children; `uncertain` field
- `message-db.test.ts`: `recoverUnsettledAgentRuns` distinguishes runs
- `runtime.test.ts`: uncertain tool result stops batch (process tree context)

## Verification
- Full test suite, typecheck, oxlint, vite build
- Commit and push Phase 4 changes
