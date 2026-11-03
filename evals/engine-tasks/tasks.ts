// Engine task eval: small, realistic tool-using tasks for the native engine's workspace tools (shell, files,
// patch). Each task seeds a temp workspace and has an automatic checker; no human or model judgment.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EngineTaskCheck { pass: boolean; why: string }
export interface EngineTask {
  id: string;
  prompt: string;
  files: Record<string, string>;
  check(dir: string): EngineTaskCheck;
  /** A known-good end state, used by the harness's own test to prove each checker accepts a correct fix. */
  solution: Record<string, string>;
  /** "basic" (the first five) or "hard". */
  suite?: "basic" | "hard";
  /** Pages served on a loopback HTTP server for the turn; the prompt's {{WEB}} becomes its origin (offline web lookup). */
  web?: Record<string, string>;
  /** A skill the bot is told about (outside the workspace), listed in the system prompt the way the server lists one. */
  skill?: { name: string; description: string; body: string };
  /** Forces a small per-turn context budget (tokens) so the engine has to compact mid-turn. */
  compactAt?: number;
}

const node = (dir: string, ...args: string[]): { ok: boolean; out: string } => {
  try { return { ok: true, out: execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { const e = error as { stdout?: string; stderr?: string }; return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};
const read = (dir: string, file: string) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null;
const unchanged = (dir: string, files: Record<string, string>, names: string[]) => names.find((name) => read(dir, name) !== files[name]);
const pass = (why = "ok"): EngineTaskCheck => ({ pass: true, why });
const fail = (why: string): EngineTaskCheck => ({ pass: false, why: why.slice(0, 300) });

const MEDIAN_TEST = `import assert from "node:assert/strict";
import { median } from "./stats.js";
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([5, 1, 4, 2]), 3);
assert.equal(median([7]), 7);
assert.equal(median([10, -2, 4, 4]), 4);
console.log("stats ok");
`;
const fixFunction: EngineTask = {
  id: "fix-function",
  prompt: "The test `node stats.test.mjs` fails. Fix the bug in stats.js so the test passes. Do not change the test file. Run the test to confirm.",
  files: {
    "package.json": '{ "type": "module" }\n',
    "stats.js": "export function median(xs) {\n  const mid = Math.floor(xs.length / 2);\n  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;\n}\n",
    "stats.test.mjs": MEDIAN_TEST,
  },
  check(dir) {
    const bad = unchanged(dir, this.files, ["stats.test.mjs"]);
    if (bad) return fail(`${bad} was modified`);
    const run = node(dir, "stats.test.mjs");
    return run.ok && run.out.includes("stats ok") ? pass() : fail(`test still fails: ${run.out}`);
  },
  solution: { "stats.js": "export function median(input) {\n  const xs = [...input].sort((a, b) => a - b);\n  const mid = Math.floor(xs.length / 2);\n  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;\n}\n" },
};

const bugFromLog: EngineTask = {
  id: "bug-from-log",
  prompt: "Our service crashes on start; the error is in error.log. Find the root cause in the code and fix it so `node app.js` prints the listening line. config.json is correct and must not be changed.",
  files: {
    "config.json": '{ "server": { "host": "127.0.0.1", "port": 8080 }, "debug": false }\n',
    "app.js": "const { readFileSync } = require(\"node:fs\");\nfunction loadConfig() {\n  const cfg = JSON.parse(readFileSync(__dirname + \"/config.json\", \"utf8\"));\n  return { host: cfg.srv.host, port: cfg.srv.port };\n}\nconst { host, port } = loadConfig();\nconsole.log(`listening on ${host}:${port}`);\n",
    "error.log": "2026-10-30T21:04:11Z app starting\nTypeError: Cannot read properties of undefined (reading 'host')\n    at loadConfig (app.js:4:28)\n    at Object.<anonymous> (app.js:6:24)\n",
  },
  check(dir) {
    const bad = unchanged(dir, this.files, ["config.json"]);
    if (bad) return fail(`${bad} was modified`);
    const run = node(dir, "app.js");
    return run.ok && run.out.trim() === "listening on 127.0.0.1:8080" ? pass() : fail(`app output: ${run.out}`);
  },
  solution: { "app.js": "const { readFileSync } = require(\"node:fs\");\nfunction loadConfig() {\n  const cfg = JSON.parse(readFileSync(__dirname + \"/config.json\", \"utf8\"));\n  return { host: cfg.server.host, port: cfg.server.port };\n}\nconst { host, port } = loadConfig();\nconsole.log(`listening on ${host}:${port}`);\n" },
};

const renameFiles = {
  "users.js": "function getUserName(user) {\n  return `${user.first} ${user.last}`;\n}\nmodule.exports = { getUserName };\n",
  "greet.js": "const { getUserName } = require(\"./users.js\");\nmodule.exports = (user) => `Hello, ${getUserName(user)}!`;\n",
  "main.js": "const { getUserName } = require(\"./users.js\");\nconst greet = require(\"./greet.js\");\nconst ada = { first: \"Ada\", last: \"Lovelace\" };\nconsole.log(getUserName(ada));\nconsole.log(greet(ada));\n",
};
const renameSymbol: EngineTask = {
  id: "rename-symbol",
  prompt: "Rename the function getUserName to fullName everywhere in this project (users.js, greet.js, main.js), including its export and imports. Behaviour must not change; check with `node main.js`.",
  files: renameFiles,
  check(dir) {
    for (const name of Object.keys(renameFiles)) {
      const text = read(dir, name) ?? "";
      if (text.includes("getUserName")) return fail(`${name} still mentions getUserName`);
      if (!text.includes("fullName")) return fail(`${name} does not use fullName`);
    }
    const run = node(dir, "main.js");
    return run.ok && run.out === "Ada Lovelace\nHello, Ada Lovelace!\n" ? pass() : fail(`main.js output: ${run.out}`);
  },
  solution: Object.fromEntries(Object.entries(renameFiles).map(([name, text]) => [name, text.replaceAll("getUserName", "fullName")])),
};

const HIDDEN_SLUG_CHECK = `import assert from "node:assert/strict";
import { slugify } from "./slugify.js";
assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  Trim  me  "), "trim-me");
assert.equal(slugify("Rock & Roll!"), "rock-roll");
assert.equal(slugify("a--b__c"), "a-b-c");
assert.equal(slugify("Café 2026"), "cafe-2026");
assert.equal(slugify(""), "");
console.log("slug ok");
`;
const createFile: EngineTask = {
  id: "create-file",
  prompt: "Create slugify.js (ES module) exporting slugify(text): lowercase; strip accents (é→e); every run of characters that are not a-z or 0-9 becomes one '-'; no leading or trailing '-'; empty input gives ''. Write a quick check of your own and run it with node.",
  files: { "package.json": '{ "type": "module" }\n' },
  check(dir) {
    if (!existsSync(join(dir, "slugify.js"))) return fail("slugify.js missing");
    const probe = join(dir, ".hidden-slug-check.mjs");
    writeFileSync(probe, HIDDEN_SLUG_CHECK);
    const run = node(dir, ".hidden-slug-check.mjs");
    return run.ok && run.out.includes("slug ok") ? pass() : fail(`hidden check: ${run.out}`);
  },
  solution: { "slugify.js": "export function slugify(text) {\n  return text.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\").toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n}\n" },
};

const SALES = "date,region,product,units,price\n2026-10-01,north,widget,3,2.50\n2026-10-01,south,gadget,1,10.00\n2026-10-02,north,gadget,2,10.00\n2026-10-02,east,widget,10,2.50\n2026-10-03,south,widget,4,2.50\n2026-10-03,east,gizmo,1,99.99\n";
const csvTransform: EngineTask = {
  id: "csv-transform",
  prompt: "Read sales.csv and write totals.json: an array of { region, revenue } (revenue = sum of units*price, rounded to 2 decimals) for every region, sorted by revenue descending. Then print totals.json to confirm.",
  files: { "sales.csv": SALES },
  check(dir) {
    const text = read(dir, "totals.json");
    if (text === null) return fail("totals.json missing");
    let data: unknown;
    try { data = JSON.parse(text); } catch { return fail("totals.json is not JSON"); }
    const want = [{ region: "east", revenue: 124.99 }, { region: "south", revenue: 20 }, { region: "north", revenue: 27.5 }]
      .sort((a, b) => b.revenue - a.revenue);
    const got = Array.isArray(data) ? data.map((row) => ({ region: (row as { region?: unknown }).region, revenue: Number((row as { revenue?: unknown }).revenue) })) : null;
    return JSON.stringify(got) === JSON.stringify(want) ? pass() : fail(`totals.json = ${text.slice(0, 200)}`);
  },
  solution: { "totals.json": JSON.stringify([{ region: "east", revenue: 124.99 }, { region: "north", revenue: 27.5 }, { region: "south", revenue: 20 }]) },
};



// ---------- hard suite ----------

const PRICES = { "cart.js": "function cartTotal(items) {\n  const sub = items.reduce((s, i) => s + i.price * i.qty, 0);\n  return Math.round(sub * 1.11 * 100) / 100;\n}\nmodule.exports = { cartTotal };\n",
  "invoice.js": "function invoiceTotal(lines) {\n  let sub = 0;\n  for (const l of lines) sub += l.amount;\n  return Math.round(sub * 1.11 * 100) / 100;\n}\nmodule.exports = { invoiceTotal };\n",
  "quote.js": "function quoteTotal(base, extras) {\n  const sub = base + extras.reduce((a, b) => a + b, 0);\n  return Math.round(sub * 1.11 * 100) / 100;\n}\nmodule.exports = { quoteTotal };\n",
  "main.js": "const { cartTotal } = require(\"./cart.js\");\nconst { invoiceTotal } = require(\"./invoice.js\");\nconst { quoteTotal } = require(\"./quote.js\");\nconsole.log(cartTotal([{ price: 10, qty: 3 }]), invoiceTotal([{ amount: 99.99 }]), quoteTotal(50, [5, 5]));\n" };
const multiFileRefactor: EngineTask = {
  id: "multi-refactor", suite: "hard",
  prompt: "cart.js, invoice.js and quote.js each repeat the same 11% tax-and-round logic. Extract it into lib/tax.js exporting withTax(subtotal) and make all three files use it (no file but lib/tax.js may contain 1.11). Output of `node main.js` must not change.",
  files: PRICES,
  check(dir) {
    const tax = read(dir, "lib/tax.js");
    if (!tax || !tax.includes("1.11")) return fail("lib/tax.js missing or has no 1.11");
    for (const name of ["cart.js", "invoice.js", "quote.js"]) {
      const text = read(dir, name) ?? "";
      if (text.includes("1.11")) return fail(`${name} still has its own 1.11`);
      if (!/lib\/tax/.test(text)) return fail(`${name} does not use lib/tax.js`);
    }
    const run = node(dir, "main.js");
    return run.ok && run.out.trim() === "33.3 110.99 66.6" ? pass() : fail(`main.js output: ${run.out}`);
  },
  solution: { "lib/tax.js": "exports.withTax = (sub) => Math.round(sub * 1.11 * 100) / 100;\n",
    "cart.js": "const { withTax } = require(\"./lib/tax.js\");\nfunction cartTotal(items) { return withTax(items.reduce((s, i) => s + i.price * i.qty, 0)); }\nmodule.exports = { cartTotal };\n",
    "invoice.js": "const { withTax } = require(\"./lib/tax.js\");\nfunction invoiceTotal(lines) { return withTax(lines.reduce((s, l) => s + l.amount, 0)); }\nmodule.exports = { invoiceTotal };\n",
    "quote.js": "const { withTax } = require(\"./lib/tax.js\");\nfunction quoteTotal(base, extras) { return withTax(base + extras.reduce((a, b) => a + b, 0)); }\nmodule.exports = { quoteTotal };\n" },
};

const PAGE_TEST = `const assert = require("node:assert/strict");
const { paginate } = require("./paginate.js");
const items = Array.from({ length: 23 }, (_, i) => i + 1);
assert.deepEqual(paginate(items, 1, 10), { page: 1, pages: 3, items: [1,2,3,4,5,6,7,8,9,10] });
assert.deepEqual(paginate(items, 3, 10), { page: 3, pages: 3, items: [21,22,23] });
assert.deepEqual(paginate(items, 9, 10), { page: 3, pages: 3, items: [21,22,23] });
assert.deepEqual(paginate([], 1, 10), { page: 1, pages: 1, items: [] });
console.log("paginate ok");
`;
const failingTest: EngineTask = {
  id: "failing-test", suite: "hard",
  prompt: "`node paginate.test.js` fails. Find and fix the bugs in paginate.js (pages are 1-based; a page past the end clamps to the last page; an empty list has one empty page). Do not edit the test. Run it to confirm.",
  files: { "paginate.js": "function paginate(items, page, size) {\n  const pages = Math.floor(items.length / size);\n  const start = page * size;\n  return { page, pages, items: items.slice(start, start + size) };\n}\nmodule.exports = { paginate };\n", "paginate.test.js": PAGE_TEST },
  check(dir) {
    if (unchanged(dir, this.files, ["paginate.test.js"])) return fail("test file modified");
    const run = node(dir, "paginate.test.js");
    return run.ok && run.out.includes("paginate ok") ? pass() : fail(`test: ${run.out}`);
  },
  solution: { "paginate.js": "function paginate(items, page, size) {\n  const pages = Math.max(1, Math.ceil(items.length / size));\n  const p = Math.min(Math.max(1, page), pages);\n  const start = (p - 1) * size;\n  return { page: p, pages, items: items.slice(start, start + size) };\n}\nmodule.exports = { paginate };\n" },
};

const DIFF = "--- a/server.js\n+++ b/server.js\n@@ -1,5 +1,6 @@\n const PORT = 3000;\n-const HOST = \"0.0.0.0\";\n+const HOST = \"127.0.0.1\";\n+const TIMEOUT_MS = 5000;\n function describe() {\n-  return `${HOST}:${PORT}`;\n+  return `${HOST}:${PORT} (timeout ${TIMEOUT_MS}ms)`;\n }\n";
const SERVER = "const PORT = 3000;\nconst HOST = \"0.0.0.0\";\nfunction describe() {\n  return `${HOST}:${PORT}`;\n}\nmodule.exports = { describe };\n";
const applyDiff: EngineTask = {
  id: "apply-diff", suite: "hard",
  prompt: "A reviewer left change.diff. Apply exactly that change to server.js (use your patch tool) and leave change.diff in place. Show `node -e \"console.log(require('./server.js').describe())\"`.",
  files: { "server.js": SERVER, "change.diff": DIFF },
  check(dir) {
    if (read(dir, "change.diff") !== DIFF) return fail("change.diff was changed or removed");
    const want = SERVER.replace("\"0.0.0.0\";\n", "\"127.0.0.1\";\nconst TIMEOUT_MS = 5000;\n").replace("${HOST}:${PORT}`", "${HOST}:${PORT} (timeout ${TIMEOUT_MS}ms)`");
    return read(dir, "server.js") === want ? pass() : fail(`server.js = ${read(dir, "server.js")}`);
  },
  get solution() { return { "server.js": SERVER.replace("\"0.0.0.0\";\n", "\"127.0.0.1\";\nconst TIMEOUT_MS = 5000;\n").replace("${HOST}:${PORT}`", "${HOST}:${PORT} (timeout ${TIMEOUT_MS}ms)`") }; },
};

const logLines = (seed: number, n: number, needle?: { at: number; line: string }) => Array.from({ length: n }, (_, i) =>
  needle && i === needle.at ? needle.line : `2026-10-31T0${seed}:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${(i * 7 + seed) % 13} handled request req-${seed}${String(i).padStart(5, "0")} in ${(i * 37) % 900}ms`).join("\n") + "\n";
const longContext: EngineTask = {
  id: "long-context", suite: "hard", compactAt: 12_000,
  prompt: "logs/a.log, logs/b.log and logs/c.log are large. Read each one in full with read_file, one file per step (no grep, no shell), and find the single ERROR line across them. Write its request id (like req-XXXXXX) to answer.txt.",
  files: { "logs/a.log": logLines(1, 300), "logs/b.log": logLines(2, 300, { at: 211, line: "2026-10-31T02:11:00Z ERROR worker-4 failed request req-2-77731: upstream reset" }), "logs/c.log": logLines(3, 300) },
  check(dir) {
    const text = read(dir, "answer.txt");
    return text?.trim() === "req-2-77731" ? pass() : fail(`answer.txt = ${text}`);
  },
  solution: { "answer.txt": "req-2-77731\n" },
};

const services = ["auth", "billing", "search", "mail", "media", "queue"];
const parallelReads: EngineTask = {
  id: "parallel-reads", suite: "hard",
  prompt: "Each file in services/ is a JSON config. Read them all (in parallel if you can) and write ports.json: an object mapping each service name to its port, sorted by port ascending.",
  files: Object.fromEntries(services.map((name, i) => [`services/${name}.json`, JSON.stringify({ name, port: 9100 - i * 13 + (i % 2) * 40, replicas: i + 1 }, null, 2)])),
  check(dir) {
    const text = read(dir, "ports.json");
    if (!text) return fail("ports.json missing");
    let got: Record<string, number>;
    try { got = JSON.parse(text) as Record<string, number>; } catch { return fail("ports.json is not JSON"); }
    const want = Object.fromEntries(services.map((name, i) => [name, 9100 - i * 13 + (i % 2) * 40] as const).sort((a, b) => a[1] - b[1]));
    return JSON.stringify(got) === JSON.stringify(want) ? pass() : fail(`ports.json = ${text.slice(0, 200)}`);
  },
  get solution() { return { "ports.json": JSON.stringify(Object.fromEntries(services.map((name, i) => [name, 9100 - i * 13 + (i % 2) * 40] as const).sort((a, b) => a[1] - b[1]))) }; },
};

const webLookup: EngineTask = {
  id: "web-lookup", suite: "hard",
  prompt: "Our package.json pins left-pad to an old version. Look up the latest stable version on the release page {{WEB}}/releases (use web_fetch) and set dependencies.left-pad in package.json to exactly that version (no ^ or ~). Do not change anything else.",
  files: { "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.0.0", lodash: "4.17.21" } }, null, 2) + "\n" },
  web: { "/releases": "<html><body><h1>left-pad releases</h1><ul><li>2.1.0-beta.2 (pre-release)</li><li><b>2.0.3</b> latest stable</li><li>2.0.2</li><li>1.3.0</li></ul></body></html>" },
  check(dir) {
    let data: { name?: string; version?: string; dependencies?: Record<string, string> };
    try { data = JSON.parse(read(dir, "package.json") ?? "") as typeof data; } catch { return fail("package.json is not JSON"); }
    if (data.dependencies?.["left-pad"] !== "2.0.3") return fail(`left-pad = ${data.dependencies?.["left-pad"]}`);
    return data.dependencies.lodash === "4.17.21" && data.version === "1.0.0" ? pass() : fail("something else changed");
  },
  solution: { "package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "2.0.3", lodash: "4.17.21" } }, null, 2) + "\n" },
};

const skillUse: EngineTask = {
  id: "skill-use", suite: "hard",
  prompt: "Add a CHANGELOG entry for the fix in issue #42: crash on empty input. Follow our changelog skill.",
  files: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n## 1.2.0\n- [feat] dark mode (#37)\n" },
  skill: { name: "changelog", description: "How to write CHANGELOG.md entries in this repo.",
    body: "# Changelog entries\n\nPut new entries directly under `## Unreleased`, one line each, exactly in this form:\n\n`- [TYPE] lower-case summary (#ISSUE)`\n\nTYPE is one of feat, fix, docs, chore. No trailing period.\n" },
  check(dir) {
    const text = read(dir, "CHANGELOG.md") ?? "";
    return text === "# Changelog\n\n## Unreleased\n- [fix] crash on empty input (#42)\n\n## 1.2.0\n- [feat] dark mode (#37)\n"
      || text === "# Changelog\n\n## Unreleased\n\n- [fix] crash on empty input (#42)\n\n## 1.2.0\n- [feat] dark mode (#37)\n" ? pass() : fail(`CHANGELOG.md = ${text}`);
  },
  solution: { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n- [fix] crash on empty input (#42)\n\n## 1.2.0\n- [feat] dark mode (#37)\n" },
};

const ASYNC_TEST = `const assert = require("node:assert/strict");
const { loadAll } = require("./loader.js");
loadAll(["a", "b", "c"]).then((out) => { assert.deepEqual(out, ["A", "B", "C"]); console.log("loader ok"); }, (e) => { console.error(e); process.exit(1); });
`;
const asyncBug: EngineTask = {
  id: "async-bug", suite: "hard",
  prompt: "`node loader.test.js` fails intermittently/always. Fix loader.js so results come back complete and in input order. Do not edit the test.",
  files: { "loader.js": "const fetchOne = (k) => new Promise((r) => setTimeout(() => r(k.toUpperCase()), (3 - k.charCodeAt(0) % 3) * 10));\nasync function loadAll(keys) {\n  const out = [];\n  keys.forEach(async (k) => { out.push(await fetchOne(k)); });\n  return out;\n}\nmodule.exports = { loadAll };\n", "loader.test.js": ASYNC_TEST },
  check(dir) {
    if (unchanged(dir, this.files, ["loader.test.js"])) return fail("test modified");
    const run = node(dir, "loader.test.js");
    return run.ok && run.out.includes("loader ok") ? pass() : fail(`test: ${run.out}`);
  },
  solution: { "loader.js": "const fetchOne = (k) => new Promise((r) => setTimeout(() => r(k.toUpperCase()), (3 - k.charCodeAt(0) % 3) * 10));\nasync function loadAll(keys) {\n  return Promise.all(keys.map(fetchOne));\n}\nmodule.exports = { loadAll };\n" },
};

const cliFlag: EngineTask = {
  id: "cli-flag", suite: "hard",
  prompt: "count.js prints word counts of a file as text lines. Add a --json flag: `node count.js words.txt --json` prints one JSON object {word: count} with keys sorted alphabetically. Without the flag the output must stay exactly as it is now.",
  files: { "words.txt": "b a c a b a\n", "count.js": "const { readFileSync } = require(\"node:fs\");\nconst file = process.argv[2];\nconst counts = {};\nfor (const w of readFileSync(file, \"utf8\").split(/\\s+/).filter(Boolean)) counts[w] = (counts[w] || 0) + 1;\nfor (const [w, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) console.log(`${w} ${n}`);\n" },
  check(dir) {
    const text = node(dir, "count.js", "words.txt");
    if (!text.ok || text.out !== "a 3\nb 2\nc 1\n") return fail(`plain output changed: ${text.out}`);
    const json = node(dir, "count.js", "words.txt", "--json");
    try { return json.ok && JSON.stringify(JSON.parse(json.out)) === '{"a":3,"b":2,"c":1}' ? pass() : fail(`json output: ${json.out}`); }
    catch { return fail(`json output: ${json.out}`); }
  },
  solution: { "count.js": "const { readFileSync } = require(\"node:fs\");\nconst file = process.argv[2];\nconst counts = {};\nfor (const w of readFileSync(file, \"utf8\").split(/\\s+/).filter(Boolean)) counts[w] = (counts[w] || 0) + 1;\nif (process.argv.includes(\"--json\")) { console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))))); }\nelse for (const [w, n] of Object.entries(counts).sort((x, y) => y[1] - x[1])) console.log(`${w} ${n}`);\n" },
};

const INI = "; app settings\n[server]\nport = 8080\nhost = example.internal\ndebug = false\n\n[cache]\nttl_seconds = 300\nenabled = true\nname = \"main cache\"\n";
const iniToJson: EngineTask = {
  id: "ini-to-json", suite: "hard",
  prompt: "Convert config.ini to config.json: one object per section; numbers become JSON numbers, true/false become booleans, quoted strings lose their quotes, comments are dropped. Keep config.ini.",
  files: { "config.ini": INI },
  check(dir) {
    if (read(dir, "config.ini") !== INI) return fail("config.ini changed");
    let got: unknown;
    try { got = JSON.parse(read(dir, "config.json") ?? ""); } catch { return fail("config.json missing or not JSON"); }
    const want = { server: { port: 8080, host: "example.internal", debug: false }, cache: { ttl_seconds: 300, enabled: true, name: "main cache" } };
    return JSON.stringify(got) === JSON.stringify(want) ? pass() : fail(`config.json = ${JSON.stringify(got).slice(0, 200)}`);
  },
  solution: { "config.json": JSON.stringify({ server: { port: 8080, host: "example.internal", debug: false }, cache: { ttl_seconds: 300, enabled: true, name: "main cache" } }) },
};

export const ENGINE_TASKS: EngineTask[] = [fixFunction, bugFromLog, renameSymbol, createFile, csvTransform,
  multiFileRefactor, failingTest, applyDiff, longContext, parallelReads, webLookup, skillUse, asyncBug, cliFlag, iniToJson];
