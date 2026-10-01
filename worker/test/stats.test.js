import { expect, test } from "bun:test";
import worker from "../src/index.js";
import { D1Shim } from "./d1shim.js";

async function seed() {
  const db = new D1Shim();
  await db.prepare("CREATE TABLE big (id TEXT PRIMARY KEY, updated_at TEXT, hub_at TEXT)").run();
  await db.prepare("CREATE TABLE small (id TEXT PRIMARY KEY, updated_at TEXT, hub_at TEXT)").run();
  for (let i = 0; i < 5; i++) await db.prepare("INSERT INTO big (id) VALUES (?)").bind(`b${i}`).run();
  await db.prepare("INSERT INTO small (id) VALUES ('s0')").run();
  return db;
}

const stats = (db, token = "test") => worker.fetch(new Request("https://hub.test/v1/stats", {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
}), { DB: db, HUB_TOKEN: "test" }, { waitUntil() {} });

test("stats report every table's row count, plumbing excluded", async () => {
  const db = await seed();
  const out = await (await stats(db)).json();
  expect(out.tables).toEqual({ big: 5, small: 1 });
  expect(out.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("stats are cached for a day: a second call does not recount", async () => {
  const db = await seed();
  const first = await (await stats(db)).json();
  await db.prepare("INSERT INTO big (id) VALUES ('b9')").run();
  const second = await (await stats(db)).json();
  expect(second).toEqual(first);
});

test("stale stats are recounted", async () => {
  const db = await seed();
  await stats(db);
  await db.prepare("INSERT INTO big (id) VALUES ('b9')").run();
  await db.prepare("UPDATE _table_stats SET computed_at = '2000-01-01T00:00:00.000Z'").run();
  expect((await (await stats(db)).json()).tables.big).toBe(6);
});

import { allowed } from "../src/index.js";
test("stats need only tables:read", () => {
  expect(allowed("/v1/stats", "POST", ["tables:read"])).toBe(true);
  expect(allowed("/v1/stats", "POST", ["streams:append"])).toBe(false);
});
