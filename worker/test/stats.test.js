import { expect, test } from "bun:test";
import { ROUTES } from "../src/index.js";
import { D1Shim } from "./d1shim.js";

const NOW = () => new Date().toISOString();

async function hub() {
  const db = new D1Shim();
  db.db.exec("CREATE TABLE _table_stats (tbl TEXT PRIMARY KEY, rows INTEGER NOT NULL, computed_at TEXT NOT NULL)");
  db.db.exec("CREATE TABLE people (id TEXT PRIMARY KEY, hub_at TEXT)");
  db.db.exec("INSERT INTO people VALUES ('a', '2026-01-01T00:00:00.000Z'), ('b', '2026-01-01T00:00:00.000Z')");
  return db;
}

test("a table created since the daily count is counted on the next stats read", async () => {
  const db = await hub();
  expect((await ROUTES["/v1/stats"]({}, db)).tables).toEqual({ people: 2 });
  // A replay adds a table between daily counts: the size rule must see it,
  // or no replica syncs it until tomorrow.
  db.db.exec("CREATE TABLE later (id TEXT PRIMARY KEY, hub_at TEXT)");
  db.db.exec("INSERT INTO later VALUES ('x', NULL)");
  expect((await ROUTES["/v1/stats"]({}, db)).tables).toEqual({ people: 2, later: 1 });
  // Counted tables are not recounted before the day is over.
  db.db.exec("INSERT INTO people VALUES ('c', NULL)");
  expect((await ROUTES["/v1/stats"]({}, db)).tables).toEqual({ people: 2, later: 1 });
  // A dropped table leaves the answer.
  db.db.exec("DROP TABLE later");
  expect((await ROUTES["/v1/stats"]({}, db)).tables).toEqual({ people: 2 });
});

test("stale counts are recomputed after a day", async () => {
  const db = await hub();
  await ROUTES["/v1/stats"]({}, db);
  db.db.exec("INSERT INTO people VALUES ('c', NULL)");
  db.db.exec("UPDATE _table_stats SET computed_at = '2020-01-01T00:00:00.000Z'");
  expect((await ROUTES["/v1/stats"]({}, db)).tables).toEqual({ people: 3 });
  expect((await db.prepare("SELECT computed_at FROM _table_stats").first()).computed_at > NOW().slice(0, 4)).toBe(true);
});
