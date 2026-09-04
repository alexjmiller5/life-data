// Push-route tests over the D1 shim: per-row rejection never fails the
// batch, and derived columns require a matching provenance row.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { ROUTES, allowed } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, derived_by TEXT, inputs_hash TEXT, value_hash TEXT, source_ref TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE places (id TEXT PRIMARY KEY, status TEXT, slug TEXT, name TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, type, options) VALUES ('places.status','places','status','select','[{"v":"want"}]')`,
    `INSERT INTO catalog_properties (id, tbl, col, type, derived_by, inputs) VALUES ('places.slug','places','slug','text','http:slug','["name"]')`,
  ]) await db.prepare(sql).run();
}

const cols = ["id", "status", "slug", "name", "updated_at"];
const row = (o) => ({ id: "a", status: "want", slug: null, name: "A", updated_at: "2026-09-03T00:00:00.000Z", ...o });

test("rejects the bad row, accepts the good one, never fails the batch", async () => {
  const db = new D1Shim();
  await seed(db);
  const out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ id: "good" }), row({ id: "bad", status: "Nope" })] }, db);
  expect(out.upserted).toBe(1);
  expect(out.rejected[0]).toMatchObject({ id: "bad", col: "status", rule: "options" });
  const { results } = await db.prepare("SELECT id FROM places").all();
  expect(results.map((r) => r.id)).toEqual(["good"]);
});

test("derived column needs matching provenance", async () => {
  const db = new D1Shim();
  await seed(db);
  let out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "a" })] }, db);
  expect(out.rejected[0].rule).toBe("provenance");
  // provenance for name='A' -> slug 'a': inputs_hash = sha256(json_array('A')), value_hash = sha256('a')
  const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash) VALUES ('places:a:slug','places','a','slug','http:slug',?,?)").bind(await hex('["A"]'), await hex("a")).run();
  out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "a" })] }, db);
  expect(out.rejected).toEqual([]);
  expect(out.upserted).toBe(1);
  // a hand edit to the value with unchanged inputs is still caught
  out = await ROUTES["/v1/rows/push"]({ table: "places", columns: cols, rows: [row({ slug: "hand", updated_at: "2026-09-04T00:00:00.000Z" })] }, db);
  expect(out.rejected[0].rule).toBe("provenance");
});

const hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

test("integral number columns hash as REAL, the way SQLite stored them", async () => {
  const db = new D1Shim();
  await seed(db);
  for (const sql of [
    "ALTER TABLE places ADD COLUMN qty REAL",
    "ALTER TABLE places ADD COLUMN double REAL",
    `INSERT INTO catalog_properties (id, tbl, col, type) VALUES ('places.qty','places','qty','number')`,
    `INSERT INTO catalog_properties (id, tbl, col, type, derived_by, inputs) VALUES ('places.double','places','double','number','http:double','["qty"]')`,
  ]) await db.prepare(sql).run();
  // provenance as the Python client writes it: SQLite renders REAL 4 as "4.0"
  await db.prepare(
    "INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash) VALUES ('places:a:double','places','a','double','http:double',?,?)",
  ).bind(await hex('["4.0"]'), await hex("8.0")).run();
  const out = await ROUTES["/v1/rows/push"](
    { table: "places", columns: [...cols, "qty", "double"], rows: [row({ qty: 4, double: 8 })] },
    db,
  );
  expect(out.rejected).toEqual([]);
  expect(out.upserted).toBe(1);
});

test("an unsafe table name is rejected before any SQL is built", async () => {
  const db = new D1Shim();
  await seed(db);
  const bad = "places; DROP TABLE x";
  // with nothing to upsert, ident() was never reached at all and the bogus
  // identifier sailed straight into validatePush's own interpolated SQL
  await expect(ROUTES["/v1/rows/push"]({ table: bad, columns: cols, rows: [] }, db)).rejects.toThrow("unsafe identifier");
  await expect(ROUTES["/v1/rows/push"]({ table: bad, columns: cols, rows: [row()] }, db)).rejects.toThrow("unsafe identifier");
});

test("tables:write reaches exactly push and derive", () => {
  const w = ["tables:write"];
  expect(allowed("/v1/rows/push", "POST", w)).toBe(true);
  expect(allowed("/v1/derive", "POST", w)).toBe(true);
  for (const p of ["/v1/schema/push", "/v1/schema/pull", "/v1/rows/pull", "/v1/cursor", "/v1/catalog", "/v1/backup", "/v1/tokens/create", "/v1/archive/query"]) {
    expect(allowed(p, "POST", w)).toBe(false);
  }
  // the other scopes are unchanged
  expect(allowed("/v1/derive", "POST", ["tables:read"])).toBe(false);
  expect(allowed("/v1/rows/push", "POST", ["tables:read"])).toBe(false);
  expect(allowed("/v1/rows/pull", "POST", ["tables:read"])).toBe(true);
  expect(allowed("/v1/derive", "POST", ["full"])).toBe(true);
  expect(allowed("/v1/derive", "POST", ["admin"])).toBe(true);
  expect(allowed("/v1/tokens/create", "POST", ["full"])).toBe(false);
});
