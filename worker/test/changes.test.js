// Instant sync: replicas long-poll the hub's change sequence instead of
// polling every 30 s. Only a commit that changes replicated state may move it,
// or a replica re-pushing no-op or rejected rows would wake every replica forever.
import { expect, test } from "bun:test";
import worker, { ROUTES } from "../src/index.js";
import { ChangeSignal, withChangeSignal } from "../src/changes.js";
import { D1Shim } from "./d1shim.js";

function storage() {
  const data = new Map();
  return { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) };
}

// The runtime holds every request until blockConcurrencyWhile settles.
async function signal(store = storage()) {
  const loading = [];
  const s = new ChangeSignal({ storage: store, blockConcurrencyWhile: (fn) => loading.push(fn()) });
  await Promise.all(loading);
  return s;
}

const wait = (s, query) => s.fetch(new Request(`https://change-signal/?${query}`));
const bump = (s) => s.fetch(new Request("https://change-signal/", { method: "POST" }));
const seqOf = async (response) => (await response).json().then((b) => b.seq);

test("a waiter without a known sequence gets the current one at once", async () => {
  const s = await signal();
  await bump(s);
  expect(await seqOf(wait(s, "wait=25"))).toBe(1);
});

test("a stale sequence returns at once; a current one is held until a bump", async () => {
  const s = await signal();
  expect(await seqOf(wait(s, "since=7&wait=25"))).toBe(0);
  const held = wait(s, "since=0&wait=25");
  let done = false;
  held.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 50));
  expect(done).toBe(false);
  await bump(s);
  expect(await seqOf(held)).toBe(1);
});

test("a held waiter times out with the unchanged sequence", async () => {
  const s = await signal();
  const started = Date.now();
  expect(await seqOf(wait(s, "since=0&wait=1"))).toBe(0);
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
});

test("the sequence survives the object being evicted", async () => {
  const store = storage();
  await bump(await signal(store));
  await bump(await signal(store));
  expect(await seqOf(wait(await signal(store), "wait=0"))).toBe(2);
});

// A CHANGES binding that counts bumps, shaped like a Durable Object namespace.
async function changesBinding() {
  const s = await signal();
  const bumps = [];
  return {
    bumps,
    idFromName: (name) => name,
    get: () => ({
      fetch: (url, init) => {
        if (init?.method === "POST") bumps.push(url);
        return s.fetch(new Request(url, init));
      },
    }),
  };
}

async function peopleDb() {
  const db = new D1Shim();
  await db.prepare(
    "CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)",
  ).run();
  return db;
}

function inRequest(env, fn) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  return withChangeSignal(env, ctx, fn).then(async (out) => {
    await Promise.all(pending);
    return out;
  });
}

const cols = ["id", "name", "updated_at"];
const T1 = "2026-10-01T00:00:00.000Z", T2 = "2026-10-02T00:00:00.000Z";
const push = (env, db, rows) =>
  inRequest(env, () => ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows }, db, env));

test("a push bumps only when it changes a row", async () => {
  const CHANGES = await changesBinding(), env = { CHANGES }, db = await peopleDb();
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T2 }]);
  expect(CHANGES.bumps.length).toBe(1);
  // the same revision again, and an older one: accepted no-ops, no wake-up
  await push(env, db, [{ id: "a", name: "Ada", updated_at: T2 }]);
  await push(env, db, [{ id: "a", name: "Old", updated_at: T1 }]);
  expect(CHANGES.bumps.length).toBe(1);
  // a rejected row (malformed timestamp) changes nothing either
  const out = await push(env, db, [{ id: "b", name: "Bad", updated_at: "yesterday" }]);
  expect(out.rejected.length).toBe(1);
  expect(CHANGES.bumps.length).toBe(1);
  await push(env, db, [{ id: "a", name: "Grace", updated_at: "2026-10-03T00:00:00.000Z" }]);
  expect(CHANGES.bumps.length).toBe(2);
});

test("schema push bumps only when it applies DDL", async () => {
  const CHANGES = await changesBinding(), env = { CHANGES }, db = await peopleDb();
  for (const sql of ["CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)"])
    await db.prepare(sql).run();
  const entries = [{ applied_at: T1, ddl: "ALTER TABLE people ADD COLUMN bio TEXT" }];
  await inRequest(env, () => ROUTES["/v1/schema/push"]({ entries }, db, env));
  expect(CHANGES.bumps.length).toBe(1);
  await inRequest(env, () => ROUTES["/v1/schema/push"]({ entries }, db, env));
  expect(CHANGES.bumps.length).toBe(1);
});

test("writes outside a request scope or without the binding never fail", async () => {
  const db = await peopleDb();
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [{ id: "a", name: "Ada", updated_at: T2 }] }, db);
  expect(out.upserted).toBe(1);
  await push({}, db, [{ id: "a", name: "Grace", updated_at: "2026-10-03T00:00:00.000Z" }]);
});

async function hub(scopes) {
  const CHANGES = await changesBinding();
  const env = { HUB_TOKEN: "operator", AUTH_DB: new D1Shim(), DB: await peopleDb(), CHANGES };
  const ctx = { waitUntil() {} };
  const mint = await worker.fetch(new Request("https://hub.test/v1/tokens/create", {
    method: "POST", headers: { Authorization: "Bearer operator" },
    body: JSON.stringify({ name: "replica", scopes }),
  }), env, ctx);
  const { token } = await mint.json();
  const call = (path, method = "GET", body) => worker.fetch(new Request(`https://hub.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body),
  }), env, ctx);
  return { call, CHANGES };
}

test("GET /v1/changes serves readers and wakes on a pushed change", async () => {
  const { call } = await hub("full");
  const first = await call("/v1/changes?wait=0");
  expect(first.status).toBe(200);
  const { seq } = await first.json();
  const held = call(`/v1/changes?since=${seq}&wait=25`);
  const pushed = await call("/v1/rows/push", "POST", { table: "people", columns: cols, rows: [{ id: "a", name: "Ada", updated_at: T2 }] });
  expect((await pushed.json()).upserted).toBe(1);
  expect((await (await held).json()).seq).toBe(seq + 1);
});

test("GET /v1/changes needs table read access and validates its query", async () => {
  expect((await (await hub("tables:read")).call("/v1/changes?wait=0")).status).toBe(200);
  expect((await (await hub("streams:append")).call("/v1/changes?wait=0")).status).toBe(403);
  const { call } = await hub("full");
  expect((await call("/v1/changes?since=x&wait=0")).status).toBe(400);
  expect((await call("/v1/changes?wait=-1")).status).toBe(400);
});

// A cheap quiet round: the cursor also answers for the schema log, so a replica
// skips the whole-log pull while neither side's log has moved.
test("the cursor reports the schema log mark and tolerates tables the hub lacks", async () => {
  const db = await peopleDb();
  await db.prepare("CREATE TABLE _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT, ddl TEXT)").run();
  const before = await ROUTES["/v1/cursor"]({ tables: ["people", "renamed_away"] }, db);
  expect(before.schema).toBe(0);
  expect(before.tables.renamed_away).toBe("");
  await ROUTES["/v1/schema/push"]({ entries: [{ applied_at: T1, ddl: "ALTER TABLE people ADD COLUMN bio TEXT" }] }, db);
  expect((await ROUTES["/v1/cursor"]({ tables: ["people"] }, db)).schema).toBe(1);
});
