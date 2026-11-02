import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { installCloudLending } from "./cloud-lending-ipc.mjs";
import { createComputerSharing, validateSharedFolders } from "./computer-sharing.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "mausclaw-sharing-races-"));
  const file = path.join(dir, "computer-sharing.json");
  const env = { id: "cloud", origin: "https://cloud.fixture.test", name: "Cloud" };
  const info = { sessionId: randomUUID(), environmentId: randomUUID() };
  const connects = [];
  const polled = Promise.withResolvers();
  let heldIdentity = null;
  const sharing = createComputerSharing({
    file, environments: () => [env], enabled: async () => true, home: dir,
    cloud: () => ({ status: "connected", accountId: "account-1", origin: env.origin }),
    async fetch(url, { signal, body }) {
      const route = new URL(url).pathname;
      if (route === "/api/auth/session") {
        const held = heldIdentity;
        heldIdentity = null;
        if (held) { held.entered.resolve(); await held.released.promise; }
        return Response.json({ kind: "session", id: info.sessionId, cloudHome: true, scopes: ["admin"] });
      }
      if (route === "/.well-known/mausclaw/environment") return Response.json({ environmentId: info.environmentId, capabilities: { sharedComputers: true } });
      if (route === "/api/shared-computers/connect") connects.push(JSON.parse(body));
      if (route.endsWith("/poll")) await new Promise((resolve, reject) => {
        polled.resolve();
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return Response.json({ ok: true });
    },
  });
  t.after(async () => { sharing.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    sharing, env, info, connects, dir, polled: polled.promise,
    records: async () => JSON.parse(await readFile(file, "utf8")).records,
    holdIdentity() {
      const held = { entered: Promise.withResolvers(), released: Promise.withResolvers() };
      heldIdentity = held;
      t.after(() => held.released.resolve());
      return { entered: held.entered.promise, release: held.released.resolve };
    },
  };
}

for (const mode of ["Cloud", "Computer access"]) {
  const save = (f, terminal) => mode === "Cloud"
    ? f.sharing.saveCloud(f.env, { folders: [], internet: true, terminal })
    : f.sharing.save(f.env, { folders: [], computer: true, terminal }, f.info);

  test(`${mode}: Stop invalidates a pending terminal grant`, async t => {
    const f = await fixture(t);
    await save(f, false);
    await f.polled;
    const held = f.holdIdentity();
    const saving = save(f, true);
    await held.entered;
    f.sharing.revoke(f.env);
    held.release();
    const result = await saving;
    assert.equal(result.enabled, false);
    const kept = (await f.records())[f.env.id];
    assert.equal(kept.enabled, false);
    assert.equal(kept.terminal, false);
    assert.equal(kept.stopped.reason, "you");
    assert.equal(f.sharing.lendingToCloud(), false);
    assert.ok(f.connects.every(grant => grant.terminal === false));
  });

  test(`${mode}: forgetting an environment invalidates its pending grant`, async t => {
    const f = await fixture(t);
    const held = f.holdIdentity();
    const saving = save(f, true);
    await held.entered;
    f.sharing.forget(f.env);
    held.release();
    assert.equal((await saving).enabled, false);
    assert.deepEqual(await f.records(), {});
    assert.equal(f.sharing.lendingToCloud(), false);
    assert.deepEqual(f.connects, []);
  });

  test(`${mode}: a newer save keeps its capabilities when an older save finishes`, async t => {
    const f = await fixture(t);
    const held = f.holdIdentity();
    const older = save(f, true);
    await held.entered;
    await save(f, false);
    const kept = (await f.records())[f.env.id];
    held.release();
    assert.equal((await older).terminal, false);
    assert.deepEqual((await f.records())[f.env.id], kept);
    assert.equal(kept.enabled, true);
    assert.ok(f.connects.every(grant => grant.terminal === false));
  });
}

test("declining access invalidates a pending grant", async t => {
  const f = await fixture(t);
  const held = f.holdIdentity();
  const saving = f.sharing.save(f.env, { folders: [], terminal: true }, f.info);
  await held.entered;
  f.sharing.decline(f.env, f.info);
  held.release();
  assert.equal((await saving).enabled, false);
  assert.equal((await f.records())[f.env.id].terminal, false);
  assert.deepEqual(f.connects, []);
});

test("a change to another environment leaves a pending grant valid", async t => {
  const f = await fixture(t);
  const held = f.holdIdentity();
  const saving = f.sharing.saveCloud(f.env, { folders: [], terminal: true });
  await held.entered;
  f.sharing.revoke({ ...f.env, id: "other" });
  held.release();
  assert.equal((await saving).enabled, true);
  assert.equal((await f.records())[f.env.id].terminal, true);
});

async function mainLending(f, validate = validateSharedFolders) {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const handlers = new Map();
  runInNewContext(section("function stopLending()", "async function openLendingSettings()") +
    section("const useMyMac = installCloudLending(", "const cloudSync ="), {
    computerSharing: f.sharing, environmentsState: { environments: [f.env] },
    installCloudLending, sharingController: () => f.sharing,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localWorkspaceOnly: (_channel, handler) => handler, cloudPageAsking: () => true,
    lendingSnapshot: async () => ({ available: true, screenAvailable: false, state: f.sharing.cloudState(f.env) }),
    lendingTarget: { environment: () => f.env }, lendingDialogs: {},
    usualFolders: async () => [], usualFolderPaths: () => [], app: {}, os: {},
    validateSharedFolders: validate,
  }, { filename: "main.mjs (lending fixture)" });
  return handlers;
}

test("main Stop invalidates a pending save while the stored grant is off", async t => {
  const f = await fixture(t);
  const handlers = await mainLending(f);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  await f.polled;
  await handlers.get("lending:stop")({});
  const stopped = (await f.records())[f.env.id];
  const held = f.holdIdentity();
  const saving = handlers.get("lending:save")({}, { folders: [], internet: true, terminal: true });
  await held.entered;
  await handlers.get("lending:stop")({});
  held.release();
  assert.equal((await saving).state.enabled, false);
  assert.deepEqual((await f.records())[f.env.id], stopped);
  assert.equal(f.sharing.cloudState(f.env).terminal, false);
  assert.equal(f.sharing.lendingToCloud(), false);
});

test("main Stop cancels a terminal choice held in IPC folder validation", async t => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], internet: true });
  await f.polled;
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  t.after(() => released.resolve());
  const handlers = await mainLending(f, async folders => {
    entered.resolve();
    await released.promise;
    return validateSharedFolders(folders);
  });
  const saving = handlers.get("lending:save")({}, {
    folders: [{ id: randomUUID(), path: f.dir, write: false }], internet: true, terminal: true,
  });
  await entered.promise;
  await handlers.get("lending:stop")({});
  const stopped = (await f.records())[f.env.id];
  released.resolve();
  assert.equal((await saving).state.enabled, false);
  assert.deepEqual((await f.records())[f.env.id], stopped);
  assert.equal(f.sharing.cloudState(f.env).terminal, false);
  assert.equal(f.sharing.lendingToCloud(), false);
  assert.ok(f.connects.every(grant => grant.terminal === false));
});

test("a stopped worker cannot restore its terminal grant after identity refresh", async t => {
  const f = await fixture(t);
  await f.sharing.saveCloud(f.env, { folders: [], terminal: true });
  await f.polled;
  const handlers = await mainLending(f);
  const held = f.holdIdentity();
  f.sharing.start();
  await held.entered;
  await handlers.get("lending:stop")({});
  const stopped = (await f.records())[f.env.id];
  f.info.sessionId = randomUUID();
  held.release();
  await setImmediate();
  assert.deepEqual((await f.records())[f.env.id], stopped);
  f.sharing.cloudChanged();
  f.sharing.start();
  await setImmediate();
  assert.equal(f.sharing.cloudState(f.env).enabled, false);
  assert.equal(f.sharing.cloudState(f.env).terminal, false);
  assert.equal(f.sharing.lendingToCloud(), false);
  assert.deepEqual((await f.records())[f.env.id], stopped);
  assert.equal(f.connects.length, 1);
});
