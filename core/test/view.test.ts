import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileView, displayName, type Filter, type View } from "../src/view.ts";
import type { Property, Row } from "../src/validate.ts";

const properties: Property[] = [
  { col: "caption", type: "text" },
  { col: "notes", type: "markdown" },
  { col: "score", type: "number" },
  { col: "enabled", type: "bool" },
  { col: "tags", type: "multi_select" },
  { col: "links", type: "multi_ref" },
  { col: "order", type: "select" },
  { col: "value", type: "text" },
  { col: "payload", type: "json" },
];

describe("compileView against SQLite", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE "group" (
      id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, deleted_at TEXT,
      caption TEXT, notes TEXT, score REAL, enabled INTEGER, tags TEXT,
      links TEXT, "order" TEXT, value TEXT, payload TEXT, private_column TEXT
    )`);
    const insert = db.query(`INSERT INTO "group"
      (id, created_at, updated_at, deleted_at, caption, notes, score, enabled,
       tags, links, "order", value, payload, private_column)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // Deliberately insert ties out of id order: a missing tie-breaker repeats/skips pages.
    for (const row of [
      ["c", "Gamma", null, 20, 0, '["redwood"]', '["ref-10"]', "second", "red", null],
      ["b", "Beta", "needle", 10, 1, '["red","blue"]', '["ref-1"]', "first", "blue", null],
      ["a", "Alpha 50%_\\", "other", 10, 0, '["blue"]', '[]', "first", "red", null],
      ["d", null, null, null, 0, null, null, null, null, null],
      ["e", "", "", 0, 0, '[]', '[]', "", "", null],
      ["z", "Deleted needle", null, 99, 1, '["red"]', '["ref-1"]', "first", "red", "deleted"],
    ] as const) {
      const [id, caption, notes, score, enabled, tags, links, order, value, deleted] = row;
      insert.run(id, "2026-01-01", "2026-01-02", deleted, caption, notes, score,
        enabled, tags, links, order, value, '{"needle":true}', "hidden needle");
    }
  });
  afterEach(() => db.close());

  function rows(view: Partial<View> = {}, catalog = properties): Row[] {
    const { sql, params } = compileView({ table: "group", ...view }, catalog);
    return db.query(sql).all(...params) as Row[];
  }
  function ids(view: Partial<View> = {}, catalog = properties) {
    return rows(view, catalog).map((row) => row.id);
  }

  test("defaults to live rows in id order and trash selects only tombstones", () => {
    expect(ids()).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids({ trash: true })).toEqual(["z"]);
    expect(ids({ trash: false })).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("quotes reserved names and projects only the requested columns", () => {
    expect(rows({ columns: ["order", "created_at", "updated_at", "deleted_at"], limit: 1 }))
      .toEqual([{ order: "first", created_at: "2026-01-01", updated_at: "2026-01-02", deleted_at: null }]);
    expect(ids({ filters: [{ column: "id", op: "eq", value: "b" }] })).toEqual(["b"]);
  });

  test("pages tied sorts by id and respects an explicit id direction", () => {
    const view: Partial<View> = { sort: [{ column: "score", direction: "desc" }], limit: 2 };
    expect(ids(view)).toEqual(["c", "a"]);
    expect(ids({ ...view, offset: 2 })).toEqual(["b", "e"]);
    expect(ids({ ...view, offset: 4 })).toEqual(["d"]);
    expect(ids({ sort: [{ column: "order", direction: "desc" }, { column: "id", direction: "desc" }] }))
      .toEqual(["c", "b", "a", "e", "d"]);
  });

  test("defaults to 50, caps at 200 and binds pagination", () => {
    db.exec('DELETE FROM "group"');
    const insert = db.query('INSERT INTO "group" (id) VALUES (?)');
    for (let i = 0; i < 205; i++) insert.run(String(i).padStart(3, "0"));
    expect(rows()).toHaveLength(50);
    expect(rows({ limit: 1000 })).toHaveLength(200);
    expect(ids({ limit: 200, offset: 200 })).toEqual(["200", "201", "202", "203", "204"]);
    expect(compileView({ table: "group", limit: 7, offset: 3 }, properties).params).toEqual([7, 3]);
  });

  test.each([
    ["eq", 10, ["a", "b"]], ["ne", 10, ["c", "d", "e"]],
    ["gt", 10, ["c"]], ["gte", 10, ["a", "b", "c"]],
    ["lt", 10, ["e"]], ["lte", 10, ["a", "b", "e"]],
    ["eq", null, ["d"]], ["ne", null, ["a", "b", "c", "e"]],
  ] as const)("%s compares %s with null-safe equality", (op, value, expected) => {
    expect(ids({ filters: [{ column: "score", op, value }] })).toEqual([...expected]);
  });

  test("combines filters with AND and converts booleans to SQLite values", () => {
    expect(ids({ filters: [
      { column: "score", op: "gte", value: 10 },
      { column: "enabled", op: "eq", value: true },
    ] })).toEqual(["b"]);
    expect(ids({ filters: [{ column: "enabled", op: "eq", value: false }] }))
      .toEqual(["a", "c", "d", "e"]);
  });

  test("text contains treats wildcards literally and is case insensitive", () => {
    expect(ids({ filters: [{ column: "caption", op: "contains", value: "ALPHA" }] })).toEqual(["a"]);
    expect(ids({ filters: [{ column: "caption", op: "contains", value: "%_\\" }] })).toEqual(["a"]);
    expect(ids({ filters: [{ column: "caption", op: "contains", value: "' OR 1=1 --" }] })).toEqual([]);
  });

  test("multi-value contains uses exact JSON elements and keeps outer columns unambiguous", () => {
    expect(ids({ filters: [{ column: "tags", op: "contains", value: "red" }] })).toEqual(["b"]);
    expect(ids({ filters: [{ column: "links", op: "contains", value: "ref-1" }] })).toEqual(["b"]);
    // json_each exposes its own `value` column, which must not shadow this table's column.
    db.exec(`UPDATE "group" SET value = '["red"]' WHERE id = 'a'`);
    const catalog = properties.map((p) => p.col === "value" ? { ...p, type: "multi_select" } : p);
    expect(ids({ filters: [{ column: "value", op: "contains", value: "red" }] }, catalog)).toEqual(["a"]);
  });

  test("JSON membership rejects scalar/object impostors and tolerates malformed stored JSON", () => {
    const update = db.query('UPDATE "group" SET tags = ? WHERE id = ?');
    update.run('{"key":"red"}', "a");
    update.run('"red"', "b");
    update.run("not JSON", "c");
    update.run('[null,1,"1","quoted\\\"value"]', "d");
    expect(ids({ filters: [{ column: "tags", op: "contains", value: "red" }] })).toEqual([]);
    expect(ids({ filters: [{ column: "tags", op: "contains", value: null }] })).toEqual(["d"]);
    expect(ids({ filters: [{ column: "tags", op: "contains", value: "quoted\"value" }] })).toEqual(["d"]);
    expect(ids({ filters: [{ column: "tags", op: "not_empty" }] })).toEqual(["a", "b", "c", "d"]);
    update.run('["1"]', "d");
    expect(ids({ filters: [{ column: "tags", op: "contains", value: 1 }] })).toEqual([]);
    expect(ids({ filters: [{ column: "tags", op: "contains", value: "1" }] })).toEqual(["d"]);
  });

  test.each(["caption", "tags", "links"])("empty and not_empty partition %s", (column) => {
    const expected = column === "links" ? ["a", "d", "e"] : ["d", "e"];
    expect(ids({ filters: [{ column, op: "empty" }] })).toEqual(expected);
    expect(ids({ filters: [{ column, op: "not_empty" }] }))
      .toEqual(column === "links" ? ["b", "c"] : ["a", "b", "c"]);
    expect(ids({ filters: [{ column: "score", op: "empty" }] })).toEqual(["d"]);
  });

  test("all user values stay in bindings, even SQL-shaped values", () => {
    const value = "'); DROP TABLE \"group\"; --";
    db.query('UPDATE "group" SET caption = ?, tags = ? WHERE id = ?')
      .run(value, JSON.stringify([value]), "a");
    for (const filter of [
      { column: "caption", op: "eq", value },
      { column: "tags", op: "contains", value },
    ] satisfies Filter[]) {
      const compiled = compileView({ table: "group", filters: [filter] }, properties);
      expect(compiled.sql).not.toContain(value);
      expect(compiled.params).toContain(value);
      expect(ids({ filters: [filter] })).toEqual(["a"]);
    }
    expect(ids()).toHaveLength(5);
  });

  test("empty search needs no index; nonempty search compiles a bound FTS lookup", () => {
    const query = compileView({ table: 'group', search: 'needle' }, properties);
    expect(query.sql).toContain('_core_search_fts MATCH ?');
    expect(query.params).toEqual(['"needle"*', 'group', 50, 0]);
    expect(ids({ search: "" })).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("uncataloged columns and properties belonging to another table are rejected", () => {
    const catalog = [...properties, { tbl: "elsewhere", col: "private_column", type: "text" }];
    for (const view of [
      { columns: ["private_column"] },
      { filters: [{ column: "private_column", op: "eq", value: "secret" }] },
      { sort: [{ column: "private_column", direction: "asc" }] },
    ]) expect(() => compileView({ table: "group", ...view } as View, catalog)).toThrow();
  });
});

describe("untrusted view validation", () => {
  const invalidViews: unknown[] = [
    null, [], "group", {}, { table: null }, { table: 123 },
    { table: "group; DROP TABLE x" }, { table: "main.group" },
    ...[null, "caption", [], [123], [null], ["missing"], ['caption" --'], new Array(1)]
      .map((columns) => ({ table: "group", columns })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "10", null]
      .map((limit) => ({ table: "group", limit })),
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null]
      .map((offset) => ({ table: "group", offset })),
    ...[null, 1, "false"].map((trash) => ({ table: "group", trash })),
    ...[null, 1, {}, []].map((search) => ({ table: "group", search })),
    ...[null, {}, "score", [null], ["score"], new Array(1),
      [{ column: "score" }], [{ column: "score", direction: "ASC" }],
      [{ column: "score", direction: "desc; DROP TABLE x" }],
      [{ column: "score", direction: 1 }], [{ column: 1, direction: "asc" }],
      [{ column: "missing", direction: "asc" }],
    ].map((sort) => ({ table: "group", sort })),
    ...[null, {}, "caption", [null], ["caption"], new Array(1),
      [{}], [{ column: "caption", op: "LIKE" }],
      [{ column: "caption", op: "eq OR 1=1", value: "x" }],
      [{ column: "caption", op: "toString", value: "x" }],
      [{ column: "caption", op: "eq" }], [{ column: "caption", op: "gt", value: null }],
      [{ column: "caption", op: "contains", value: null }],
      [{ column: "caption", op: "contains", value: 1 }],
      [{ column: "caption", op: "empty", value: "ignored" }],
      ...[{}, [], NaN, Infinity, undefined, () => "x"].map((value) => [{ column: "caption", op: "eq", value }]),
      [{ column: null, op: "eq", value: "x" }],
      [{ column: "missing", op: "eq", value: "x" }],
      [{ column: "caption", op: null, value: "x" }],
    ].map((filters) => ({ table: "group", filters })),
    { table: "group", where: "1=1" },
  ];
  test.each(invalidViews.map((view, index) => [index, view] as const))(
    "rejects malformed view #%i before issuing SQL", (_index, view) => {
      expect(() => compileView(view as View, properties)).toThrow();
    },
  );
});

describe("displayName", () => {
  test.each([
    [{ id: "row-1", caption: "  Example  " }, "caption", "Example"],
    [{ id: "row-1", caption: 0 }, "caption", "0"],
    [{ id: "row-1", caption: false }, "caption", "false"],
    [{ id: "row-1", caption: "" }, "caption", "row-1"],
    [{ id: "row-1", caption: "  " }, "caption", "row-1"],
    [{ id: "row-1", caption: null }, "caption", "row-1"],
    [{ id: "row-1", caption: [] }, "caption", "row-1"],
    [{ id: "row-1", caption: {} }, "caption", "row-1"],
    [{ id: "row-1", caption: NaN }, "caption", "row-1"],
    [{ id: "row-1", name: "Do not guess", title: "Do not guess" }, undefined, "row-1"],
    [{ id: "row-1", name: "Do not guess" }, null, "row-1"],
    [{ id: "row-1" }, "missing", "row-1"],
    [{}, undefined, "Untitled"],
    [{ id: " " }, undefined, "Untitled"],
  ] as [Row, string | null | undefined, string][])("labels %j via %s", (row, column, expected) => {
    expect(displayName(row, column)).toBe(expected);
  });
});
