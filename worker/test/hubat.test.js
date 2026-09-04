// The pull cursor is HUB arrival time, not a client stamp: the hub assigns
// hub_at on every write it makes, and pulls/cursors read it.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { deriveRows } from "../src/derive.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ENV = { DERIVATIONS: JSON.stringify({ blurb: { url: "https://derivations.example/blurb" } }) };

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, derived_by TEXT, inputs_hash TEXT, value_hash TEXT, source_ref TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT, blurb TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('people.name','people','name',1,'text')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('people.blurb','people','blurb',2,'text','http:blurb','["name"]')`,
  ])
    await db.prepare(sql).run();
  return db;
}

const cols = ["id", "name", "blurb", "updated_at", "hub_at"];
const row = (o) => ({ id: "a", name: "Ada", blurb: null, updated_at: "2026-09-04T00:00:00.000Z", hub_at: null, ...o });

test("push stamps hub_at on its own clock and reports it", async () => {
  const db = await seed(new D1Shim());
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row({ hub_at: "1970" })] }, db);
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const stored = await db.prepare("SELECT hub_at FROM people WHERE id = 'a'").first();
  expect(stored.hub_at).toBe(out.hub_at); // the client's "1970" was overwritten

  // an UPDATE through the LWW guard re-stamps too
  const later = await ROUTES["/v1/rows/push"](
    { table: "people", columns: cols, rows: [row({ name: "Grace", updated_at: "2026-09-05T00:00:00.000Z" })] },
    db
  );
  const after = await db.prepare("SELECT name, hub_at FROM people WHERE id = 'a'").first();
  expect(after.name).toBe("Grace");
  expect(after.hub_at).toBe(later.hub_at);
  expect(later.hub_at >= out.hub_at).toBe(true);
});

test("pull filters by hub_at, and since='' includes NULL hub_at rows", async () => {
  const db = await seed(new D1Shim());
  await db.prepare("INSERT INTO people (id, name, updated_at) VALUES ('old','Legacy','2026-01-01T00:00:00.000Z')").run();
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);

  const all = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "" }, db);
  expect(all.rows.map((r) => r.id).sort()).toEqual(["a", "old"]);

  // the boundary is INCLUSIVE: a row stamped in the same millisecond as a
  // cursor read comes back rather than being lost
  const boundary = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: push.hub_at }, db);
  expect(boundary.rows.map((r) => r.id)).toEqual(["a"]);
  const past = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "2099" }, db);
  expect(past.rows).toEqual([]);

  const earlier = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: "2020" }, db);
  expect(earlier.rows.map((r) => r.id)).toEqual(["a"]); // NULL hub_at is older than everything
});

test("cursor is max(hub_at)", async () => {
  const db = await seed(new D1Shim());
  expect((await ROUTES["/v1/cursor"]({ tables: ["people"] }, db)).max_hub_at).toBe("");
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);
  expect((await ROUTES["/v1/cursor"]({ tables: ["people", "provenance"] }, db)).max_hub_at).toBe(push.hub_at);
});

test("a hub-side derivation stamps hub_at so replicas pull it", async () => {
  const db = await seed(new D1Shim());
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row()] }, db);
  const fetchImpl = async () => new Response(JSON.stringify({ blurb: "about Ada" }));
  const out = await deriveRows(db, ENV, "people", ["a"], { fetchImpl });
  expect(out.derived).toBe(1);
  const after = await db.prepare("SELECT blurb, hub_at FROM people WHERE id = 'a'").first();
  expect(after.blurb).toBe("about Ada");
  expect(after.hub_at >= push.hub_at).toBe(true);
  const seen = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: push.hub_at }, db);
  expect(seen.rows.map((r) => r.id)).toEqual(["a"]);
});

test("the hub stamps from its own schema, not the pushed column list", async () => {
  const db = await seed(new D1Shim());
  // an un-upgraded client: hub_at is nowhere in `columns`
  const old = ["id", "name", "blurb", "updated_at"];
  const out = await ROUTES["/v1/rows/push"]({ table: "people", columns: old, rows: [row()] }, db);
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const stored = await db.prepare("SELECT hub_at FROM people WHERE id = 'a'").first();
  expect(stored.hub_at).toBe(out.hub_at);
  // ... so a replica whose cursor has moved on still sees the row
  const seen = await ROUTES["/v1/rows/pull"]({ table: "people", columns: cols, since: out.hub_at }, db);
  expect(seen.rows.map((r) => r.id)).toEqual(["a"]);
});

test("cursor and pull fall back to updated_at on a table without hub_at", async () => {
  const db = await seed(new D1Shim());
  await db.prepare(`CREATE TABLE legacy (id TEXT PRIMARY KEY, name TEXT, updated_at TEXT)`).run();
  await db.prepare("INSERT INTO legacy VALUES ('a','Ada','2026-01-01T00:00:00.000Z')").run();
  await db.prepare("INSERT INTO legacy VALUES ('g','Grace','2026-02-01T00:00:00.000Z')").run();
  const lcols = ["id", "name", "updated_at"];
  expect((await ROUTES["/v1/cursor"]({ tables: ["legacy"] }, db)).max_hub_at).toBe("2026-02-01T00:00:00.000Z");
  expect((await ROUTES["/v1/rows/pull"]({ table: "legacy", columns: lcols, since: "" }, db)).rows.length).toBe(2);
  const some = await ROUTES["/v1/rows/pull"]({ table: "legacy", columns: lcols, since: "2026-01-15T00:00:00.000Z" }, db);
  expect(some.rows.map((r) => r.id)).toEqual(["g"]);
  // and a push into it still works, unstamped
  const out = await ROUTES["/v1/rows/push"](
    { table: "legacy", columns: lcols, rows: [{ id: "n", name: "New", updated_at: "2026-03-01T00:00:00.000Z" }] },
    db
  );
  expect(out.upserted).toBe(1);
  expect(out.hub_at).toBe("");
});

test("cursor keeps the legacy max_updated_at key equal to max_hub_at for pre-hub_at clients", async () => {
  const db = new D1Shim();
  await seed(db);
  const push = await ROUTES["/v1/rows/push"]({ table: "people", columns: cols, rows: [row({ id: "a" })] }, db);
  const c = await ROUTES["/v1/cursor"]({ tables: ["people"] }, db);
  expect(c.max_updated_at).toBe(c.max_hub_at);
  expect(c.max_hub_at).toBe(push.hub_at);
});
