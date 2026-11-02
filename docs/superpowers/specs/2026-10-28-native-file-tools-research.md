# Native File Tools — Research & Design

Date: 2026-10-28
Status: research, awaiting execution approval
Scope: design of built-in file tools (Read/Edit/Write/Glob/Grep) for MausClaw native engine,
so MausClaw can do coding tasks without MCP file servers.

## 1. Why native file tools

MausClaw currently has NO built-in file tools. All file access goes through MCP servers (user-configured)
or the browser/computer MCP. Top agents (Claude Code, Codex, OpenCode, Hermes, Pi) all have built-in
Read/Edit/Write/Glob/Grep. Without them, MausClaw cannot do coding tasks out of the box. This is the
single biggest gap for MausClaw to be a universal agent platform.

## 2. Design (Claude Code / Codex / OpenCode inspired)

### 2.1 Read
- Input: `file_path` (absolute or relative to workspace), `offset` (line number, 1-based, default 1),
  `limit` (max lines, default 2000).
- Output: file content with line numbers (`N\tcontent`), cat -n style.
- Binary detection: check for null bytes in first 8KB. If binary, return "[binary file, N bytes]".
- Large file: if > 256KB, truncate with notice. If > 10MB, refuse (too large).
- Image files (png/jpg/gif/webp): return as base64 image (multimodal).
- PDF: extract text (first 20 pages).
- Notebook (.ipynb): return cells.
- Must handle: not found, permission denied, directory (error: use Glob).

### 2.2 Edit
- Input: `file_path`, `old_string`, `new_string`, `replace_all` (boolean, default false).
- Semantics: exact string replacement. old_string must appear in file.
- If old_string appears multiple times and replace_all is false → error (must be unique or use replace_all).
- If old_string not found → error.
- Preserve indentation and line endings (detect CRLF vs LF).
- Must read file first (track read state) — editing unread file is an error (prevents blind edits).
- Returns: "File edited successfully" + diff preview.

### 2.3 Write
- Input: `file_path`, `content`.
- Creates new file or overwrites existing.
- If file exists, must have been read first (same as Edit).
- Creates parent directories if needed.
- Returns: "File written successfully" + bytes.

### 2.4 Glob
- Input: `pattern` (glob), `path` (base dir, default workspace).
- Output: list of matching file paths, sorted by modification time (newest first).
- Respects .gitignore (skip ignored files).
- Caps at 1000 results.
- Pattern syntax: standard glob (**, *, ?, {a,b}).

### 2.5 Grep
- Input: `pattern` (regex), `path` (file or dir), `glob` (filter), `output_mode` (content/files_with_matches/count), `context` (lines before/after), `head_limit`.
- Output: matching lines with file:line:content (content mode), or file list, or count.
- Uses ripgrep if available, else JS implementation (slower).
- Caps output at 30k chars / 1000 lines.
- Respects .gitignore.

## 3. Path safety

- All paths resolved relative to workspace root (`WORKSPACES_DIR/<botId>/`).
- Absolute paths allowed only within workspace root or approved roots.
- Path traversal (`../`) that escapes workspace → error.
- Symlinks: resolve and check target is within workspace (prevent symlink escape).
- No access to system files outside workspace (unless explicitly allowed).

## 4. Concurrency

- Read-only tools (Read, Glob, Grep) can run concurrently.
- Mutating tools (Edit, Write) run sequentially.
- MausClaw engine currently runs tools sequentially. Need to classify and parallelize read-only.

## 5. Integration with CapabilityProvider

Each tool is a `CapabilityProvider` with kind "native-tool":
- `list(grant)` returns the 5 tool descriptors (if granted).
- `mount()` no-op (no process).
- `invoke(call, ctx)` dispatches to the tool implementation.
- `validate(call, grant)` checks grant + args.
- `close()` no-op.
- `describe()` returns tool name.

Grant policy: native file tools are "write" risk (Edit/Write) or "read" risk (Read/Glob/Grep).
Approval: Edit/Write require approval unless full mode; Read/Glob/Grep auto-allowed.

## 6. Implementation plan

### Step 1: Native file tools module
- Create `server/agent-runtime/native-file-tools.ts` with 5 tool implementations.
- Path safety utilities.
- Binary detection.
- Read with offset/limit + line numbers.
- Edit with uniqueness check.
- Write with parent dir creation.
- Glob with .gitignore.
- Grep with regex + context.

### Step 2: CapabilityProvider wrapper
- Create `server/agent-runtime/native-file-capability-provider.ts` implementing CapabilityProvider.
- Register in turn-runtime.ts alongside McpCapabilityProvider and SkillCapabilityProvider.

### Step 3: Concurrency
- Modify runtime.ts to run read-only tools concurrently (classify by risk === "read").

### Step 4: Tests
- Unit tests for each tool (path safety, binary, truncation, edit uniqueness, glob, grep).
- Integration test via native-only.e2e (file read/edit round trip).

### Step 5: Workspace root wiring
- turn-runtime.ts passes workspace root (from turn or bot context) to the provider.

## 7. Dependencies

- `fast-glob` or `glob` for Glob (check if already in deps).
- `ripgrep` binary (optional, fallback to JS).
- No new heavy deps preferred.

## 8. Risks

- Path traversal security: must be bulletproof.
- Large file memory: must stream/truncate.
- Edit uniqueness: must fail clearly on ambiguous match.
- Binary files: must detect and refuse text operations.
- Concurrency: must not race on the same file.

## 9. Open questions

- Should native file tools be gated behind a feature flag or always on?
- Should they be scoped to workspace only, or allow broader file access?
- Should Edit require read-first (track read state)?
- Should Glob respect .gitignore by default?

Recommendation: workspace-scoped by default, read-first required, .gitignore respected, feature flag `nativeFileTools` default true.
