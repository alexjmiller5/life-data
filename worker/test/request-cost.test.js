import { expect, test } from "bun:test";
import worker from "../src/main.js";
import { hashToken, ensureAuthReady } from "../src/auth.js";
import { D1Shim } from "./d1shim.js";

// Every D1 call from a Worker is a network round trip (~45 ms from the edge to
// the database), so a replica's read requests must not re-run idempotent setup
// each time: a cold download is hundreds of them. A batch is one round trip.
class Counting extends D1Shim {
  calls = 0;
  batching = false;
  statements = []; // every statement's SQL, batched or not
  prepare(sql) {
    const stmt = super.prepare(sql);
    for (const name of ["all", "run", "first", "raw"]) {
      const inner = stmt[name].bind(stmt);
      // Statements inside a batch travel in the batch's one round trip.
      stmt[name] = async (...args) => { if (!this.batching) this.calls++; this.statements.push(sql); return inner(...args); };
    }
    return stmt;
  }
  async batch(stmts) {
    this.calls++;
    this.batching = true;
    try { return await super.batch(stmts); } finally { this.batching = false; }
  }
}

async function hub() {
  const env = { HUB_TOKEN: "root", DB: new Counting(), AUTH_DB: new Counting() };
  env.DB.db.exec("CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  env.DB.db.exec("CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, type TEXT, required INTEGER, sort INTEGER, options TEXT, inputs TEXT, default_value TEXT, options_sql TEXT, ref_table TEXT, derived_by TEXT, immutable INTEGER, deprecated INTEGER, created_at TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await ensureAuthReady(env.AUTH_DB);
  await env.AUTH_DB.prepare("INSERT INTO _tokens (hash, name, scopes) VALUES (?, ?, ?)").bind(await hashToken("t-device"), "device", "full").run();
  const call = async (path, body) => {
    const pending = [];
    const response = await worker.fetch(new Request(`https://hub.test${path}`, {
      method: "POST", headers: { Authorization: "Bearer t-device", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), env, { waitUntil: (p) => pending.push(p) });
    const text = await response.text();
    expect({ status: response.status, text: response.status === 200 ? "" : text }).toEqual({ status: 200, text: "" });
    const calls = env.DB.calls + env.AUTH_DB.calls;
    while (pending.length) await pending.shift();
    return calls;
  };
  return { env, call };
}

const columns = ["id", "name", "updated_at", "deleted_at", "hub_at"];
const reads = [
  ["/v1/schema/pull", {}],
  ["/v1/rows/pull", { table: "people", columns, since: "", limit: 200 }],
  ["/v1/cursor", { tables: ["people"] }],
  ["/v1/stats", {}],
];

for (const [path, body] of reads.slice(1)) test(`a warm ${path} answers within a few D1 round trips`, async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b); // the isolate's first requests set up storage
  env.DB.calls = env.AUTH_DB.calls = 0;
  // Before: 30-33, from re-running every CREATE IF NOT EXISTS and the write
  // path's governance setup on each read; then 8, with the generic-state audit
  // (two batches) and the cursor's column probe on every read. Two of these
  // run after the response (the token's last-use stamp and the usage flush).
  expect(await call(path, body)).toBeLessThanOrEqual(4);
});

test("a read audits afresh as soon as the schema changes, and a write audits every time", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // A tamper only a fresh audit sees: the very next read is denied...
  env.DB.db.exec("CREATE VIEW _governance_fake AS SELECT 1");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(403);
  // ...and so is a write, which never relies on an earlier verification.
  const denied = await rawCall(env, "/v1/rows/push", { table: "people", columns, rows: [] });
  expect(denied.status).toBe(403);
  env.DB.db.exec("DROP VIEW _governance_fake");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(200);
});

test("a write's failed audit makes the next read audit afresh too", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // Catalog contents are data, so the schema stamp reads check does not move,
  // and reads execute no catalog SQL...
  env.DB.db.exec("INSERT INTO catalog_properties (id, tbl, col, type, options_sql) VALUES ('people.x', 'people', 'x', 'select', 'SELECT * FROM _governance_heads')");
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(200);
  // ...but every write audits them, and its denial drops the isolate's verification.
  expect((await rawCall(env, "/v1/rows/push", { table: "people", columns, rows: [] })).status).toBe(403);
  expect((await rawCall(env, "/v1/stats", {})).status).toBe(403);
});

const AUDIT = "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
const setup = (env) => env.DB.statements.filter((sql) => /\bIF NOT EXISTS\b/.test(sql) && /_governance_/.test(sql));

test("a warm read skips the generic-state audit while the schema is unchanged", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  env.DB.statements = [];
  await call("/v1/cursor", { tables: ["people"] });
  await call("/v1/rows/pull", { table: "people", columns, since: "", limit: 200 });
  expect(env.DB.statements.filter((sql) => sql === AUDIT)).toEqual([]);
});

test("a warm write audits but skips governance setup while the schema is unchanged", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (name, at) => call("/v1/rows/push", { table: "people", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name, updated_at: at }] });
  // The hub creates its history table on the first push: DDL the next write
  // sets up for, once.
  await push("A", "2026-01-01T00:00:00.000Z");
  await push("A2", "2026-01-01T00:00:00.500Z");
  env.DB.statements = [];
  env.DB.calls = env.AUTH_DB.calls = 0;
  const trips = await push("B", "2026-01-01T00:00:01.000Z");
  expect(env.DB.statements.filter((sql) => sql === AUDIT).length).toBe(1);
  expect(setup(env)).toEqual([]);
  // Before: 42, of which 19 re-ran governance setup that a fingerprint of the
  // audited schema proves unnecessary.
  expect(trips).toBeLessThanOrEqual(25);
});

test("a write after out-of-band DDL runs governance setup again", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  const push = (table, at) => call("/v1/rows/push", { table, columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "A", updated_at: at }] });
  await push("people", "2026-01-01T00:00:00.000Z");
  const guards = (t) => env.DB.db.query(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='${t}' AND name GLOB '_governance_rows_*'`).all().length;
  expect(guards("people")).toBe(3);
  // A guard removed behind the hub's back is back after the next write.
  const guard = env.DB.db.query("SELECT name FROM sqlite_master WHERE name GLOB '_governance_rows_*_update' AND tbl_name='people'").get().name;
  env.DB.db.exec(`DROP TRIGGER "${guard}"`);
  await push("people", "2026-01-01T00:00:01.000Z");
  expect(guards("people")).toBe(3);
  // So is a guard for a table another isolate's replay created.
  env.DB.db.exec("CREATE TABLE later2 (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await push("people", "2026-01-01T00:00:02.000Z");
  expect(guards("later2")).toBe(3);
});

test("a cursor read after a schema replay still sees the new table", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  // Asked before it exists: the isolate now remembers 'later' as missing.
  expect((await (await rawCall(env, "/v1/cursor", { tables: ["people", "later"] })).json()).tables).toEqual({ people: "", later: "" });
  await call("/v1/schema/push", { entries: [{ applied_at: "2026-01-01T00:00:00.000Z", ddl: "CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)" }] });
  env.DB.db.exec("INSERT INTO later VALUES ('a','A','2026-01-02T00:00:00.000Z',NULL,'2026-01-02T00:00:00.000Z')");
  const marks = await (await rawCall(env, "/v1/cursor", { tables: ["people", "later"] })).json();
  expect(marks.tables).toEqual({ people: "", later: "2026-01-02T00:00:00.000Z" });
});

async function rawCall(env, path, body) {
  return worker.fetch(new Request(`https://hub.test${path}`, {
    method: "POST", headers: { Authorization: "Bearer t-device", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil() {} });
}

test("write routes still install governance storage for tables created after the isolate warmed up", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  env.DB.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await call("/v1/rows/push", { table: "later", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "A", updated_at: "2026-01-01T00:00:00.000Z" }] });
  const triggers = env.DB.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='later' AND name GLOB '_governance_rows_*'").all();
  expect(triggers.length).toBeGreaterThan(0);
});
