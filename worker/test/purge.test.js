// Purge markers over the D1 shim: a pushed marker hard-deletes what it covers,
// and later pushes of covered copies are dropped without a rejection.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const SYNC = `created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT, hub_at TEXT`;
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const LATER = "2099-01-01T00:00:00.000Z";
const push = (body, db) => ROUTES["/v1/rows/push"](body, db);

async function seed() {
  const db = new D1Shim();
  for (const sql of [
    `CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, note TEXT, ${SYNC})`,
    `CREATE TABLE history (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, old TEXT, new TEXT, origin TEXT, ${SYNC})`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, from_kind TEXT, from_ref TEXT, to_kind TEXT, to_ref TEXT, rel TEXT, field TEXT, detail TEXT, asserted_by TEXT, inputs_hash TEXT, value_hash TEXT, produced_at TEXT, ${SYNC})`,
    `CREATE TABLE purges (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, purged_at TEXT, ${SYNC})`,
    `INSERT INTO items (id, name, note, updated_at) VALUES ('r1', 'secret', 'n', '${T1}')`,
    `INSERT INTO history (id, tbl, row_id, col, old, new, created_at, updated_at) VALUES ('h1', 'items', 'r1', 'name', 'a', 'secret', '${T1}', '${T1}')`,
    `INSERT INTO history (id, tbl, row_id, col, old, new, created_at, updated_at) VALUES ('h2', 'items', 'r1', 'note', 'm', 'n', '${T1}', '${T1}')`,
    `INSERT INTO provenance (id, from_kind, from_ref, to_kind, to_ref, rel, asserted_by, updated_at) VALUES ('manual:x:r1', 'manual', 'x', 'items', 'r1', 'evidence_of', 't', '${T1}')`,
  ]) await db.prepare(sql).run();
  return db;
}

const marker = (col = null) => ({
  id: JSON.stringify(["items", "r1", col]), tbl: "items", row_id: "r1", col, purged_at: T2, updated_at: T2,
});
const pushMarker = (db, col) =>
  push({ table: "purges", columns: ["id", "tbl", "row_id", "col", "purged_at", "updated_at"], rows: [marker(col)] }, db);
const ids = async (db, sql) => (await db.prepare(sql).all()).results.map((r) => r.id);

test("a pushed row marker deletes the row, its history and its provenance edges", async () => {
  const db = await seed();
  expect((await pushMarker(db)).upserted).toBe(1);
  expect(await ids(db, "SELECT id FROM items")).toEqual([]);
  expect(await ids(db, "SELECT id FROM history")).toEqual([]);
  expect(await ids(db, "SELECT id FROM provenance")).toEqual([]);
  expect(await ids(db, "SELECT id FROM purges")).toEqual([marker().id]);
});

test("a column marker deletes only that column's history", async () => {
  const db = await seed();
  await pushMarker(db, "name");
  expect(await ids(db, "SELECT id FROM items")).toEqual(["r1"]);
  expect(await ids(db, "SELECT id FROM history")).toEqual(["h2"]);
  expect(await ids(db, "SELECT id FROM provenance")).toEqual(["manual:x:r1"]);
});

test("covered copies pushed later are dropped without a rejection", async () => {
  const db = await seed();
  await pushMarker(db);
  let out = await push({ table: "items", columns: ["id", "name", "updated_at"], rows: [{ id: "r1", name: "stale", updated_at: T1 }] }, db);
  expect(out.rejected).toEqual([]);
  expect(await ids(db, "SELECT id FROM items")).toEqual([]);
  const event = { id: "h-old", tbl: "items", row_id: "r1", col: "name", old: "a", new: "b", origin: "old", created_at: T1, updated_at: T1 };
  out = await push({ table: "history", columns: Object.keys(event), rows: [event] }, db);
  expect(out.rejected).toEqual([]);
  expect(await ids(db, "SELECT id FROM history")).toEqual([]);
});

test("a copy written after the marker is new data; covered attachments still drop", async () => {
  const db = await seed();
  await pushMarker(db);
  const old = { id: "h-old", tbl: "items", row_id: "r1", col: "name", old: "secret", new: "x", origin: "old", created_at: T1, updated_at: T1 };
  const out = await push(
    { table: "items", columns: ["id", "name", "updated_at"], rows: [{ id: "r1", name: "new", updated_at: LATER }], history: [old] },
    db,
  );
  expect(out.upserted).toBe(1);
  expect(await ids(db, "SELECT id FROM items")).toEqual(["r1"]);
  expect(await ids(db, "SELECT id FROM history WHERE id = 'h-old'")).toEqual([]);
});

test("a column marker drops that column's old events and keeps the others", async () => {
  const db = await seed();
  await pushMarker(db, "name");
  const ev = (id, col) => ({ id, tbl: "items", row_id: "r1", col, old: "a", new: "b", origin: "old", created_at: T1, updated_at: T1 });
  const rows = [ev("h-name", "name"), ev("h-note", "note")];
  await push({ table: "history", columns: Object.keys(rows[0]), rows }, db);
  expect(await ids(db, "SELECT id FROM history WHERE id LIKE 'h-%' ORDER BY id")).toEqual(["h-note"]);
});
