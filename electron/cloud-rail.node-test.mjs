import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { parseCloudList } from "./cloud-list.mjs";
import { addCloudView, createAddedCloudNotice, hostedCloudOrigin, installCloudRail, railPlaces } from "./cloud-rail.mjs";
import { otherCloudSnapshot } from "./cloud-plan-ipc.mjs";

const HOME = "https://mausclaw-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://mausclaw-c-a.fly.dev", TEAM = "https://mausclaw-t-acme.fly.dev", VPS = "https://bots.example.test", OWN = "https://mini.tail1234.ts.net";
const LOCAL = "http://127.0.0.1:8799";
const entry = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A,
  teamId: null, primary: false, ...over });
const PRIMARY = entry({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true });
const saved = (activeId = "home", extra = []) => ({ activeId, environments: [
  { id: "home", kind: "remote", name: "Studio", origin: HOME, home: true, color: "purple" },
  { id: "vps", kind: "remote", name: "Office", origin: VPS },
  { id: "acme", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role: "member" } },
  { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, color: "teal", cloud: { id: "c-a", role: "owner" } },
  { id: "lab", kind: "local", name: "Lab", dataDir: "/Users/person/lab" },
  ...extra,
] });
const session = (over = {}) => ({ status: "connected", account: { id: "acct-1" }, machine: { status: "ready", origin: HOME },
  teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }],
  clouds: parseCloudList([PRIMARY, entry(), entry({ id: "c-team", name: "Acme", color: "amber", teamId: "team-acme", role: "member", origin: TEAM })]), ...over });

test("the rail: My Cloud, the person's Clouds and teams' Clouds in the session's order, then servers saved by hand; names, colours and states, never an address", () => {
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session() });
  assert.deepEqual(places, [
    { id: "home", name: "Studio", color: "purple", kind: "cloud", opens: true, active: true },
    { id: "a", name: "Client A", color: "teal", kind: "cloud", opens: true },
    { id: "acme", name: "Acme", color: "yellow", kind: "team", opens: true },
    { id: "vps", name: "Office", color: null, kind: "server", opens: true },
  ]);
  for (const origin of [HOME, CLIENT_A, TEAM, VPS, "/Users/person/lab"]) assert.equal(JSON.stringify(places).includes(origin), false, origin);
  const before = railPlaces({ saved: saved("local"), home: null, mine: HOME, state: session() });
  assert.deepEqual(before[0], { id: "local", name: "This computer", color: null, kind: "computer", opens: true, active: true }, "before the move, this computer is a place too");
  assert.equal(before.length, 5);
});

test("one place, or none: no rail, the window as it was", () => {
  const alone = { activeId: "home", environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }] };
  assert.deepEqual(railPlaces({ saved: alone, home: HOME, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY]) }) }), []);
  assert.deepEqual(railPlaces({ saved: alone, home: null, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY]) }) }), [], "this computer and My Cloud are still one Cloud");
  assert.deepEqual(railPlaces({ saved: { activeId: "local", environments: [] }, state: null }), []);
  const two = railPlaces({ saved: { activeId: "home", environments: [alone.environments[0], { id: "vps", kind: "remote", name: "Office", origin: VPS }] }, home: HOME, mine: HOME, state: null });
  assert.deepEqual(two.map(place => place.id), ["home", "vps"], "a server saved by hand is a place");
});

test("a Cloud being set up shows how far it is, one at checkout waits, one the Admin is still making is shown but not opened, and a payment problem needs its owner", () => {
  const clouds = parseCloudList([PRIMARY, entry({ status: "setting_up", setup: { progress: 0.4 } }), entry({ id: "c-b", name: "Client B", color: "violet", status: "checkout", origin: null }),
    entry({ id: "c-c", name: "Client C", status: "setting_up", origin: null, setup: { step: "storage" } }), entry({ id: "c-team", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM, status: "payment_problem" })]);
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds }) });
  assert.deepEqual(places.find(place => place.id === "a"), { id: "a", name: "Client A", color: "teal", kind: "cloud", opens: true, progress: 0.4 });
  assert.deepEqual(places.slice(-2), [
    { id: "pending:c-b", name: "Client B", color: "purple", kind: "cloud", opens: false, progress: 0, waiting: true },
    { id: "pending:c-c", name: "Client C", color: "teal", kind: "cloud", opens: false, progress: 0.4 },
  ]);
  assert.equal(places.find(place => place.id === "acme").attention, undefined, "a member can't fix a team's payment");
  const owner = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: parseCloudList([PRIMARY, entry({ status: "payment_problem" })]) }) });
  assert.equal(owner.find(place => place.id === "a").attention, true);
  const older = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: undefined, machine: { status: "payment-problem", origin: HOME } }) });
  assert.equal(older.find(place => place.id === "home").attention, true, "an older Admin: My Cloud's own word");
  const settingUp = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: undefined, teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "provisioning", origin: TEAM, setup: { step: "starting" } } }] }) });
  assert.equal(settingUp.find(place => place.id === "acme").progress, 0.65);
});

test("a server of the person's own that signed in with their account: one saved here is that place, online or not; one not connected yet shows how; one only on its own network opens nothing", () => {
  const RENDER = "https://render.example.test";
  const clouds = parseCloudList([PRIMARY, entry(),
    entry({ id: "s-mini", name: "Mac mini", color: null, tier: null, runsOn: "server", managed: false, status: "offline", origin: null, lastSeenAt: 1_761_000_000_000 }),
    entry({ id: "s-office", name: "Office box", color: null, tier: null, runsOn: "server", managed: false, status: "ready", origin: VPS }),
    entry({ id: "s-render", name: "Render VPS", color: "rose", tier: null, runsOn: "server", managed: false, status: "offline", origin: RENDER, lastSeenAt: 1_761_000_100_000 })]);
  const state = session({ clouds });
  const places = railPlaces({ saved: saved(), home: HOME, mine: HOME, state });
  assert.deepEqual(places.find(place => place.id === "vps"), { id: "vps", name: "Office", color: null, kind: "server", opens: true, server: true },
    "saved by hand at its address: the same circle, marked as theirs, online, opening as it always did");
  assert.deepEqual(places.slice(-2), [
    { id: "signed-in:s-mini", name: "Mac mini", color: null, kind: "server", opens: false, ownNetwork: true, server: true, offline: true, lastSeenAt: 1_761_000_000_000 },
    { id: "signed-in:s-render", name: "Render VPS", color: "red", kind: "server", opens: false, pairs: true, server: true, offline: true, lastSeenAt: 1_761_000_100_000 },
  ]);
  assert.equal(places.length, 6, "one circle per server");
  for (const origin of [VPS, RENDER]) assert.equal(JSON.stringify(places).includes(origin), false, origin);
  assert.deepEqual([VPS, RENDER].map(origin => hostedCloudOrigin(origin, { state, mine: HOME })), [false, false], "its page never reads the rail");
  const alone = { activeId: "home", environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }] };
  assert.equal(railPlaces({ saved: alone, home: HOME, mine: HOME, state: session({ teams: [], clouds: parseCloudList([PRIMARY, clouds[2]]) }) }).length, 2, "it counts as a place");
  assert.equal(places.some(place => place.update), false, "no newest release named (the Admin doesn't follow releases): no reminder");
  const behind = parseCloudList([PRIMARY, entry({ id: "s-mini", name: "Mac mini", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.118" }),
    entry({ id: "s-new", name: "New box", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.130" }),
    entry({ id: "s-dev", name: "Dev box", runsOn: "server", managed: false, status: "ready", origin: null, version: "0.1.118-dev" })]);
  const reminded = railPlaces({ saved: saved(), home: HOME, mine: HOME, state: session({ clouds: behind, latestVersion: "0.1.130" }) });
  assert.deepEqual(reminded.filter(place => place.update).map(place => [place.id, place.update]), [["signed-in:s-mini", { version: "0.1.118", latest: "0.1.130" }]],
    "only one on an older numbered release");
  const r = rail({ places: () => places });
  assert.throws(() => r.call("workspaces:open", "signed-in:s-render"), /isn't here/, "nothing opens one main can't pair with yet");
  assert.throws(() => r.call("workspaces:open", "signed-in:s-mini"), /isn't here/);
});

test("only Clouds MausBot runs for this person may read the rail: My Cloud, their Clouds and their teams' on MausBot Cloud; never a server of their own or one typed in", () => {
  const state = session({ clouds: parseCloudList([PRIMARY, entry(), entry({ id: "c-own", name: "Mini", origin: OWN, runsOn: "server" }),
    entry({ id: "c-team", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM })]) });
  assert.deepEqual([HOME, CLIENT_A, TEAM, OWN, VPS, null].map(origin => hostedCloudOrigin(origin, { state, mine: HOME })), [true, true, true, false, false, false]);
  assert.equal(hostedCloudOrigin(TEAM, { state: session({ clouds: undefined }), mine: HOME }), true, "an older Admin lists teams' Clouds, all MausBot's");
  assert.equal(hostedCloudOrigin(CLIENT_A, { state: session({ clouds: undefined }), mine: HOME }), false);
  assert.equal(hostedCloudOrigin(TEAM, { state: session({ clouds: parseCloudList([PRIMARY]) }), mine: HOME }), false, "with the list, a Cloud it doesn't list is none of theirs");
  assert.equal(hostedCloudOrigin(HOME, { state: { status: "unavailable" }, mine: HOME }), true, "My Cloud while a check fails");
  assert.equal(hostedCloudOrigin(CLIENT_A, { state: { status: "unavailable", clouds: state.clouds }, mine: HOME }), false);
});

function rail(over = {}) {
  const handlers = new Map(), opened = [], ran = [], sent = [];
  const w = { trusted: true, state: session(), offer: { recommended: "pro", plans: [{ tier: "pro", amount: 4900 }] }, added: [] };
  const account = { state: () => w.state, offer: async () => w.offer, addCloud: async (input) => { w.added.push(input); return { outcome: "opened", state: w.state }; },
    reopenAdd: async () => true, addLink: () => "https://test.checkout.dodopayments.com/x", addDone: () => { w.done = true; }, interest: async () => {} };
  const installed = installCloudRail({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: handler => handler, trusted: () => w.trusted,
    places: () => railPlaces({ saved: saved(), home: HOME, mine: HOME, state: w.state }), open: id => opened.push(id), account: () => account,
    add: { choices: () => ({ cloud: true, link: true, address: false }), run: (...args) => ran.push(args) }, clipboard: { writeText: text => sent.push(text) },
    openCloud: async id => opened.push(`cloud:${id}`), targets: () => [{ isDestroyed: () => false, send: (channel) => sent.push(`page:${channel}`) }, null,
      { isDestroyed: () => false, send: (channel) => sent.push(`rail:${channel}`) }], ...over });
  return { handlers, opened, ran, sent, w, installed, call: (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

test("the rail's channels: the list only for a page main vouches for, a circle only by an id main listed, ＋ only its fixed choices", async () => {
  const r = rail();
  assert.deepEqual((await r.call("workspaces:places")).places.map(place => place.id), ["home", "a", "acme", "vps"]);
  r.w.trusted = false;
  assert.deepEqual(await r.call("workspaces:places"), { places: [], add: { cloud: false, link: false, address: false } }, "a server's own page learns nothing");
  assert.throws(() => r.call("workspaces:open", "a"), /only available/);
  assert.throws(() => r.call("workspaces:add", "link"), /only available/);
  r.w.trusted = true;
  r.call("workspaces:open", "a");
  assert.throws(() => r.call("workspaces:open", "https://evil.example.test"), /isn't here/);
  assert.throws(() => r.call("workspaces:open", "lab"), /isn't here/, "a local environment is the Server menu's, not the rail's");
  r.call("workspaces:add", "link");
  r.call("workspaces:add", "link", "  https://bots.example.test/#pair=abc  ");
  r.call("workspaces:add", "link", { href: "https://evil.example.test" });
  r.call("workspaces:add", "link", "x".repeat(5000));
  assert.throws(() => r.call("workspaces:add", "address"), /isn't something/, "not offered here");
  assert.throws(() => r.call("workspaces:add", "javascript:alert(1)"), /isn't something/);
  assert.deepEqual([r.opened, r.ran], [["a"], [["link"], ["link", "https://bots.example.test/#pair=abc"], ["link"], ["link", "x".repeat(4096)]]],
    "a pasted link reaches main's own Connect dialog trimmed and bounded; anything but text is the clipboard's");
  r.installed.changed(); r.installed.changed();
  assert.deepEqual(r.sent, ["page:workspaces:changed", "rail:workspaces:changed"], "a signal only, to the page and the rail, and once per change");
  r.w.beside = true;
  r.installed.changed();
  assert.deepEqual(r.sent.slice(2), ["page:workspaces:changed", "rail:workspaces:changed"], "the rail came beside the page (or went): the page reads it again");
});

test("buying another Cloud from a page: the plan must be on sale, the name is checked, and the page gets only what the sheet says", async () => {
  const r = rail();
  await assert.rejects(r.call("cloud-add:start", "max", "Client B", "rose"), /Choose a plan/);
  await assert.rejects(r.call("cloud-add:start", "pro", " ", "rose"), /Choose a plan/);
  assert.deepEqual(await r.call("cloud-add:start", "pro", "Client B", "url(x)"), { outcome: "opened" });
  assert.deepEqual(r.w.added, [{ tier: "pro", interval: "month", name: "Client B", color: null }], "an unknown swatch is none");
  assert.equal(await r.call("cloud-add:copy-link"), true);
  assert.deepEqual(r.sent, ["https://test.checkout.dodopayments.com/x"]);
  r.w.state = session({ adding: { cloudId: "c-a", name: "Client A", color: "green", tier: "pro", startedAt: 1, link: true } });
  await r.call("cloud-add:open");
  assert.deepEqual(r.opened, ["cloud:c-a"]);
  assert.equal(r.w.done, true);
  const view = await r.call("cloud-add:state");
  assert.equal(JSON.stringify(view).includes("acct-1"), false, "never the account");
  assert.deepEqual({ ...view, offer: undefined }, { signedIn: true, hasCloud: true, supported: true, canAdd: true, offer: undefined, count: 2,
    home: { name: "My Cloud", color: null }, adding: { name: "Client A", color: "green", tier: "pro", startedAt: 1, status: "ready", link: true } });
  r.w.trusted = false;
  for (const channel of ["cloud-add:state", "cloud-add:start", "cloud-add:open", "cloud-add:copy-link", "cloud-add:interest"]) assert.throws(() => r.call(channel), /only available/, channel);
});

test("what the add sheet says: an older Admin is one Cloud for now, the Admin's cap says why, and a new Cloud's setup is followed", () => {
  assert.deepEqual(addCloudView({ status: "signed-out" }, null), { signedIn: false });
  const older = addCloudView(session({ clouds: undefined }), null);
  assert.deepEqual([older.supported, older.canAdd, older.hasCloud, older.count], [false, false, true, 1]);
  const capped = addCloudView(session({ addCloud: { canAdd: false, blocked: "cap" } }), null);
  assert.deepEqual([capped.canAdd, capped.blocked], [false, "cap"]);
  const none = addCloudView({ status: "connected", account: { id: "x" }, clouds: [] }, null);
  assert.equal(none.hasCloud, false, "no Cloud yet: ＋ buys the first one on this computer's own sheet");
  const adding = (status, extra = {}) => addCloudView(session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-b", status, origin: status === "ready" ? CLIENT_A : null, ...extra })]),
    adding: { cloudId: "c-b", name: "Client B", color: "rose", tier: "pro", startedAt: 5 } }), null).adding;
  assert.deepEqual(adding("checkout"), { name: "Client B", color: "rose", tier: "pro", startedAt: 5, status: "checkout", progress: 0 });
  assert.deepEqual(adding("setting_up", { setup: { progress: 0.5 } }), { name: "Client B", color: "rose", tier: "pro", startedAt: 5, status: "setting_up", progress: 0.5 });
  assert.equal(adding("ready").status, "ready");
  assert.equal(adding("payment_problem").status, "problem");
});

test("another Cloud's page reads its own plan: its tier, and whether it runs", () => {
  assert.deepEqual(otherCloudSnapshot(entry()), { status: "paid", tier: "pro" });
  assert.deepEqual(otherCloudSnapshot(entry({ status: "payment_problem", tier: null })), { status: "attention" });
});

test("“{name}” is ready, once per Cloud this app bought, unless its sheet shows it in the focused window; a click opens it", () => {
  const shown = [], opened = [];
  class FakeNotification { static isSupported() { return true; } constructor(options) { this.options = options; shown.push(this); } on(_event, handler) { this.click = handler; } show() {} }
  let sheet = false;
  const notice = createAddedCloudNotice({ Notification: FakeNotification, focused: () => true, sheetOpen: () => sheet, open: id => opened.push(id) });
  const state = status => session({ clouds: parseCloudList([PRIMARY, entry({ id: "c-b", name: "Client B", status, origin: status === "ready" ? CLIENT_A : null })]),
    adding: { cloudId: "c-b", name: "Client B", color: null, tier: "pro", startedAt: 1 } });
  assert.equal(notice(state("setting_up")), false);
  assert.equal(notice(state("ready")), true);
  assert.equal(shown[0].options.title, "“Client B” is ready");
  shown[0].click();
  assert.deepEqual(opened, ["c-b"]);
  assert.equal(notice(state("ready")), false, "once");
  sheet = true;
  const quiet = createAddedCloudNotice({ Notification: FakeNotification, focused: () => true, sheetOpen: () => sheet, open: () => {} });
  assert.equal(quiet(state("ready")), false, "the sheet in the focused window says it itself");
  assert.equal(shown.length, 1);
});

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
function preload(origin, { activation = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--mausclaw-local-origin=${LOCAL}`, "--mausclaw-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => null, invoke: (...args) => { invoked.push(args); return Promise.resolve(); } } }),
  });
  return { bridge, invoked };
}

test("a Cloud's page gets the rail and the add sheet's narrow bridges; a circle, ＋ and checkout open only from the person's click", async () => {
  const page = preload(HOME);
  assert.deepEqual(Object.keys(page.bridge.workspaces), ["state", "menu", "line", "places", "open", "add", "look", "color", "onChanged"]);
  assert.deepEqual(Object.keys(page.bridge.cloudAdd), ["state", "start", "reopen", "copyLink", "open", "interest", "sheet"]);
  await page.bridge.workspaces.places();
  await page.bridge.cloudAdd.state();
  await assert.rejects(page.bridge.workspaces.open("a"), /Choose a place/);
  await assert.rejects(page.bridge.workspaces.add("link"), /Choose what to add/);
  await assert.rejects(page.bridge.cloudAdd.start("pro", "Client B", "rose"), /Continue to checkout/);
  await assert.rejects(page.bridge.cloudAdd.reopen(), /Reopen checkout/);
  await assert.rejects(page.bridge.cloudAdd.copyLink(), /Copy link/);
  await assert.rejects(page.bridge.cloudAdd.open(), /Open/);
  await assert.rejects(page.bridge.workspaces.color("rose"), /Choose a color/, "a page changes its place's colour only from the person's click");
  await page.bridge.workspaces.look();
  assert.deepEqual(page.invoked.at(-1), ["workspaces:look"]);
  const clicked = preload(HOME, { activation: true });
  await clicked.bridge.workspaces.open({ toString: () => "a" });
  await clicked.bridge.workspaces.add("link");
  await clicked.bridge.cloudAdd.start("pro", "Client B", null);
  await clicked.bridge.workspaces.color("rose");
  await clicked.bridge.workspaces.color(null);
  assert.deepEqual(clicked.invoked, [["workspaces:open", "a"], ["workspaces:add", "link"], ["cloud-add:start", "pro", "Client B", null], ["workspaces:color", "rose"], ["workspaces:color", null]]);
  assert.equal(page.bridge.cloudAccount, undefined, "never the account bridge");
  const local = preload(LOCAL);
  await local.bridge.workspaces.open("a");
  assert.deepEqual(local.invoked, [["workspaces:open", "a"]], "this app's own page needs no click check");
});
