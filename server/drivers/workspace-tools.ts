// Native workspace tools for every native driver, run in-process: shell, file read/write/edit/patch, grep, glob,
// list_dir. Paths are confined to the turn's workspace root (plus named extra roots) unless the turn allows more.
// Engine-level and provider-agnostic: a driver only hands over the turn's folder.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChatToolCallView, ChatToolDefinition, ChatToolResult } from "./chat-mcp-tools.ts";
import { executeGitTool, GIT_COMMIT_TOOL, GIT_READ_TOOLS, GIT_TOOL_DEFINITIONS } from "./workspace-git.ts";
import { executeWebTool, WEB_TOOL_DEFINITIONS, type WebOptions } from "./web-tools.ts";

export interface WorkspaceToolsConfig {
  /** The folder relative paths resolve against and the shell starts in. */
  root: string;
  /** Extra folders the bot may read (e.g. its memory and skill folders). */
  readRoots?: readonly string[];
  /** Extra folders the bot may also write. */
  writeRoots?: readonly string[];
  /** Lift path confinement entirely (bot config or MAUSCLAW_WORKSPACE_UNRESTRICTED=1). */
  unrestricted?: boolean;
  /** Mount web_fetch/web_search (default true). */
  web?: boolean;
  /** Tests only. */
  webOptions?: WebOptions;
}

export const SHELL_TOOL = "shell";
const WEB_TOOLS = new Set(["web_fetch", "web_search"]);
const GIT_TOOLS = new Set<string>([...GIT_READ_TOOLS, GIT_COMMIT_TOOL]);
const READ_ONLY = new Set<string>(["read_file", "grep", "glob", "list_dir", ...GIT_READ_TOOLS, ...WEB_TOOLS]);
const MUTATING = new Set([SHELL_TOOL, "write_file", "edit_file", "apply_patch", GIT_COMMIT_TOOL]);
export const WORKSPACE_TOOL_NAMES: readonly string[] = [...READ_ONLY, ...MUTATING];
export const isWorkspaceTool = (name: string) => READ_ONLY.has(name) || MUTATING.has(name);
/** Read-only tools may run concurrently with each other; everything else is mutating by default. */
export const workspaceToolReadOnly = (name: string) => READ_ONLY.has(name);

const DEFAULT_SHELL_MS = 120_000;
const MAX_SHELL_MS = 30 * 60_000;
const SHELL_CAPTURE_BYTES = 1_000_000;
const READ_DEFAULT_LINES = 2_000;
const LINE_CHARS = 2_000;
const READ_MAX_BYTES = 10 * 1024 * 1024;
const GREP_MAX_LINES = 500;
const GLOB_MAX = 1_000;
const LIST_MAX = 1_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".cache"]);

const str = (description: string) => ({ type: "string", description });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ChatToolDefinition => ({
  type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});

export const WORKSPACE_TOOL_DEFINITIONS: readonly ChatToolDefinition[] = [
  fn(SHELL_TOOL, "Run a shell command (bash -c) in your workspace folder and return its exit code and combined stdout/stderr. " +
    "Use for builds, tests, git, scripts and anything without a dedicated tool; prefer read_file/grep/glob/list_dir for reading files. " +
    "Each call is a fresh shell: pass cwd instead of relying on an earlier cd. Long output is shortened (full text kept for read_tool_output). " +
    "Set background=true for servers or watchers: it returns at once with the pid and a log file you can read_file; stop it later with `kill <pid>`.", {
    command: str("The command line, e.g. \"npm test -- --run src/a.test.ts\"."),
    cwd: str("Folder to run in, relative to the workspace (default: the workspace root)."),
    timeout_ms: int("Kill the command after this many milliseconds (default 120000, max 1800000).", { minimum: 1000, maximum: MAX_SHELL_MS }),
    background: { type: "boolean", description: "Start without waiting; output goes to a log file in .mausclaw/bg/." },
  }, ["command"]),
  fn("read_file", "Read a text file from the workspace with line numbers (\"  12\\tcontent\"). Reads up to 2000 lines from offset; " +
    "page through big files with offset/limit. Line numbers are for reference only, never part of the file.", {
    path: str("File path, relative to the workspace or absolute inside it."),
    offset: int("1-based line to start at (default 1).", { minimum: 1 }),
    limit: int("Number of lines to read (default 2000).", { minimum: 1, maximum: 20_000 }),
  }, ["path"]),
  fn("write_file", "Create or overwrite a whole file in the workspace (parent folders are created). " +
    "For a change inside an existing file prefer edit_file or apply_patch.", {
    path: str("File path, relative to the workspace or absolute inside it."),
    content: str("The complete new file content."),
  }, ["path", "content"]),
  fn("edit_file", "Replace an exact string in a file. old_string must match the file byte-for-byte (including indentation) and be unique, " +
    "unless replace_all is true; include enough surrounding lines to make it unique. Read the file first.", {
    path: str("File path, relative to the workspace or absolute inside it."),
    old_string: str("Exact text to replace (non-empty)."),
    new_string: str("Replacement text."),
    replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
  }, ["path", "old_string", "new_string"]),
  fn("apply_patch", "Apply a unified diff (git diff / diff -u format) to one or more workspace files, all or nothing. " +
    "Use ---/+++ headers per file (a/ and b/ prefixes allowed, /dev/null to create or delete) and @@ hunks with a few context lines. " +
    "Hunk line numbers may be approximate; context must match exactly.", {
    patch: str("The unified diff text."),
  }, ["patch"]),
  fn("grep", "Search file contents in the workspace with a regular expression (ripgrep syntax). Returns path:line:text matches, up to 500 lines.", {
    pattern: str("Regular expression to search for."),
    path: str("File or folder to search (default: the workspace root)."),
    glob: str("Only search files matching this glob, e.g. \"*.ts\" or \"src/**/*.py\"."),
    ignore_case: { type: "boolean", description: "Case-insensitive search." },
    max_results: int("Maximum matching lines (default 500).", { minimum: 1, maximum: 5_000 }),
  }, ["pattern"]),
  fn("glob", "Find files by name pattern in the workspace, e.g. \"**/*.ts\" or \"src/*.json\". Returns matching paths, newest first.", {
    pattern: str("Glob pattern: * matches within a folder, ** across folders, ? one character, {a,b} alternatives."),
    path: str("Folder to search from (default: the workspace root)."),
  }, ["pattern"]),
  fn("list_dir", "List a workspace folder: one entry per line with a trailing / for folders and the size of files.", {
    path: str("Folder to list (default: the workspace root)."),
    depth: int("How many levels to descend (default 1, max 4).", { minimum: 1, maximum: 4 }),
  }, []),
  ...GIT_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
];

export class WorkspacePathError extends Error {}

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function realOrSelf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The real path of `path`, following every symlink component, including dangling ones (a link to a file that does
 * not exist yet still points somewhere, and writing through it would create that target). Missing tails are kept. */
export function realTarget(path: string): string {
  let pending = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  for (let hops = 0; pending.length;) {
    const next = join(current, pending.shift()!);
    let stat;
    try { stat = lstatSync(next); } catch { return join(next, ...pending); }
    if (!stat.isSymbolicLink()) { current = next; continue; }
    if (++hops > 40) throw new WorkspacePathError(`${path} has too many symbolic links`);
    const link = readlinkSync(next);
    const target = isAbsolute(link) ? link : join(current, link);
    pending = [...resolve(target).split(sep).filter(Boolean), ...pending];
    current = sep;
  }
  return current;
}

export function createWorkspacePaths(config: WorkspaceToolsConfig) {
  const root = resolve(config.root);
  const lexicalRoots = (write: boolean) => [root, ...(config.writeRoots ?? []), ...(write ? [] : config.readRoots ?? [])].map((dir) => resolve(dir));
  const realRoots = (write: boolean) => lexicalRoots(write).map(realOrSelf);
  return {
    root,
    /** An absolute path the tool may touch, or a WorkspacePathError. Both the spelled path and its real target
     * (after symlinks) must sit inside an allowed root, so neither `..` nor a symlink leads out. */
    resolve(input: unknown, mode: "read" | "write", fallback?: string): string {
      const raw = typeof input === "string" && input.trim() ? input.trim() : fallback;
      if (raw === undefined) throw new WorkspacePathError("path is required");
      if (raw.includes("\0")) throw new WorkspacePathError("path contains a NUL byte");
      const absolute = resolve(isAbsolute(raw) ? raw : join(root, raw));
      if (config.unrestricted) return absolute;
      const write = mode === "write";
      if (!lexicalRoots(write).some((dir) => within(dir, absolute))) {
        throw new WorkspacePathError(`${raw} is outside the workspace (${root})${write && (config.readRoots ?? []).some((dir) => within(resolve(dir), absolute)) ? "; that folder is read-only" : ""}.`);
      }
      const real = realTarget(absolute);
      if (!realRoots(write).some((dir) => within(dir, real))) {
        throw new WorkspacePathError(`${raw} leads outside the workspace through a symbolic link.`);
      }
      return absolute;
    },
    display(path: string): string {
      const rel = relative(root, path);
      if (rel === "") return ".";
      return !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
    },
  };
}

type Paths = ReturnType<typeof createWorkspacePaths>;
const ok = (text: string): ChatToolResult => ({ ok: true, text });
const fail = (text: string): ChatToolResult => ({ ok: false, text });

/** How a workspace call shows on the approval card: shell and writes ask in Ask mode; reads never do. */
export function workspaceToolView(name: string, args: Record<string, unknown>): ChatToolCallView {
  if (READ_ONLY.has(name)) return { title: name, input: args, ask: false };
  // A session grant covers the tool, never "every command": shell grants stay per exact command line.
  const grant = name === SHELL_TOOL ? JSON.stringify(["workspace", name, String(args.command ?? "")]) : JSON.stringify(["workspace", name]);
  return { title: name, input: args, ask: true, grant };
}

export function validateWorkspaceArgs(name: string, args: Record<string, unknown>): void {
  const definition = WORKSPACE_TOOL_DEFINITIONS.find((entry) => entry.function.name === name);
  if (!definition) throw new Error(`Unknown workspace tool ${name}`);
  const parameters = definition.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
  for (const key of parameters.required) if (args[key] === undefined) throw new Error(`${name} needs "${key}"`);
  for (const [key, value] of Object.entries(args)) {
    const spec = parameters.properties[key];
    if (!spec) throw new Error(`${name} has no parameter "${key}"`);
    if (value === null || value === undefined) continue;
    if (spec.type === "array") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name}: "${key}" must be an array of strings`);
      continue;
    }
    const type = spec.type === "integer" ? "number" : spec.type;
    if (typeof value !== type || (spec.type === "integer" && !Number.isInteger(value))) throw new Error(`${name}: "${key}" must be ${spec.type === "integer" ? "an integer" : `a ${spec.type}`}`);
  }
}

// ---------- shell ----------

const SHELL_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "NODE_OPTIONS", "FNM_DIR", "NVM_DIR", "PNPM_HOME", "COREPACK_HOME", "GOPATH", "CARGO_HOME", "RUSTUP_HOME", "VIRTUAL_ENV", "JAVA_HOME"];
/** The server's own secrets never reach a bot's shell: only ordinary environment passes through. */
export function shellEnvironment(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHELL_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  env.TERM ??= "dumb";
  env.MAUSCLAW_WORKSPACE = root;
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.CI ??= "1";
  return env;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

async function runShell(args: Record<string, unknown>, paths: Paths, signal: AbortSignal): Promise<ChatToolResult> {
  const command = String(args.command ?? "");
  if (!command.trim()) return fail("shell needs a non-empty command.");
  const cwd = paths.resolve(args.cwd, "read", paths.root);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(`cwd ${paths.display(cwd)} is not a folder.`);
  const env = shellEnvironment(paths.root);
  if (args.background === true) {
    const dir = join(paths.root, ".mausclaw", "bg");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, `${Date.now()}-${randomBytes(3).toString("hex")}.log`);
    const out = openSync(log, "a");
    const child = spawn("/bin/bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", out, out] });
    closeSync(out);
    child.unref();
    return ok(`Started in the background: pid ${child.pid}. Output goes to ${paths.display(log)} (read it with read_file); stop it with \`kill ${child.pid}\`.`);
  }
  const timeoutMs = Math.min(MAX_SHELL_MS, Math.max(1_000, Number(args.timeout_ms) || DEFAULT_SHELL_MS));
  return new Promise<ChatToolResult>((done) => {
    const started = Date.now();
    const child = spawn("/bin/bash", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let captured = 0;
    let dropped = 0;
    const take = (chunk: Buffer) => {
      if (captured >= SHELL_CAPTURE_BYTES) { dropped += chunk.length; return; }
      const room = SHELL_CAPTURE_BYTES - captured;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(part);
      captured += part.length;
      dropped += chunk.length - part.length;
    };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    let why: "timeout" | "aborted" | null = null;
    const stop = (reason: "timeout" | "aborted") => {
      if (why) return;
      why = reason;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 2_000).unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, sig: NodeJS.Signals | null, error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      let output = Buffer.concat(chunks).toString("utf8");
      if (dropped) output += `\n[… ${dropped} more bytes of output not captured]`;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const status = error ? `failed to start: ${error.message}`
        : why === "timeout" ? `killed after the ${timeoutMs} ms timeout`
        : why === "aborted" ? "killed: the turn was stopped"
        : sig ? `killed by ${sig}` : `exit code ${code}`;
      const text = `[${status}; ${seconds}s; cwd ${paths.display(cwd) || "."}]\n${output}`;
      done({ ok: !error && !why && code === 0, text });
    };
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, sig) => finish(code, sig));
  });
}

// ---------- files ----------

function isBinary(buffer: Buffer): boolean {
  const n = Math.min(buffer.length, 8_000);
  for (let i = 0; i < n; i++) if (buffer[i] === 0) return true;
  return false;
}

function readText(path: string): string {
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Error("is a folder; use list_dir");
  if (stat.size > READ_MAX_BYTES) throw new Error(`is ${stat.size} bytes, over the ${READ_MAX_BYTES}-byte limit; use grep or shell (head/sed) instead`);
  const buffer = readFileSync(path);
  if (isBinary(buffer)) throw new Error("looks binary; inspect it with shell (file, xxd) instead");
  return buffer.toString("utf8");
}

function readFileTool(args: Record<string, unknown>, paths: Paths): ChatToolResult {
  const path = paths.resolve(args.path, "read");
  if (!existsSync(path)) return fail(`${paths.display(path)} does not exist.`);
  const text = readText(path);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
  const limit = Math.max(1, Math.floor(Number(args.limit) || READ_DEFAULT_LINES));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length).length;
  const body = slice.map((line, index) => `${String(offset + index).padStart(width)}\t${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}… [line cut]` : line}`).join("\n");
  const end = offset - 1 + slice.length;
  const header = `[${paths.display(path)}: lines ${slice.length ? offset : 0}–${end} of ${lines.length}${end < lines.length ? `; next offset ${end + 1}` : ""}]`;
  return ok(lines.length ? `${header}\n${body}` : `${header}\n(empty file)`);
}

function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { writeFileSync(path, content); return; }
    mode = stat.mode & 0o777;
  } catch {}
  const temp = `${path}.mausclaw-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, content, mode !== undefined ? { mode } : undefined);
  renameSync(temp, path);
}

function writeFileTool(args: Record<string, unknown>, paths: Paths): ChatToolResult {
  const path = paths.resolve(args.path, "write");
  if (existsSync(path) && statSync(path).isDirectory()) return fail(`${paths.display(path)} is a folder.`);
  const content = String(args.content ?? "");
  const existed = existsSync(path);
  writeAtomic(path, content);
  return ok(`${existed ? "Overwrote" : "Created"} ${paths.display(path)} (${Buffer.byteLength(content)} bytes, ${content.split("\n").length} lines).`);
}

const countOf = (text: string, needle: string) => {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
};

function editFileTool(args: Record<string, unknown>, paths: Paths): ChatToolResult {
  const path = paths.resolve(args.path, "write");
  if (!existsSync(path)) return fail(`${paths.display(path)} does not exist; create it with write_file.`);
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  if (!oldString) return fail("old_string must not be empty.");
  if (oldString === newString) return fail("old_string and new_string are the same; nothing to change.");
  const text = readText(path);
  const count = countOf(text, oldString);
  if (count === 0) {
    const trimmed = oldString.trim();
    const hint = trimmed && text.includes(trimmed) ? " The text exists with different surrounding whitespace; copy it exactly from read_file." : " Read the file again and copy the text exactly.";
    return fail(`old_string was not found in ${paths.display(path)}.${hint}`);
  }
  if (count > 1 && args.replace_all !== true) return fail(`old_string occurs ${count} times in ${paths.display(path)}; add surrounding lines to make it unique, or set replace_all.`);
  const next = args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
  writeAtomic(path, next);
  return ok(`Edited ${paths.display(path)}: replaced ${args.replace_all === true ? count : 1} occurrence${count === 1 || args.replace_all !== true ? "" : "s"}.`);
}

// ---------- apply_patch ----------

interface Hunk { oldStart: number; lines: string[] }
interface FilePatch { oldPath: string | null; newPath: string | null; hunks: Hunk[] }

const patchPath = (raw: string): string | null => {
  const path = raw.split("\t")[0]!.trim();
  if (path === "/dev/null") return null;
  return path.replace(/^[ab]\//, "");
};

export function parseUnifiedDiff(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      current = { oldPath: patchPath(line.slice(4)), newPath: patchPath(lines[i + 1]!.slice(4)), hunks: [] };
      files.push(current);
      hunk = null;
      i++;
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      if (!current) throw new Error("hunk before any ---/+++ file header");
      hunk = { oldStart: Number(header[1]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line === "" && i === lines.length - 1) continue;
    if (line[0] === " " || line[0] === "+" || line[0] === "-") hunk.lines.push(line);
    else if (line === "") hunk.lines.push(" ");
    else hunk = null;
  }
  if (!files.length) throw new Error("no ---/+++ file headers found; pass a unified diff");
  return files;
}

function applyHunks(original: string, hunks: Hunk[], label: string): string {
  const endsWithNewline = original.endsWith("\n");
  const lines = original === "" ? [] : (endsWithNewline ? original.slice(0, -1) : original).split("\n");
  let delta = 0;
  for (const [index, hunk] of hunks.entries()) {
    const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
    const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
    const expected = Math.max(0, hunk.oldStart - 1 + delta);
    const matches = (at: number) => at >= 0 && at + before.length <= lines.length && before.every((line, k) => lines[at + k] === line);
    let at = -1;
    if (before.length === 0) at = Math.min(expected, lines.length);
    else for (let distance = 0; distance <= lines.length; distance++) {
      if (matches(expected - distance)) { at = expected - distance; break; }
      if (matches(expected + distance)) { at = expected + distance; break; }
    }
    if (at < 0) throw new Error(`hunk ${index + 1} of ${label} does not match the file (context or removed lines differ); read the file and regenerate the patch`);
    lines.splice(at, before.length, ...after);
    delta += after.length - before.length + (at - expected);
  }
  return lines.length ? `${lines.join("\n")}${endsWithNewline || original === "" ? "\n" : ""}` : "";
}

function applyPatchTool(args: Record<string, unknown>, paths: Paths): ChatToolResult {
  const files = parseUnifiedDiff(String(args.patch ?? ""));
  const writes: Array<{ path: string; content: string | null; action: string }> = [];
  for (const file of files) {
    const target = file.newPath ?? file.oldPath;
    if (!target) throw new Error("a file patch names /dev/null on both sides");
    const path = paths.resolve(target, "write");
    if (file.oldPath === null) {
      if (existsSync(path)) throw new Error(`${target} already exists; patch it instead of creating it`);
      writes.push({ path, content: applyHunks("", file.hunks, target), action: "created" });
      continue;
    }
    const source = paths.resolve(file.oldPath, "write");
    if (!existsSync(source)) throw new Error(`${file.oldPath} does not exist`);
    if (file.newPath === null) { writes.push({ path: source, content: null, action: "deleted" }); continue; }
    const next = applyHunks(readText(source), file.hunks, file.oldPath);
    if (source !== path) writes.push({ path: source, content: null, action: "moved" });
    writes.push({ path, content: next, action: source !== path ? `moved from ${paths.display(source)}` : "updated" });
  }
  // Everything validated first: nothing is written unless every hunk applies.
  for (const write of writes) {
    if (write.content === null) unlinkSync(write.path);
    else writeAtomic(write.path, write.content);
  }
  return ok(`Patch applied:\n${writes.filter((write) => write.action !== "moved").map((write) => `- ${paths.display(write.path)} (${write.action})`).join("\n")}`);
}

// ---------- grep / glob / list ----------

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) { out += "\\{"; continue; }
      out += `(?:${pattern.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
      i = end;
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function* walk(dir: string, signal?: AbortSignal): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* walk(full, signal); }
    else if (entry.isFile()) yield full;
  }
}

let rgPath: string | null | undefined;
function ripgrep(): string | null {
  if (process.env.MAUSCLAW_NO_RG === "1") return null;
  if (rgPath !== undefined) return rgPath;
  const probe = spawnSync("rg", ["--version"], { encoding: "utf8" });
  return (rgPath = probe.status === 0 ? "rg" : null);
}

async function grepTool(args: Record<string, unknown>, paths: Paths, signal: AbortSignal): Promise<ChatToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return fail("grep needs a pattern.");
  const target = paths.resolve(args.path, "read", paths.root);
  if (!existsSync(target)) return fail(`${paths.display(target)} does not exist.`);
  const max = Math.min(5_000, Math.max(1, Math.floor(Number(args.max_results) || GREP_MAX_LINES)));
  const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
  const rel = (file: string) => paths.display(file);
  const rg = ripgrep();
  let lines: string[] = [];
  if (rg) {
    const inside = relative(paths.root, target);
    const spelled = inside === "" ? "." : !inside.startsWith("..") && !isAbsolute(inside) ? inside : target;
    const rgArgs = ["-n", "--no-heading", "--with-filename", "--color", "never", "--max-columns", "400", ...[...SKIP_DIRS].flatMap((dir) => ["--glob", `!${dir}`]),
      ...(args.ignore_case === true ? ["-i"] : []), ...(glob ? ["--glob", glob] : []), "-e", pattern, "--", spelled];
    const result = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const child = spawn(rg, rgArgs, { cwd: paths.root, stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = ""; let count = 0;
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (count > max) return;
        out += chunk;
        count += chunk.split("\n").length - 1;
        if (count > max) child.kill();
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => done({ code: 2, out, err: error.message }));
      child.once("close", (code) => { signal.removeEventListener("abort", onAbort); done({ code, out, err }); });
    });
    if (result.code === 2 && !result.out) return fail(`grep failed: ${result.err.trim().slice(0, 500)}`);
    lines = result.out.split("\n").filter(Boolean).map((line) => line.startsWith("./") ? line.slice(2) : line);
  } else {
    let regex: RegExp;
    try { regex = new RegExp(pattern, args.ignore_case === true ? "i" : ""); } catch (error) { return fail(`invalid pattern: ${(error as Error).message}`); }
    const matcher = glob ? globToRegExp(glob.includes("/") ? glob : `**/${glob}`) : null;
    const files = statSync(target).isFile() ? [target] : walk(target, signal);
    outer: for (const file of files) {
      if (matcher && !matcher.test(relative(target, file).split(sep).join("/"))) continue;
      let text: string;
      try { const buffer = readFileSync(file); if (buffer.length > READ_MAX_BYTES || isBinary(buffer)) continue; text = buffer.toString("utf8"); } catch { continue; }
      const rows = text.split("\n");
      for (let i = 0; i < rows.length; i++) {
        if (regex.test(rows[i]!)) {
          lines.push(`${rel(file)}:${i + 1}:${rows[i]!.slice(0, 400)}`);
          if (lines.length > max) break outer;
        }
      }
    }
  }
  if (!lines.length) return ok("No matches.");
  const more = lines.length > max;
  return ok(lines.slice(0, max).join("\n") + (more ? `\n[… more matches not shown; narrow the pattern, path or glob]` : ""));
}

function globTool(args: Record<string, unknown>, paths: Paths, signal: AbortSignal): ChatToolResult {
  const pattern = String(args.pattern ?? "").replace(/^\.\//, "");
  if (!pattern) return fail("glob needs a pattern.");
  const base = paths.resolve(args.path, "read", paths.root);
  if (!existsSync(base) || !statSync(base).isDirectory()) return fail(`${paths.display(base)} is not a folder.`);
  const matcher = globToRegExp(pattern);
  const found: Array<{ path: string; mtime: number }> = [];
  let truncated = false;
  for (const file of walk(base, signal)) {
    if (!matcher.test(relative(base, file).split(sep).join("/"))) continue;
    if (found.length >= GLOB_MAX) { truncated = true; break; }
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch {}
    found.push({ path: file, mtime });
  }
  if (!found.length) return ok("No files match.");
  found.sort((a, b) => b.mtime - a.mtime);
  return ok(found.map((entry) => paths.display(entry.path)).join("\n") + (truncated ? `\n[… stopped at ${GLOB_MAX} files; narrow the pattern]` : ""));
}

function listDirTool(args: Record<string, unknown>, paths: Paths): ChatToolResult {
  const base = paths.resolve(args.path, "read", paths.root);
  if (!existsSync(base) || !statSync(base).isDirectory()) return fail(`${paths.display(base)} is not a folder.`);
  const depth = Math.min(4, Math.max(1, Math.floor(Number(args.depth) || 1)));
  const out: string[] = [];
  const visit = (dir: string, level: number, indent: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= LIST_MAX) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${indent}${entry.name}/`);
        if (level < depth && !SKIP_DIRS.has(entry.name)) visit(full, level + 1, `${indent}  `);
      } else if (entry.isSymbolicLink()) out.push(`${indent}${entry.name} -> (link)`);
      else {
        let size = 0;
        try { size = statSync(full).size; } catch {}
        out.push(`${indent}${entry.name} (${size} B)`);
      }
    }
  };
  visit(base, 1, "");
  return ok(`[${paths.display(base) || "."}]\n${out.length ? out.join("\n") : "(empty folder)"}${out.length >= LIST_MAX ? `\n[… stopped at ${LIST_MAX} entries]` : ""}`);
}

/** Runs one workspace tool. Errors (bad path, unmatched edit) come back as ok:false results, never throws. */
export async function executeWorkspaceTool(name: string, args: Record<string, unknown>, config: WorkspaceToolsConfig, signal: AbortSignal): Promise<ChatToolResult> {
  const paths = createWorkspacePaths(config);
  try {
    if (!existsSync(paths.root)) mkdirSync(paths.root, { recursive: true });
    if (GIT_TOOLS.has(name)) return await executeGitTool(name, args, (input, mode) => paths.resolve(input, mode), paths.root, signal);
    switch (name) {
      case SHELL_TOOL: return await runShell(args, paths, signal);
      case "read_file": return readFileTool(args, paths);
      case "write_file": return writeFileTool(args, paths);
      case "edit_file": return editFileTool(args, paths);
      case "apply_patch": return applyPatchTool(args, paths);
      case "grep": return await grepTool(args, paths, signal);
      case "glob": return globTool(args, paths, signal);
      case "list_dir": return listDirTool(args, paths);
      case "web_fetch": case "web_search":
        if (config.web === false) return fail(`${name} is off for this bot.`);
        return await executeWebTool(name, args, signal, config.webOptions);
      default: return fail(`Unknown workspace tool ${name}.`);
    }
  } catch (error) {
    return fail(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Skill folders a turn's prompt names (`Read "/abs/…/SKILL.md"`): readable, never writable, so skills work under confinement. */
export function skillReadRoots(...texts: Array<string | undefined>): string[] {
  const roots = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(/Read ("(?:[^"\\]|\\.)*\/SKILL\.md")/g)) {
      try {
        const file = JSON.parse(match[1]!) as string;
        if (isAbsolute(file)) roots.add(dirname(file));
      } catch {}
    }
  }
  return [...roots];
}

export const WORKSPACE_TOOLS_PROMPT = "\n\nYou have workspace tools that run directly on this computer: shell, read_file, write_file, edit_file, apply_patch, grep, glob, list_dir, " +
  "git_status, git_diff, git_log, git_commit (never pushes), web_fetch and web_search. They are confined to your workspace folder (plus the skill folders named here, read-only); " +
  "this is path confinement, not an OS sandbox: shell commands run as the server's user. " +
  "Relative paths resolve against your workspace folder. Read before you edit, prefer edit_file/apply_patch over rewriting whole files, " +
  "and check your work (run the tests or the command) before you report it done. Independent reads can go in one response as several tool calls; they run in parallel.";

