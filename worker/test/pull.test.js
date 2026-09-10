import { expect, test } from "bun:test";
import worker from "../src/index.js";
import { D1Shim } from "./d1shim.js";

const STAMP = "2026-01-02T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

async function seed() {
  const db = new D1Shim();
  await db.prepare(`CREATE TABLE records (
    id TEXT PRIMARY KEY, label TEXT, updated_at TEXT, deleted_at TEXT, hub_at TEXT
  )`).run();
  // Insertion order differs from id order; equal arrival times cross pages.
  for (const [id, hubAt, deletedAt] of [
    ["d", STAMP, STAMP], ["b", STAMP, null], ["0", null, null],
    ["z", OLD, null], ["c", STAMP, null], ["a", STAMP, null],
  ]) {
    await db.prepare("INSERT INTO records VALUES (?, ?, ?, ?, ?)")
      .bind(id, `record-${id}`, OLD, deletedAt, hubAt).run();
  }
  return db;
}

function pull(db, body = {}) {
  return worker.fetch(new Request("https://hub.test/v1/rows/pull", {
    method: "POST",
    headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
    body: JSON.stringify({ table: "records", columns: ["id"], since: "", ...body }),
  }), { DB: db, HUB_TOKEN: "test" }, { waitUntil() {} });
}

test("pull pages split equal hub_at boundaries without losing tombstones", async () => {
  const db = await seed();
  const body = { since: STAMP, columns: ["id", "deleted_at"], limit: 2 };
  const first = await pull(db, body);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    rows: [{ id: "a", deleted_at: null }, { id: "b", deleted_at: null }], next_cursor: "b",
  });
  expect(await (await pull(db, { ...body, after: "b" })).json()).toEqual({
    rows: [{ id: "c", deleted_at: null }, { id: "d", deleted_at: STAMP }], next_cursor: "d",
  });
  expect(await (await pull(db, { ...body, after: "d" })).json()).toEqual({
    rows: [], next_cursor: null,
  });
});

test("full pull pages include null hub_at and still advance strictly by id", async () => {
  const db = await seed();
  expect(await (await pull(db, { limit: 2 })).json()).toEqual({
    rows: [{ id: "0" }, { id: "a" }], next_cursor: "a",
  });
  expect(await (await pull(db, { limit: 2, after: "a" })).json()).toEqual({
    rows: [{ id: "b" }, { id: "c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { limit: 2, after: "c" })).json()).toEqual({
    rows: [{ id: "d" }, { id: "z" }], next_cursor: "z",
  });
});

test("pull cursor survives an omitted id without leaking it into projected rows", async () => {
  const db = await seed();
  const body = { since: STAMP, columns: ["label"], limit: 3 };
  expect(await (await pull(db, body)).json()).toEqual({
    rows: [{ label: "record-a" }, { label: "record-b" }, { label: "record-c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { ...body, after: "c" })).json()).toEqual({
    rows: [{ label: "record-d" }], next_cursor: null,
  });
});

test("pull binds arbitrary string cursors and accepts the minimum limit", async () => {
  const db = await seed();
  const after = "b' OR 1=1 --";
  await db.prepare("INSERT INTO records (id, label, hub_at) VALUES (?, ?, ?)")
    .bind(after, "quoted-id", STAMP).run();
  expect(await (await pull(db, { limit: 1, after: "b" })).json()).toEqual({
    rows: [{ id: after }], next_cursor: after,
  });
  expect(await (await pull(db, { limit: 1, after })).json()).toEqual({
    rows: [{ id: "c" }], next_cursor: "c",
  });
  expect(await (await pull(db, { limit: 1, after: "" })).json()).toEqual({
    rows: [{ id: "0" }], next_cursor: "0",
  });
});

test("paginated pull keeps the strict updated_at fallback on legacy tables", async () => {
  const db = await seed();
  await db.prepare("ALTER TABLE records DROP COLUMN hub_at").run();
  await db.prepare("UPDATE records SET updated_at = ? WHERE id IN ('b', 'd')").bind(STAMP).run();
  expect(await (await pull(db, { since: OLD, limit: 1 })).json()).toEqual({
    rows: [{ id: "b" }], next_cursor: "b",
  });
  expect(await (await pull(db, { since: OLD, limit: 1, after: "b" })).json()).toEqual({
    rows: [{ id: "d" }], next_cursor: "d",
  });
  expect(await (await pull(db, { since: STAMP, limit: 1 })).json()).toEqual({
    rows: [], next_cursor: null,
  });
  expect(await (await pull(db, { since: OLD, after: {} })).json()).toEqual({
    rows: [{ id: "d" }, { id: "b" }],
  });
});

test("limit 200 bounds pages while requests without limit keep complete legacy responses", async () => {
  const db = await seed();
  for (let i = 0; i < 201; i++) {
    await db.prepare("INSERT INTO records (id, hub_at) VALUES (?, ?)")
      .bind(`r${String(i).padStart(3, "0")}`, STAMP).run();
  }
  const first = await (await pull(db, { limit: 200 })).json();
  expect(first.rows).toHaveLength(200);
  expect(first.rows[0]).toEqual({ id: "0" });
  expect(first.next_cursor).toBe("r194");
  expect(await (await pull(db, { limit: 200, after: first.next_cursor })).json()).toEqual({
    rows: ["r195", "r196", "r197", "r198", "r199", "r200", "z"].map(id => ({ id })),
    next_cursor: null,
  });
  for (const after of [undefined, "z", null, {}]) {
    const legacy = await pull(db, { after });
    expect(legacy.status).toBe(200);
    const out = await legacy.json();
    expect(Object.keys(out)).toEqual(["rows"]);
    expect(out.rows).toHaveLength(207);
  }
});

for (const limit of [0, -1, 201, 1.5, "2", null, true, [], {}]) {
  test(`pull rejects invalid limit ${JSON.stringify(limit)} with JSON 400`, async () => {
    const response = await pull(await seed(), { limit });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  });
}

for (const after of [null, 1, true, [], {}]) {
  test(`paginated pull rejects non-string after ${JSON.stringify(after)} with JSON 400`, async () => {
    const response = await pull(await seed(), { limit: 2, after });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  });
}
