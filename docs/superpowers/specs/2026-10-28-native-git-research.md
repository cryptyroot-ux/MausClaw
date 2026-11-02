# Native Git Tool — Research & Design

Date: 2026-10-28
Status: research + implementation
Scope: built-in git operations for MausClaw native engine.

## 1. Why native git (not just bash)

MausClaw has a bash tool now, so git works via `git status`. But a dedicated git tool provides:
- Structured output (parsed status, diff, log) for the model.
- Grant-governed operations (read vs write classification).
- Approval gating (commit/push require approval; status/diff auto-allowed).
- Path safety (cwd = workspace, no traversal).
- Consistent error handling.

## 2. Design (Codex / Claude Code inspired)

### 2.1 Git tool
- Input: `operation` (enum: status, diff, log, add, commit, branch, checkout, init), plus operation-specific args.
- status: no args. Output: branch, staged, unstaged, untracked.
- diff: `path?`, `staged?` (boolean). Output: unified diff.
- log: `max_count?` (default 10), `oneline?` (boolean). Output: commit list.
- add: `paths` (array of strings or "."). Output: "staged N files".
- commit: `message` (string, required), `amend?` (boolean). Output: commit hash + message.
- branch: `name?` (create), `delete?` (string), `list?` (boolean). Output: branch list or confirmation.
- checkout: `target` (branch/commit/file). Output: confirmation.
- init: no args. Output: "initialized repository".

### 2.2 Security
- cwd = workspace root (validated).
- env: strip GIT_* (reuse checkpoints pattern) to prevent injection.
- Timeout: 30s per operation.
- No arbitrary git commands — only allowlisted operations.
- commit message sanitized (no shell injection since we use execFile, not shell).

### 2.3 Implementation
- Use `execFile("git", args, { cwd, env, timeout, encoding })` (no shell, safe).
- Parse output for structured results.
- execFile args are passed as array (no shell injection).

### 2.4 Concurrency
- Read operations (status, diff, log) can run concurrently.
- Write operations (add, commit, branch, checkout, init) run sequentially.

### 2.5 Risk classification
- status, diff, log, branch(list): read (auto-allowed).
- add, commit, checkout, branch(create/delete), init: write (approval required unless full mode).

### 2.6 Testing
- Unit: status on fresh repo, init, add, commit, log, diff, branch create/list, checkout.
- Path safety: cwd = workspace.
- Timeout handling.

## 3. Open questions
- Should git be a single tool with operation enum, or separate tools (git_status, git_diff, etc.)?
  Recommendation: single "git" tool with operation enum (matches Claude Code's Bash-for-git pattern but structured).
- Should we support push/pull? Recommendation: no (remote operations need auth; use MCP git server for that).
