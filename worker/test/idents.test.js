// A column named `cast` is a SQLite keyword: every identifier the hub
// interpolates into SQL must be quoted or the whole table stops syncing.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { deriveRows } from "../src/derive.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ENV = { DERIVATIONS: JSON.stringify({ blurb: { url: "https://derivations.example/blurb" } }) };

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, derived_by TEXT, inputs_hash TEXT, value_hash TEXT, source_ref TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE movies (id TEXT PRIMARY KEY, "cast" TEXT, "order" INTEGER, blurb TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('movies.cast','movies','cast',1,'text')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type) VALUES ('movies.order','movies','order',2,'int')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',3,'text','http:blurb','["cast"]')`,
  ])
    await db.prepare(sql).run();
  return db;
}

const cols = ["id", "cast", "order", "blurb", "updated_at", "hub_at"];

test("push, pull and derive all work on keyword-named columns", async () => {
  const db = await seed(new D1Shim());
  const row = { id: "m1", cast: "Ada", order: 1, blurb: null, updated_at: "2026-09-04T00:00:00.000Z", hub_at: null };

  const push = await ROUTES["/v1/rows/push"]({ table: "movies", columns: cols, rows: [row] }, db);
  expect(push.rejected).toEqual([]);
  expect(push.upserted).toBe(1);

  const pull = await ROUTES["/v1/rows/pull"]({ table: "movies", columns: cols, since: "" }, db);
  expect(pull.rows[0].cast).toBe("Ada");
  expect(pull.rows[0].order).toBe(1);

  const fetchImpl = async () => new Response(JSON.stringify({ blurb: "about Ada" }));
  const out = await deriveRows(db, ENV, "movies", ["m1"], { fetchImpl });
  expect(out.failed).toEqual([]);
  expect(out.derived).toBe(1);
  const after = await db.prepare(`SELECT blurb FROM movies WHERE id = 'm1'`).first();
  expect(after.blurb).toBe("about Ada");

  const cursor = await ROUTES["/v1/cursor"]({ tables: ["movies"] }, db);
  expect(cursor.max_hub_at >= push.hub_at).toBe(true); // the derivation re-stamped it
});
