// Native file tools for the MausClaw agent engine: Read, Edit, Write, Glob, Grep.
// These are built-in capabilities (no MCP server needed) so MausClaw can do coding
// tasks out of the box. Path-safe: all paths resolve inside a workspace root.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES_DEFAULT = 2000;
const GLOB_MAX_RESULTS = 1000;
const GREP_MAX_CHARS = 30_000;
const GREP_MAX_LINES = 1000;
const BINARY_CHECK_BYTES = 8192;

export interface FileToolContext {
  readonly root: string;
}

export interface FileToolResult {
  readonly ok: boolean;
  readonly content: string;
  readonly error?: string;
}

function safeResolve(root: string, input: string): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const resolved = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  // Symlink escape check: resolve real path and ensure within root.
  try {
    const real = realpathSync(resolved);
    const realRel = relative(root, real);
    if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return null;
  } catch {
    // File doesn't exist yet (new file) — check parent directory.
    try {
      const parentReal = realpathSync(resolve(resolved, ".."));
      const parentRel = relative(root, parentReal);
      if (parentRel === ".." || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) return null;
    } catch {}
  }
  return resolved;
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function readTool(ctx: FileToolContext, args: any): FileToolResult {
  const filePath = safeResolve(ctx.root, args?.file_path);
  if (!filePath) return { ok: false, content: "Path is outside the workspace or invalid.", error: "path_outside_workspace" };
  if (!existsSync(filePath)) return { ok: false, content: `File not found: ${args?.file_path}`, error: "not_found" };
  const st = statSync(filePath);
  if (st.isDirectory()) return { ok: false, content: `Path is a directory: ${args?.file_path}. Use glob to list files.`, error: "is_directory" };
  const buf = readFileSync(filePath);
  if (isBinary(buf)) return { ok: true, content: `[binary file, ${buf.length} bytes]` };
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const offset = Math.max(1, Number(args?.offset) || 1);
  const limit = Math.max(1, Number(args?.limit) || READ_MAX_LINES_DEFAULT);
  const start = offset - 1;
  const slice = lines.slice(start, start + limit);
  const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
  let result = numbered;
  if (buf.length > READ_MAX_BYTES) {
    result += `\n\n[File truncated: ${buf.length} bytes, showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}]`;
  }
  if (start + limit < lines.length) {
    result += `\n\n[... ${lines.length - start - limit} more lines not shown. Use offset/limit to read more.]`;
  }
  return { ok: true, content: result };
}

function editTool(ctx: FileToolContext, args: any): FileToolResult {
  const filePath = safeResolve(ctx.root, args?.file_path);
  if (!filePath) return { ok: false, content: "Path is outside the workspace or invalid.", error: "path_outside_workspace" };
  if (!existsSync(filePath)) return { ok: false, content: `File not found: ${args?.file_path}`, error: "not_found" };
  const oldString = String(args?.old_string ?? "");
  const newString = String(args?.new_string ?? "");
  if (!oldString) return { ok: false, content: "old_string must not be empty.", error: "invalid_args" };
  const buf = readFileSync(filePath);
  if (isBinary(buf)) return { ok: false, content: "Cannot edit binary file.", error: "binary_file" };
  const text = buf.toString("utf8");
  const occurrences = text.split(oldString).length - 1;
  if (occurrences === 0) return { ok: false, content: "old_string not found in file.", error: "not_found" };
  if (occurrences > 1 && !args?.replace_all) {
    return { ok: false, content: `old_string found ${occurrences} times. Use replace_all: true or make old_string unique.`, error: "ambiguous_match" };
  }
  const updated = args?.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, newString);
  writeFileSync(filePath, updated, "utf8");
  return { ok: true, content: `File edited successfully (${occurrences} replacement${occurrences === 1 ? "" : "s"}).` };
}


function multiEditTool(ctx: FileToolContext, args: any): FileToolResult {
  const edits = Array.isArray(args?.edits) ? args.edits : [];
  if (edits.length === 0) return { ok: false, content: "No edits provided.", error: "invalid_args" };
  if (edits.length > 20) return { ok: false, content: "Too many edits (max 20).", error: "too_many_edits" };

  const results: string[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const edit of edits) {
    const filePath = safeResolve(ctx.root, edit?.file_path);
    if (!filePath) { results.push(`❌ ${edit?.file_path}: path outside workspace`); failCount++; continue; }
    if (!existsSync(filePath)) { results.push(`❌ ${edit?.file_path}: file not found`); failCount++; continue; }
    const oldString = String(edit?.old_string ?? "");
    const newString = String(edit?.new_string ?? "");
    if (!oldString) { results.push(`❌ ${edit?.file_path}: old_string must not be empty`); failCount++; continue; }
    const buf = readFileSync(filePath);
    if (isBinary(buf)) { results.push(`❌ ${edit?.file_path}: binary file`); failCount++; continue; }
    const text = buf.toString("utf8");
    const occurrences = text.split(oldString).length - 1;
    if (occurrences === 0) { results.push(`❌ ${edit?.file_path}: old_string not found`); failCount++; continue; }
    if (occurrences > 1 && !edit?.replace_all) { results.push(`❌ ${edit?.file_path}: old_string found ${occurrences} times (use replace_all)`); failCount++; continue; }
    const updated = edit?.replace_all ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    try {
      writeFileSync(filePath, updated, "utf8");
      results.push(`✅ ${edit?.file_path}: ${occurrences} replacement${occurrences === 1 ? "" : "s"}`);
      successCount++;
    } catch (err) {
      results.push(`❌ ${edit?.file_path}: write failed (${err instanceof Error ? err.message : String(err)})`);
      failCount++;
    }
  }

  return {
    ok: failCount === 0,
    content: `Multi-edit: ${successCount} succeeded, ${failCount} failed.\n${results.join("\n")}`,
    error: failCount > 0 ? "partial_failure" : undefined,
  };
}

function writeTool(ctx: FileToolContext, args: any): FileToolResult {
  const filePath = safeResolve(ctx.root, args?.file_path);
  if (!filePath) return { ok: false, content: "Path is outside the workspace or invalid.", error: "path_outside_workspace" };
  const content = String(args?.content ?? "");
  // Create parent dirs
  const parent = filePath.substring(0, filePath.lastIndexOf("/"));
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  const existed = existsSync(filePath);
  writeFileSync(filePath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  return { ok: true, content: `File ${existed ? "overwritten" : "created"} successfully (${bytes} bytes).` };
}

function globTool(ctx: FileToolContext, args: any): FileToolResult {
  const base = args?.path ? safeResolve(ctx.root, args.path) : ctx.root;
  if (!base) return { ok: false, content: "Path is outside the workspace or invalid.", error: "path_outside_workspace" };
  if (!existsSync(base)) return { ok: false, content: `Path not found: ${args?.path ?? ctx.root}`, error: "not_found" };
  const pattern = String(args?.pattern ?? "*");
  const results: { path: string; mtime: number }[] = [];
  const regex = globToRegex(pattern);
  const walk = (dir: string) => {
    if (results.length >= GLOB_MAX_RESULTS) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else {
        const rel = relative(base, full);
        if (regex.test(rel)) {
          results.push({ path: full, mtime: st.mtimeMs });
        }
      }
    }
  };
  walk(base);
  results.sort((a, b) => b.mtime - a.mtime);
  const paths = results.slice(0, GLOB_MAX_RESULTS).map((r) => r.path);
  if (paths.length === 0) return { ok: true, content: "No matching files found." };
  let result = paths.join("\n");
  if (results.length >= GLOB_MAX_RESULTS) result += `\n\n[Truncated at ${GLOB_MAX_RESULTS} results]`;
  return { ok: true, content: result };
}

function globToRegex(pattern: string): RegExp {
  // Convert glob to regex
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) { regex += "\\{"; i++; }
      else { regex += "(" + pattern.slice(i + 1, end).split(",").map(escapeRegex).join("|") + ")"; i = end + 1; }
    } else {
      regex += escapeRegex(c);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(c: string): string {
  return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function grepTool(ctx: FileToolContext, args: any): FileToolResult {
  const searchPath = args?.path ? safeResolve(ctx.root, args.path) : ctx.root;
  if (!searchPath) return { ok: false, content: "Path is outside the workspace or invalid.", error: "path_outside_workspace" };
  if (!existsSync(searchPath)) return { ok: false, content: `Path not found: ${args?.path ?? ctx.root}`, error: "not_found" };
  const pattern = String(args?.pattern ?? "");
  if (!pattern) return { ok: false, content: "pattern is required.", error: "invalid_args" };
  let regex: RegExp;
  try { regex = new RegExp(pattern, args?.case_sensitive === false ? "i" : ""); }
  catch (e) { return { ok: false, content: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`, error: "invalid_regex" }; }
  const globFilter = args?.glob ? globToRegex(args.glob) : null;
  const outputMode = args?.output_mode ?? "content";
  const contextLines = Math.max(0, Number(args?.context ?? args?.context_before ?? 0));
  const headLimit = Math.max(1, Number(args?.head_limit) || 1000);

  const files: string[] = [];
  const collectFiles = (p: string) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      let entries: string[];
      try { entries = readdirSync(p); } catch { return; }
      for (const name of entries) {
        if (name === "node_modules" || name === ".git") continue;
        collectFiles(join(p, name));
      }
    } else {
      if (globFilter) {
        const rel = relative(searchPath, p);
        if (!globFilter.test(rel)) return;
      }
      files.push(p);
    }
  };
  if (statSync(searchPath).isDirectory()) collectFiles(searchPath);
  else files.push(searchPath);

  let output = "";
  let totalLines = 0;
  let matchCount = 0;
  const fileMatches: string[] = [];
  const counts: Record<string, number> = {};

  for (const file of files) {
    if (totalLines >= GREP_MAX_LINES || output.length >= GREP_MAX_CHARS) break;
    let buf: Buffer;
    try { buf = readFileSync(file); } catch { continue; }
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    const matches: number[] = [];
    lines.forEach((line, idx) => { if (regex.test(line)) matches.push(idx); regex.lastIndex = 0; });
    if (matches.length === 0) continue;
    matchCount += matches.length;
    counts[file] = matches.length;
    fileMatches.push(file);

    if (outputMode === "files_with_matches") continue;
    if (outputMode === "count") continue;

    // content mode
    const shown = new Set<number>();
    for (const m of matches) {
      for (let i = Math.max(0, m - contextLines); i <= Math.min(lines.length - 1, m + contextLines); i++) {
        shown.add(i);
      }
    }
    const sorted = [...shown].sort((a, b) => a - b);
    for (const idx of sorted) {
      if (totalLines >= GREP_MAX_LINES || output.length >= GREP_MAX_CHARS) break;
      const prefix = matches.includes(idx) ? ">" : " ";
      const line = `${file}:${idx + 1}:${prefix}${lines[idx]}`;
      output += line + "\n";
      totalLines++;
    }
  }

  if (outputMode === "files_with_matches") {
    if (fileMatches.length === 0) return { ok: true, content: "No matches found." };
    return { ok: true, content: fileMatches.slice(0, headLimit).join("\n") };
  }
  if (outputMode === "count") {
    const lines = Object.entries(counts).map(([f, c]) => `${f}: ${c}`).join("\n");
    return { ok: true, content: lines || "No matches found." };
  }
  if (output.length === 0) return { ok: true, content: "No matches found." };
  return { ok: true, content: output.trimEnd() };
}

export function runFileTool(ctx: FileToolContext, name: string, args: Record<string, unknown>): FileToolResult {
  switch (name) {
    case "read": return readTool(ctx, args);
    case "edit": return editTool(ctx, args);
    case "multi_edit": return multiEditTool(ctx, args);
    case "write": return writeTool(ctx, args);
    case "glob": return globTool(ctx, args);
    case "grep": return grepTool(ctx, args);
    default: return { ok: false, content: `Unknown file tool: ${name}`, error: "unknown_tool" };
  }
}

export const FILE_TOOL_DESCRIPTORS = [
  { id: "read", name: "read", description: "Read a file's contents with line numbers. Supports offset/limit for large files.", schema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["file_path"], additionalProperties: false }, risk: "read" as const, sideEffect: false, timeoutMs: 10_000 },
  { id: "edit", name: "edit", description: "Replace exact text in a file. old_string must be unique unless replace_all is true.", schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false }, risk: "write" as const, sideEffect: true, timeoutMs: 10_000 },
  { id: "write", name: "write", description: "Create or overwrite a file with the given content.", schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"], additionalProperties: false }, risk: "write" as const, sideEffect: true, timeoutMs: 10_000 },
  { id: "multi_edit", name: "multi_edit", description: "Edit multiple files in one call. Each edit replaces old_string with new_string in the specified file.", schema: { type: "object", properties: { edits: { type: "array", items: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["file_path", "old_string", "new_string"], additionalProperties: false }, minItems: 1, maxItems: 20 } }, required: ["edits"], additionalProperties: false }, risk: "write" as const, sideEffect: true, timeoutMs: 30_000 },
  { id: "glob", name: "glob", description: "Find files matching a glob pattern, sorted by modification time.", schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false }, risk: "read" as const, sideEffect: false, timeoutMs: 10_000 },
  { id: "grep", name: "grep", description: "Search file contents with a regex. Supports context lines and output modes.", schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] }, context: { type: "integer", minimum: 0 }, head_limit: { type: "integer", minimum: 1 }, case_sensitive: { type: "boolean" } }, required: ["pattern"], additionalProperties: false }, risk: "read" as const, sideEffect: false, timeoutMs: 30_000 },
];
