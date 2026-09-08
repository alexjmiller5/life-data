// Push-route tests over the D1 shim: per-row rejection never fails the
// batch, and derived columns require a matching provenance row.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { ROUTES, allowed } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
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
  await db.prepare("INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash) VALUES ('places:a:slug','places','a','slug','http:slug','x','derived_from','hub',?,?)").bind(await hex('["A"]'), await hex("a")).run();
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
    "INSERT INTO provenance (id, to_kind, to_ref, field, from_kind, from_ref, rel, asserted_by, inputs_hash, value_hash) VALUES ('places:a:double','places','a','double','http:double','x','derived_from','hub',?,?)",
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


test("a pushed provenance edge is validated like any user row", async () => {
  const db = new D1Shim();
  await seed(db);
  for (const sql of [
    `INSERT INTO catalog_properties (id, tbl, col, type, required, options) VALUES ('provenance.rel','provenance','rel','select',1,'[{"v":"evidence_of"},{"v":"mentions"}]')`,
    `INSERT INTO catalog_properties (id, tbl, col, type, required) VALUES ('provenance.asserted_by','provenance','asserted_by','text',1)`,
  ]) await db.prepare(sql).run();
  const pcols = ["id", "from_kind", "from_ref", "to_kind", "to_ref", "rel", "asserted_by", "updated_at"];
  const edge = (o) => ({ id: "imessage:G1:a", from_kind: "imessage", from_ref: "G1", to_kind: "places", to_ref: "a", rel: "evidence_of", asserted_by: "agent:s1", updated_at: "2026-09-07T00:00:00.000Z", ...o });
  let out = await ROUTES["/v1/rows/push"]({ table: "provenance", columns: pcols, rows: [edge({ rel: "vibes" })] }, db);
  expect(out.rejected[0]).toMatchObject({ col: "rel", rule: "options" });
  out = await ROUTES["/v1/rows/push"]({ table: "provenance", columns: pcols, rows: [edge({})] }, db);
  expect(out.rejected).toEqual([]);
  expect(out.upserted).toBe(1);
});

test("schema push skips a RENAME COLUMN the hub already has", async () => {
  const db = new D1Shim();
  for (const sql of [
    `CREATE TABLE _schema_log (id INTEGER PRIMARY KEY AUTOINCREMENT, applied_at TEXT DEFAULT (${NOW}), ddl TEXT NOT NULL)`,
    `CREATE TABLE t (id TEXT PRIMARY KEY, b TEXT)`,
  ]) await db.prepare(sql).run();
  const out = await ROUTES["/v1/schema/push"]({ entries: [{ applied_at: "2026-09-07T00:00:00.000Z", ddl: "ALTER TABLE t RENAME COLUMN a TO b" }] }, db);
  expect(out.applied).toBe(1);
});

test("schema push skips a RENAME TO the hub already applied, and hub replay renames for real", async () => {
  const db = new D1Shim();
  for (const sql of [
    `CREATE TABLE _schema_log (id INTEGER PRIMARY KEY AUTOINCREMENT, applied_at TEXT DEFAULT (${NOW}), ddl TEXT NOT NULL)`,
    `CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT)`,
  ]) await db.prepare(sql).run();
  const entry = (ddl) => ({ applied_at: "2026-09-08T00:00:00.000Z", ddl });
  let out = await ROUTES["/v1/schema/push"]({ entries: [entry('ALTER TABLE "people" RENAME TO "humans"')] }, db);
  expect(out.applied).toBe(1);
  expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='humans'").all()).results.length).toBe(1);
  // the same rename spelled differently (identical text is deduped before it runs) is a no-op
  out = await ROUTES["/v1/schema/push"]({ entries: [entry("ALTER TABLE people RENAME TO humans")] }, db);
  expect(out.applied).toBe(1);
  // but a genuinely missing table in any other DDL still fails loudly
  await expect(ROUTES["/v1/schema/push"]({ entries: [entry("ALTER TABLE ghost ADD COLUMN x TEXT")] }, db)).rejects.toThrow();
});
