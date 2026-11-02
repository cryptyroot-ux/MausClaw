import assert from "node:assert/strict";
import test from "node:test";

import { cloudMachine, cloudSetupProgress, listedColors, MAX_CLOUDS, olderRelease, otherOwnClouds, ownCloudPlaces, parseCloudList, releaseVersion, signedInServers, swatchColor } from "./cloud-list.mjs";
import environments from "./environments.cjs";
import { createHomePlaces } from "./home-places.mjs";

const HOME = "https://mausclaw-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://mausclaw-c-a.fly.dev", CLIENT_B = "https://mausclaw-c-b.fly.dev", TEAM = "https://mausclaw-t-acme.fly.dev";
const cloud = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A,
  teamId: null, seats: null, renewsAt: null, cancelAtPeriodEnd: false, primary: false, ...over });
const primary = cloud({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true });

test("the session's Clouds are read strictly: a malformed one is left out whole, never trusted in part; a malformed extra is simply dropped", () => {
  assert.equal(parseCloudList(undefined), null, "an Admin without the list: everything as before");
  for (const none of [null, {}, "x", 3]) assert.equal(parseCloudList(none), null, String(none));
  assert.deepEqual(parseCloudList([]), []);
  assert.deepEqual(parseCloudList([primary, cloud()]), [
    { id: "c-home", name: "My Cloud", color: null, role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: HOME, teamId: null, primary: true, managed: true },
    { id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A, teamId: null, primary: false, managed: true },
  ]);
  for (const bad of [
    { id: "" }, { id: "../x" }, { name: "" }, { name: "x".repeat(41) }, { name: "<b>" }, { role: "boss" }, { status: "sleeping" }, { runsOn: "moon" },
    { primary: "yes" }, { origin: "http://mausclaw-c-a.fly.dev" }, { origin: `${CLIENT_A}/path` }, { origin: "https://user@mausclaw-c-a.fly.dev" }, { origin: null },
    { status: "offline", origin: null }, { teamId: "../team" }, { teamId: 7 },
  ]) assert.deepEqual(parseCloudList([cloud(bad)]), [], JSON.stringify(bad));
  const [shown] = parseCloudList([cloud({ color: "url(x)", tier: "PRO!", name: "  Client   A  " })]);
  assert.deepEqual([shown.color, shown.tier, shown.name], [null, null, "Client A"], "a malformed colour or tier is none; the name is folded");
  assert.deepEqual(parseCloudList([cloud({ status: "setting_up", origin: null, setup: { step: "storage", progress: 2 } })])[0].setup, { step: "storage", progress: 1 });
  assert.equal(parseCloudList([cloud({ status: "setting_up", origin: null, setup: { step: "dreaming" } })])[0].setup, undefined);
  assert.equal(parseCloudList([cloud({ status: "ready", setup: { step: "storage" } })])[0].setup, undefined, "only while it is set up");
});

test("each Cloud's `power` as the Admin says it of a Ready Cloud whose plan sleeps; anything malformed, or on a Cloud not Ready, is none", () => {
  const power = { state: "asleep", since: 1_761_000_000_000, sleeps: true };
  assert.deepEqual(parseCloudList([cloud({ power })])[0].power, power);
  assert.deepEqual(parseCloudList([cloud({ power: { ...power, state: "waking", extra: 1 } })])[0].power, { ...power, state: "waking" });
  for (const bad of [{ ...power, state: "dozing" }, { ...power, sleeps: false }, { ...power, since: -1 }, "asleep", null]) {
    assert.equal(parseCloudList([cloud({ power: bad })])[0].power, undefined, JSON.stringify(bad));
  }
  assert.equal(parseCloudList([cloud({ status: "stopped", power })])[0].power, undefined, "only a Ready Cloud sleeps or wakes");
});

test("a server or computer of the person's own that signed in with their account: read with or without an address, and never a Cloud of theirs", () => {
  const mini = cloud({ id: "s-mini", name: "Mac mini", color: null, tier: null, runsOn: "server", managed: false, status: "offline", origin: null,
    lastSeenAt: 1_761_000_000_000, version: "0.1.118", kind: "desktop", reachable: { via: "tailscale" } });
  assert.deepEqual(parseCloudList([mini]), [{ id: "s-mini", name: "Mac mini", color: null, role: "owner", tier: null, runsOn: "server", status: "offline", origin: null,
    teamId: null, primary: false, managed: false, lastSeenAt: 1_761_000_000_000, version: "0.1.118" }], "only reachable on its own network; fields this app doesn't know are ignored");
  assert.equal(parseCloudList([{ ...mini, status: "ready", origin: "https://mini.example.ts.net" }])[0].origin, "https://mini.example.ts.net");
  for (const bad of [{ managed: "false" }, { managed: 0 }, { managed: null }, { managed: false, runsOn: "cloud" }]) {
    assert.deepEqual(parseCloudList([cloud(bad)]), [], `${JSON.stringify(bad)}: whether MausBot vouches for it is never guessed`);
  }
  const [loose] = parseCloudList([{ ...mini, lastSeenAt: "yesterday", version: "<b>1</b>" }]);
  assert.deepEqual([loose.lastSeenAt, loose.version], [undefined, undefined], "a malformed last-seen time or version is left out");
  assert.deepEqual(parseCloudList([{ ...mini, lastSeenAt: null, version: null }])[0], parseCloudList([{ ...mini, lastSeenAt: undefined, version: undefined }])[0]);
  assert.equal(parseCloudList([cloud({ managed: true })])[0].managed, true);
  assert.equal(parseCloudList([cloud({ status: "offline", origin: null })]).length, 0, "a Cloud MausBot runs still needs its address");
  const list = parseCloudList([primary, mini, { ...mini, id: "s-vps", name: "VPS", status: "ready", origin: "https://vps.example.com", primary: true }]);
  assert.deepEqual(list.map(entry => entry.primary), [true, false, false], "never My Cloud");
  assert.deepEqual([otherOwnClouds(list), ownCloudPlaces(list)], [[], []], "nor another Cloud of theirs: nothing pairs with it by id or lends to it");
  assert.deepEqual(signedInServers(list).map(entry => entry.id), ["s-mini", "s-vps"]);
});

test("the Admin's colour for My Cloud and each team's Cloud, once one was chosen there; the person's other Clouds take theirs with their place", () => {
  const list = parseCloudList([{ ...primary, color: "rose" }, cloud({ color: "amber" }), cloud({ id: "c-team", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM, color: "slate" }),
    cloud({ id: "c-t2", name: "Beta", teamId: "team-beta", role: "admin", origin: "https://mausclaw-t-beta.fly.dev", color: null })]);
  assert.deepEqual(listedColors(list), [{ home: true, color: "red" }, { teamId: "team-acme", color: null }], "slate is none; a team's Cloud with no colour chosen is not listed");
  assert.deepEqual(listedColors(null), []);
});

test("at most twenty Clouds, each once, and one primary only, of the person's own", () => {
  const many = Array.from({ length: 25 }, (_, n) => cloud({ id: `c-${n}`, name: `Cloud ${n}`, origin: `https://mausclaw-c-${n}.fly.dev` }));
  assert.equal(parseCloudList(many).length, MAX_CLOUDS);
  assert.equal(parseCloudList([cloud(), cloud({ name: "Again" })]).length, 1, "the same id twice is read once");
  const twice = parseCloudList([primary, cloud({ primary: true })]);
  assert.deepEqual(twice.map(entry => entry.primary), [true, false]);
  assert.deepEqual(parseCloudList([cloud({ teamId: "team-acme", role: "member", primary: true, origin: TEAM })]).map(entry => entry.primary), [false], "a team's Cloud is never My Cloud");
});

test("another Cloud of the person's own is a place of its own, read as the app's machine summary; a team's Cloud and My Cloud are not", () => {
  const list = parseCloudList([primary, cloud(), cloud({ id: "c-team", name: "Acme", teamId: "team-acme", role: "admin", origin: TEAM }), cloud({ id: "c-b", name: "Client B", status: "setting_up", origin: null, setup: { step: "starting" } })]);
  assert.deepEqual(otherOwnClouds(list).map(entry => entry.id), ["c-a", "c-b"]);
  assert.deepEqual(ownCloudPlaces(list), [{ id: "c-a", role: "owner", name: "Client A", color: "teal", origin: CLIENT_A }], "only one with an address is a saved place");
  assert.deepEqual(cloudMachine(list[1]), { status: "ready", origin: CLIENT_A });
  assert.deepEqual(cloudMachine(list[3]), { status: "provisioning", setup: { step: "starting" } });
  assert.equal(cloudMachine({ ...list[1], status: "checkout" }), null);
  assert.deepEqual(cloudMachine({ ...list[1], status: "ended" }), { status: "stopped", origin: CLIENT_A });
  assert.deepEqual(cloudMachine({ ...list[1], status: "offline" }), { status: "ready", origin: CLIENT_A }, "its own screen says it doesn't answer");
  assert.deepEqual([cloudSetupProgress(list[3]), cloudSetupProgress({ status: "checkout" }), cloudSetupProgress(list[1])], [0.65, 0, null]);
  assert.equal(cloudSetupProgress({ status: "setting_up", setup: { progress: 0.3, step: "starting" } }), 0.3, "the Admin's progress wins over the step");
  assert.deepEqual(["blue", "green", "amber", "rose", "violet", "slate", "chartreuse"].map(swatchColor), ["blue", "teal", "yellow", "red", "purple", null, null]);
});

test("each other own Cloud is one saved place, named and coloured by the Admin; one hand-saved at its address becomes it; My Cloud's and a team's never do", () => {
  const home = { id: "home", kind: "remote", name: "Studio", origin: HOME, home: true, color: "purple" };
  const team = { id: "team", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role: "member" } };
  const typed = { id: "typed", kind: "remote", name: "mausclaw-c-b.fly.dev", origin: CLIENT_B, microphone: true };
  let ids = 0;
  const state = { environments: [home, team, typed], activeId: "home" };
  const next = environments.reconcileOwnClouds(state, [
    { id: "c-a", role: "owner", name: "Client A", color: "teal", origin: CLIENT_A },
    { id: "c-b", role: "owner", name: "Client B", color: null, origin: CLIENT_B },
    { id: "c-x", role: "owner", name: "Not mine", color: "red", origin: HOME },
    { id: "c-y", role: "owner", name: "Not a team's", color: "red", origin: TEAM },
  ], () => `new-${++ids}`, HOME);
  assert.deepEqual(next.environments, [home, team,
    { id: "typed", kind: "remote", name: "Client B", origin: CLIENT_B, microphone: true, cloud: { id: "c-b", role: "owner" } },
    { id: "new-1", kind: "remote", origin: CLIENT_A, name: "Client A", color: "teal", cloud: { id: "c-a", role: "owner" } }]);
  assert.equal(environments.reconcileOwnClouds(next, [
    { id: "c-a", role: "owner", name: "Client A", color: "teal", origin: CLIENT_A }, { id: "c-b", role: "owner", name: "Client B", color: null, origin: CLIENT_B },
  ], () => "unused", HOME), next, "the same list again changes nothing");
  assert.equal(environments.reconcileOwnClouds(next, null, () => "unused", HOME), next, "an Admin without the list changes nothing");
  const renamed = environments.reconcileOwnClouds({ ...next, activeId: "new-1" }, [{ id: "c-a", role: "owner", name: "Acme Client", color: "red", origin: CLIENT_A }], () => "unused", HOME);
  assert.deepEqual(renamed.environments.map(entry => [entry.name, entry.color ?? null]), [["Studio", "purple"], ["Acme", null], ["Acme Client", "red"]], "Client B is gone; Client A follows the Admin");
  assert.equal(renamed.activeId, "new-1");
  const gone = environments.reconcileOwnClouds(renamed, [], () => "unused", HOME);
  assert.equal(gone.activeId, "home", "the Cloud on screen is gone: My Cloud again");
  const parsed = environments.parseEnvironments(environments.serializeEnvironments(next));
  assert.deepEqual(parsed.environments.find(entry => entry.id === "new-1").cloud, { id: "c-a", role: "owner" }, "kept across launches");
  assert.equal(environments.parseEnvironments({ version: 2, environments: [{ ...home, cloud: { id: "c-a", role: "owner" } }], activeId: "home" }).environments[0].cloud, undefined, "My Cloud's entry is never another Cloud's");
});

test("the switcher lists another own Cloud like a team's: no Forget, the window titled by its name", () => {
  const entry = { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, cloud: { id: "c-a", role: "owner" } };
  const state = { environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }, entry], activeId: "a" };
  const menu = environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {}, homeOrigin: HOME });
  assert.deepEqual(menu.map(item => item.id), ["workspace-home", "workspace-a"]);
  const before = environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {} });
  assert.equal(before.some(item => item.id === "workspace-forget"), false);
  assert.equal(environments.workspaceWindowTitle(state, null, HOME), "MausClaw — Client A");
});

test("home places: the session's other Clouds become saved places, one remembered is opened next time, and one the session drops is forgotten", () => {
  const w = { saved: null, state: { environments: [{ id: "home", kind: "remote", name: "My Cloud", origin: HOME, home: true }], activeId: "home" }, persisted: [], ids: 0 };
  const places = createHomePlaces({ store: { read: () => w.saved, write: value => { w.saved = value; } }, environments: () => w.state,
    persist: next => { w.persisted.push(next); w.state = next; }, makeId: () => `id-${++w.ids}`, homeOrigin: () => HOME });
  const session = clouds => ({ status: "connected", account: { id: "acct-1" }, clouds: parseCloudList(clouds) });
  places.sync({ status: "connected", account: { id: "acct-1" } });
  assert.deepEqual(w.persisted, [], "an older Admin's session lists no Clouds: nothing changes");
  places.sync(session([primary, cloud()]));
  assert.deepEqual(w.state.environments.map(entry => [entry.name, entry.cloud?.id ?? null, entry.color ?? null]), [["My Cloud", null, null], ["Client A", "c-a", "teal"]]);
  places.remember({ cloud: "c-a" });
  assert.deepEqual(w.saved, { cloud: "c-a" });
  assert.deepEqual(places.remembered(), { cloud: "c-a", name: "Client A", origin: CLIENT_A });
  places.remember({ team: "team-acme" });
  assert.deepEqual(w.saved, { team: "team-acme" }, "a team instead");
  places.remember({ cloud: "c-a" });
  w.state = { ...w.state, activeId: "id-1" };
  places.drop({ kind: "own", id: "c-a", name: "Client A" });
  assert.deepEqual(w.state.environments.map(entry => entry.name), ["My Cloud"]);
  assert.equal(w.state.activeId, "home");
  assert.equal(places.remembered(), null);
  assert.equal(places.line(), null, "a Cloud of their own leaving says nothing");
  places.sync(session([primary, cloud()]));
  places.remember({ cloud: "c-a" });
  places.sync(session([primary]));
  assert.equal(places.remembered(), null, "listed no more: forgotten");
  assert.deepEqual(w.state.environments.map(entry => entry.name), ["My Cloud"]);
});

test("a release older than the newest one, compared number by number; nothing is guessed for a build of its own", () => {
  assert.deepEqual([["0.1.118", "0.1.130"], ["0.1.130", "0.1.130"], ["0.2.0", "0.1.130"], ["0.1", "0.1.1"], ["0.1.9", "0.1.10"]].map(([a, b]) => olderRelease(a, b)), [true, false, false, true, true]);
  for (const [a, b] of [["0.1.118-dev", "0.1.130"], ["0.1.118", null], [null, "0.1.130"], ["main", "0.1.130"], ["0.1.118", "latest"]]) assert.equal(olderRelease(a, b), false, `${a} ${b}`);
  assert.deepEqual(["0.1.130", null, "", "<b>", 7].map(releaseVersion), ["0.1.130", null, null, null, null]);
});
