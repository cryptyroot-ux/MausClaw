import assert from "node:assert/strict";
import test from "node:test";

import { listedColors, parseCloudList } from "./cloud-list.mjs";
import environments from "./environments.cjs";
import { createHomePlaces } from "./home-places.mjs";
import { installPlaceLook, pageLook, placeLook, swatchOf } from "./place-look.mjs";

const HOME = "https://mausclaw-u-1a2b3c4d5e6f.fly.dev", CLIENT_A = "https://mausclaw-c-a.fly.dev", TEAM = "https://mausclaw-t-acme.fly.dev", VPS = "https://bots.example.test";
const cloud = (over = {}) => ({ id: "c-a", name: "Client A", color: "green", role: "owner", tier: "pro", runsOn: "cloud", status: "ready", origin: CLIENT_A, teamId: null, primary: false, ...over });
const CLOUDS = parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true }), cloud(),
  cloud({ id: "c-acme", name: "Acme", color: "amber", teamId: "team-acme", role: "admin", origin: TEAM })]);
const home = { id: "home", kind: "remote", name: "Studio", origin: HOME, home: true, color: "purple" };
const own = { id: "a", kind: "remote", name: "Client A", origin: CLIENT_A, color: "teal", cloud: { id: "c-a", role: "owner" } };
const team = (role = "admin") => ({ id: "acme", kind: "remote", name: "Acme", origin: TEAM, team: { id: "team-acme", role } });
const typed = { id: "vps", kind: "remote", name: "Office", origin: VPS };

test("who changes a place's colour, and where it is kept: the Admin for a Cloud its owner or team admin opens, this app for a server connected by hand", () => {
  const session = { clouds: CLOUDS, homeOrigin: HOME };
  assert.deepEqual(placeLook(home, session), { name: "Studio", color: "purple", swatch: "violet", change: "admin", cloudId: "c-home" }, "My Cloud: the account's primary Cloud");
  assert.deepEqual(placeLook(own, session), { name: "Client A", color: "teal", swatch: "green", change: "admin", cloudId: "c-a" });
  assert.deepEqual(placeLook(team("admin"), session), { name: "Acme", color: null, swatch: null, change: "admin", cloudId: "c-acme" });
  assert.deepEqual(placeLook(typed, session), { name: "Office", color: null, swatch: null, change: "local" });
  assert.deepEqual(placeLook({ ...typed, color: "orange" }, session).swatch, null, "a colour no swatch has is shown, and none of the six is ticked");
  const member = parseCloudList([...CLOUDS.slice(0, 2), cloud({ id: "c-acme", name: "Acme", teamId: "team-acme", role: "member", origin: TEAM })]);
  assert.deepEqual(placeLook(team("admin"), { clouds: member, homeOrigin: HOME }), { name: "Acme", color: null, swatch: null, change: null, reason: "member" }, "the Admin's role is the word");
  assert.deepEqual(placeLook(team("member"), { clouds: null, homeOrigin: HOME }), { name: "Acme", color: null, swatch: null, change: null, reason: "member" }, "an older Admin: the team's role");
  assert.deepEqual(placeLook(team("owner"), { clouds: null, homeOrigin: HOME }).change, "local", "an older Admin keeps no colours: this app does");
  assert.deepEqual(placeLook(home, { clouds: null, homeOrigin: HOME }).change, "local");
  assert.deepEqual(placeLook(own, { clouds: null, homeOrigin: HOME }), { name: "Client A", color: "teal", swatch: "green", change: null, reason: "signed-out" },
    "another Cloud of theirs while the sign-in is away: a colour saved here alone would be undone");
  assert.deepEqual(placeLook({ ...home, home: undefined }, session).cloudId, "c-home", "My Cloud by its address too");
  for (const none of [null, undefined, { id: "local", kind: "local", name: "This computer" }, { id: "lab", kind: "local", name: "Lab", dataDir: "/x" }]) assert.equal(placeLook(none, session), null);
  assert.deepEqual(pageLook(placeLook(own, session)), { name: "Client A", color: "teal", swatch: "green", change: "admin" }, "the page never sees the Cloud's id");
  assert.deepEqual(["blue", "teal", "yellow", "red", "purple", "orange", null, "url(x)"].map(swatchOf), ["blue", "green", "amber", "rose", "violet", null, null, null]);
});

function ipc({ entry, clouds = CLOUDS, answer = { outcome: "saved" } } = {}) {
  const handlers = new Map(), asked = [], saved = [];
  let state = { activeId: entry?.id ?? "local", environments: entry ? [entry] : [] };
  installPlaceLook({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, guard: handler => handler,
    place: () => state.environments.find(candidate => candidate.id === state.activeId) ?? null, session: () => ({ clouds, homeOrigin: HOME }),
    setColor: async (id, swatch) => { asked.push([id, swatch]); return answer; },
    save: (id, color) => { saved.push([id, color]); state = environments.withPlaceColor(state, id, color); } });
  return { asked, saved, call: (channel, ...args) => handlers.get(channel)({ sender: {} }, ...args) };
}

test("a page changes only its own place's colour: a Cloud's on the Admin first, then here at once; a member's, an older Admin's and a failure change nothing", async () => {
  const admin = ipc({ entry: own });
  assert.deepEqual(await admin.call("workspaces:look"), { name: "Client A", color: "teal", swatch: "green", change: "admin" });
  assert.deepEqual(await admin.call("workspaces:color", "rose"), { outcome: "saved", look: { name: "Client A", color: "red", swatch: "rose", change: "admin" } });
  assert.deepEqual([admin.asked, admin.saved], [[["c-a", "rose"]], [["a", "red"]]]);
  assert.deepEqual((await admin.call("workspaces:color", "slate")).look.color, null, "slate is the plain one: no colour, the look of today");
  await assert.rejects(admin.call("workspaces:color", "chartreuse"), /Choose one of the colors/);
  await assert.rejects(admin.call("workspaces:color", { toString: () => "rose" }), /Choose one of the colors/);

  const member = ipc({ entry: team("member"), clouds: null });
  assert.deepEqual(await member.call("workspaces:color", "rose"), { outcome: "refused", look: { name: "Acme", color: null, swatch: null, change: null, reason: "member" } });
  assert.deepEqual([member.asked, member.saved], [[], []], "a member's choice reaches neither the Admin nor this app");

  for (const outcome of ["refused", "unsupported", "failed"]) {
    const refused = ipc({ entry: own, answer: { outcome } });
    assert.deepEqual((await refused.call("workspaces:color", "rose")).outcome, outcome);
    assert.deepEqual(refused.saved, [], `${outcome}: nothing saved here, so nothing shows a colour the Admin doesn't keep`);
  }

  const local = ipc({ entry: typed });
  assert.deepEqual(await local.call("workspaces:color", "amber"), { outcome: "saved", look: { name: "Office", color: "yellow", swatch: "amber", change: "local" } });
  assert.deepEqual([local.asked, local.saved], [[], [["vps", "yellow"]]], "a server connected by hand: this app's own");

  const computer = ipc({ entry: null });
  assert.equal(await computer.call("workspaces:look"), null, "this computer's page has no colour");
  await assert.rejects(computer.call("workspaces:color", "rose"), /no color/);
});

test("a saved place's colour: set, cleared to none, an unknown one ignored; the Admin's for My Cloud and teams once chosen there", () => {
  const state = { activeId: "home", environments: [home, own, team("member"), typed, { id: "local", kind: "local", name: "Lab", dataDir: "/x" }] };
  const red = environments.withPlaceColor(state, "vps", "red");
  assert.equal(red.environments.find(entry => entry.id === "vps").color, "red");
  assert.equal(environments.withPlaceColor(red, "vps", "red"), red, "the same state when nothing changes");
  assert.equal(Object.hasOwn(environments.withPlaceColor(red, "vps", null).environments.find(entry => entry.id === "vps"), "color"), false);
  for (const [id, color] of [["vps", "chartreuse"], ["local", "red"], ["gone", "red"]]) assert.equal(environments.withPlaceColor(state, id, color), state, `${id} ${color}`);

  const looks = listedColors(parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: "rose", origin: HOME, primary: true }),
    cloud({ id: "c-acme", name: "Acme", color: "slate", teamId: "team-acme", role: "member", origin: TEAM })]));
  const listed = environments.withListedColors({ ...state, environments: state.environments.map(entry => (entry.id === "acme" ? { ...entry, color: "blue" } : entry)) }, looks, HOME);
  assert.deepEqual(listed.environments.map(entry => [entry.id, entry.color ?? null]), [["home", "red"], ["a", "teal"], ["acme", null], ["vps", null], ["local", null]]);
  assert.equal(environments.withListedColors(state, listedColors(parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: null, origin: HOME, primary: true })])), HOME), state,
    "none chosen on the Admin yet: the colour picked when the Cloud was set up stays");
});

test("home places: the session's colours reach the saved places, and a team member sees the colour its admins chose", () => {
  let state = { activeId: "home", environments: [home, team("member")] };
  const places = createHomePlaces({ store: { read: () => ({}), write() {} }, environments: () => state, persist: next => { state = next; }, makeId: () => "new", homeOrigin: () => HOME });
  places.sync({ status: "connected", teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }],
    clouds: parseCloudList([cloud({ id: "c-home", name: "My Cloud", color: "green", origin: HOME, primary: true }), cloud({ id: "c-acme", name: "Acme", color: "violet", teamId: "team-acme", role: "member", origin: TEAM })]) });
  assert.deepEqual(state.environments.map(entry => [entry.id, entry.color]), [["home", "teal"], ["acme", "purple"]]);
  const before = state;
  places.sync({ status: "connected", teams: [{ id: "team-acme", name: "Acme", role: "member", machine: { status: "ready", origin: TEAM } }] });
  assert.equal(state, before, "an older Admin lists no colours: the saved ones stay");
});
