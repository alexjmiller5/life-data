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
  prepare(sql) {
    const stmt = super.prepare(sql);
    for (const name of ["all", "run", "first", "raw"]) {
      const inner = stmt[name].bind(stmt);
      // Statements inside a batch travel in the batch's one round trip.
      stmt[name] = async (...args) => { if (!this.batching) this.calls++; return inner(...args); };
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
  // path's governance setup on each read. Two of these run after the response
  // (the token's last-use stamp and the usage flush).
  expect(await call(path, body)).toBeLessThanOrEqual(8);
});

test("write routes still install governance storage for tables created after the isolate warmed up", async () => {
  const { env, call } = await hub();
  for (const [p, b] of reads) await call(p, b);
  env.DB.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT)");
  await call("/v1/rows/push", { table: "later", columns: ["id", "name", "updated_at"], rows: [{ id: "a", name: "A", updated_at: "2026-01-01T00:00:00.000Z" }] });
  const triggers = env.DB.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='later' AND name GLOB '_governance_rows_*'").all();
  expect(triggers.length).toBeGreaterThan(0);
});
