import { afterEach, expect, test } from "bun:test";
import * as core from "../src/index.ts";
import { TestSql, schema, T0 } from "./support.ts";
import views from '../schema/saved-views.json';
import relatedDefaults from '../schema/related-view-defaults.json';
const databases: TestSql[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.db.close();
});
async function local() {
  const db = new TestSql();
  databases.push(db);
  for (const ddl of schema) await db.run(ddl);
  await db.run(
    "CREATE TABLE catalog_tables (id TEXT PRIMARY KEY,display TEXT,deleted_at TEXT)",
  );
  await db.run("ALTER TABLE catalog_properties ADD COLUMN label TEXT");
  await db.run(
    "CREATE TABLE targets (id TEXT PRIMARY KEY COLLATE NOCASE,title TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)",
  );
  await db.run(
    "CREATE TABLE entries (id TEXT PRIMARY KEY,title TEXT,owner TEXT,related TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)",
  );
  await db.run(
    "INSERT INTO catalog_tables(id,display) VALUES ('targets','title'),('entries','title'),('items','name')",
  );
  await db.run(
    "INSERT INTO catalog_properties(id,tbl,col,type,ref_table,label) VALUES ('entries.owner','entries','owner','ref','targets','Owner'),('entries.related','entries','related','multi_ref','targets',NULL),('entries.title','entries','title','text','targets','Title')",
  );
  await db.run(
    "INSERT INTO targets(id,title,updated_at) VALUES ('Target','Target record',?)",
    [T0],
  );
  await db.run(
    "INSERT INTO entries(id,title,owner,related,updated_at) VALUES ('a','First','target','[\"TARGET\",\"TARGET\",\"other\"]',?),('b','Second','other','[\"Target-extra\"]',?),('c','Third',NULL,'broken JSON',?),('d',NULL,'TARGET','{\"id\":\"Target\"}',?)",
    [T0, T0, T0, T0],
  );
  await core.initCore(db);
  return db;
}
async function call(db: TestSql, method: string, args: unknown) {
  const handlers: any = core.createCoreHandlers(db, () => {
    throw Error("Reference reads must stay local");
  });
  expect(typeof handlers[method], `shared ${method} operation`).toBe(
    "function",
  );
  return handlers[method](args);
}
const source = {
  table: "entries",
  column: "owner",
  label: "Owner",
  type: "ref",
  incomplete: false,
};
const args = {
  table: "targets",
  rowId: "Target",
  sourceTable: "entries",
  column: "owner",
};
const ids = (page: any) => page.rows.map((row: any) => row.record.id);
test('related views filter before pagination, preserve sorting and full rows without hiding links by the table default',async()=>{
 const db=await local();
 for(const ddl of ['ALTER TABLE catalog_tables ADD COLUMN kind TEXT','ALTER TABLE catalog_properties ADD COLUMN source TEXT','ALTER TABLE catalog_properties ADD COLUMN source_ref TEXT'])await db.run(ddl);
 for(const storage of [views,relatedDefaults]){
  for(const ddl of storage.ddl)await db.run(ddl);
  await db.run('INSERT INTO catalog_tables(id,kind,display) VALUES (?,?,?)',[storage.table.id,storage.table.kind,storage.table.display]);
  for(const p of storage.properties){const keys=Object.keys(p);await db.run(`INSERT INTO catalog_properties(${keys.join(',')}) VALUES (${keys.map(()=>'?')})`,Object.values(p));}
 }
 await db.run("UPDATE entries SET title='Excluded' WHERE id='d'");
 await db.run("INSERT INTO entries(id,title,owner,updated_at) VALUES ('e','History','TARGET',?)",[T0]);
 const view=await core.saveView(db,{table:'entries',name:'Related',definition:{version:1,columns:['id'],filters:[{column:'title',op:'ne',value:'Excluded'}],sort:[{column:'title',direction:'desc'}]}});
 await core.setRelatedViewDefault(db,{table:'entries',viewId:view.id,expectedUpdatedAt:null});
 const first=await call(db,'referencedBy',{...args,limit:1});
 expect(ids(first)).toEqual(['e']);expect(first.rows[0].record.owner).toBe('TARGET');expect(first.nextOffset).toBe(1);
 const second=await call(db,'referencedBy',{...args,limit:1,offset:1});
 expect(ids(second)).toEqual(['a']);expect(second.nextOffset).toBeNull();
 expect(ids(await call(db,'referencedBy',{...args,column:'related'}))).toEqual(['a']);
 await db.run('ALTER TABLE entries ADD COLUMN starts TEXT');
 await db.run("INSERT INTO catalog_properties(id,tbl,col,type) VALUES ('entries.starts','entries','starts','date_or_datetime')");
 await db.run("UPDATE entries SET starts=CASE id WHEN 'a' THEN '2026-03-08T06:59:00Z' ELSE '2026-03-07' END");
 await core.saveView(db,{id:view.id,table:'entries',name:view.name,expectedUpdatedAt:view.updated_at!,definition:{version:2,timeZone:'America/New_York',dayStartMinutes:180,filters:[{column:'title',op:'ne',value:'Excluded'},{column:'starts',op:'eq',relative:'today'}],sort:[{column:'title',direction:'desc'}]}});
 await expect(call(db,'referencedBy',args)).rejects.toThrow(/calendar/i);
 expect(ids(await call(db,'referencedBy',{...args,calendar:{today:'2026-03-07',start:'2026-03-07T08:00:00.000Z',end:'2026-03-08T07:00:00.000Z'}}))).toEqual(['e','a']);
 expect(ids(await call(db,'referencedBy',{...args,calendar:{today:'2026-03-08',start:'2026-03-08T07:00:00.000Z',end:'2026-03-09T07:00:00.000Z'}}))).toEqual([]);
 await db.run('UPDATE views SET deleted_at=? WHERE id=?',[T0,view.id]);
 const fallback=await call(db,'referencedBy',args);
 expect(ids(fallback)).toEqual(['a','d','e']);expect(fallback.viewUnavailable).toMatch(/unavailable/i);
});
test("lists current incoming relation definitions without scanning source rows", async () => {
  const db = await local();
  await db.run("DROP TABLE entries");
  expect(await call(db, "referenceSources", { table: "targets" })).toEqual([
    source,
    { ...source, column: "related", label: "related", type: "multi_ref" },
  ]);
});
test("scalar incoming references use target identity collation and full display rows", async () => {
  const db = await local();
  const result = await call(db, "referencedBy", args);
  expect(result.source).toEqual(source);
  expect(result.nextOffset).toBeNull();
  expect(ids(result)).toEqual(["a", "d"]);
  expect(result.rows.map((r: any) => r.label)).toEqual(["First", "d"]);
  expect(result.rows[0].record.related).toBe('["TARGET","TARGET","other"]');
});
test("multi references match whole IDs once and tolerate malformed or nonarray legacy JSON", async () => {
  const db = await local();
  const result = await call(db, "referencedBy", {
    ...args,
    column: "related",
    rowId: "target",
  });
  expect(ids(result)).toEqual(["a"]);
  expect(result.source.type).toBe("multi_ref");
});
test("source trash is excluded while a trashed target remains inspectable", async () => {
  const db = await local();
  await db.run("UPDATE entries SET deleted_at=? WHERE id='a'", [T0]);
  await db.run("UPDATE targets SET deleted_at=?", [T0]);
  expect(ids(await call(db, "referencedBy", args))).toEqual(["d"]);
});
test("missing targets do not turn dangling literals into real references", async () => {
  const db = await local();
  await db.run("DELETE FROM targets WHERE id='Target'");
  expect(ids(await call(db, "referencedBy", args))).toEqual([]);
});
test("pages each relation in stable ID order and exposes only a real next page", async () => {
  const db = await local();
  const first = await call(db, "referencedBy", { ...args, limit: 1 });
  expect(ids(first)).toEqual(["a"]);
  expect(first.nextOffset).toBe(1);
  const next = await call(db, "referencedBy", {
    ...args,
    limit: 1,
    offset: first.nextOffset,
  });
  expect(ids(next)).toEqual(["d"]);
  expect(next.nextOffset).toBeNull();
  expect(
    ids(await call(db, "referencedBy", { ...args, limit: 1, offset: 99 })),
  ).toEqual([]);
});
test("default and maximum page sizes bound dense groups", async () => {
  const db = await local();
  for (let i = 0; i < 110; i++)
    await db.run("INSERT INTO entries(id,title,owner) VALUES (?,?,?)", [
      `z${String(i).padStart(3, "0")}`,
      "Entry",
      "Target",
    ]);
  const normal = await call(db, "referencedBy", args);
  expect(normal.rows).toHaveLength(20);
  expect(normal.nextOffset).toBe(20);
  const maximum = await call(db, "referencedBy", { ...args, limit: 100 });
  expect(maximum.rows).toHaveLength(100);
  expect(maximum.nextOffset).toBe(100);
});
test("skipped source groups report incomplete local results even when empty", async () => {
  const db = await local();
  await db.run(
    "INSERT INTO _core_state(key,value) VALUES ('skipped_tables','[\"entries\"]')",
  );
  expect(
    (await call(db, "referenceSources", { table: "targets" })).every(
      (s: any) => s.incomplete,
    ),
  ).toBe(true);
  const result = await call(db, "referencedBy", { ...args, rowId: "not-here" });
  expect(result.source.incomplete).toBe(true);
  expect(result.rows).toEqual([]);
});
test("a skipped target also warns when missing local identity prevents resolving links", async () => {
  const db = await local();
  await db.run(
    "INSERT INTO _core_state(key,value) VALUES ('skipped_tables','[\"targets\"]')",
  );
  await db.run("DELETE FROM targets");
  const result = await call(db, "referencedBy", args);
  expect(result.rows).toEqual([]);
  expect(result.source.incomplete).toBe(true);
  expect(
    (await call(db, "referenceSources", { table: "targets" })).every(
      (source: any) => source.incomplete,
    ),
  ).toBe(true);
});
test("invalid persisted coverage status does not claim complete results", async () => {
  const db = await local();
  await db.run(
    "INSERT INTO _core_state(key,value) VALUES ('skipped_tables','broken')",
  );
  await expect(
    call(db, "referenceSources", { table: "targets" }),
  ).rejects.toThrow("Invalid saved skipped-table");
  await expect(call(db, "referencedBy", args)).rejects.toThrow(
    "Invalid saved skipped-table",
  );
});
test("deleted catalog definitions and absent source tables leave the active group list", async () => {
  const db = await local();
  await db.run(
    "UPDATE catalog_properties SET deleted_at=? WHERE col='related'",
    [T0],
  );
  expect(await call(db, "referenceSources", { table: "targets" })).toEqual([
    source,
  ]);
  await db.run("UPDATE catalog_tables SET deleted_at=? WHERE id='entries'", [
    T0,
  ]);
  expect(await call(db, "referenceSources", { table: "targets" })).toEqual([]);
  await expect(call(db, "referencedBy", args)).rejects.toThrow(
    "Reference source is not in the catalog",
  );
});
test("a deprecated live field remains a stored relationship until its catalog entry is deleted", async () => {
  const db = await local();
  await db.run("UPDATE catalog_properties SET deprecated=1 WHERE col='owner'");
  expect(ids(await call(db, "referencedBy", args))).toEqual(["a", "d"]);
});
test("the requested column must be a current relation to this target table", async () => {
  const db = await local();
  for (const input of [
    { ...args, column: "title" },
    { ...args, table: "items" },
    { ...args, sourceTable: "items" },
    { ...args, column: "missing" },
  ])
    await expect(call(db, "referencedBy", input)).rejects.toThrow(
      "Reference source is not in the catalog",
    );
  await db.run(
    "UPDATE catalog_properties SET ref_table='items' WHERE col='owner'",
  );
  await expect(call(db, "referencedBy", args)).rejects.toThrow(
    "Reference source is not in the catalog",
  );
});
test("unknown target tables are rejected before returning metadata or rows", async () => {
  const db = await local();
  await expect(
    call(db, "referenceSources", { table: "missing" }),
  ).rejects.toThrow("Table is not in the catalog");
  await expect(
    call(db, "referencedBy", { ...args, table: "missing" }),
  ).rejects.toThrow("Table is not in the catalog");
});
test("row IDs stay literal parameters including quotes and SQL punctuation", async () => {
  const db = await local();
  const id = "' OR 1=1 --";
  await db.run("INSERT INTO targets(id) VALUES (?)", [id]);
  await db.run("INSERT INTO entries(id,owner) VALUES (?,?)", ["literal", id]);
  expect(ids(await call(db, "referencedBy", { ...args, rowId: id }))).toEqual([
    "literal",
  ]);
});
test("invalid pagination and identity shapes cannot issue a broad relation query", async () => {
  const db = await local();
  for (const input of [
    null,
    [],
    {},
    { ...args, rowId: "" },
    { ...args, rowId: 1 },
    { ...args, limit: null },
    { ...args, offset: null },
    { ...args, limit: 0 },
    { ...args, limit: 101 },
    { ...args, limit: 1.5 },
    { ...args, offset: -1 },
    { ...args, offset: Number.MAX_SAFE_INTEGER },
    { ...args, unexpected: true },
  ])
    await expect(call(db, "referencedBy", input)).rejects.toThrow(
      "Invalid reference",
    );
  for (const input of [
    null,
    [],
    {},
    { table: 1 },
    { table: "targets", unexpected: true },
  ])
    await expect(call(db, "referenceSources", input)).rejects.toThrow(
      "Invalid reference",
    );
});
test("fresh reads reflect changed source rows without mutating records, pending edits or history", async () => {
  const db = await local();
  const before = JSON.stringify(
    await db.all("SELECT * FROM entries ORDER BY id"),
  );
  await call(db, "referenceSources", { table: "targets" });
  await call(db, "referencedBy", args);
  expect(
    JSON.stringify(await db.all("SELECT * FROM entries ORDER BY id")),
  ).toBe(before);
  expect(await db.all("SELECT * FROM history")).toEqual([]);
  expect(await db.all("SELECT * FROM _core_pending")).toEqual([]);
  await db.run("UPDATE entries SET owner=NULL WHERE id='a'");
  expect(ids(await call(db, "referencedBy", args))).toEqual(["d"]);
});

async function numericLinks() {
  const db = await local();
  await db.run("DELETE FROM targets");
  await db.run("INSERT INTO targets(id) VALUES ('1'),('01')");
  await db.run("DROP TABLE entries");
  await db.run(
    "CREATE TABLE entries (id TEXT PRIMARY KEY,title TEXT,owner INTEGER,related TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)",
  );
  const row = await core.writeRow(db, "entries", { owner: 1, related: [1] });
  return { db, row };
}
test("scalar source numeric affinity cannot merge distinct text target IDs", async () => {
  const { db, row } = await numericLinks();
  expect(ids(await call(db, "referencedBy", { ...args, rowId: "01" }))).toEqual(
    [],
  );
  expect(ids(await call(db, "referencedBy", { ...args, rowId: "1" }))).toEqual([
    row.id,
  ]);
});
test("numeric JSON reference values use the target text identity affinity", async () => {
  const { db, row } = await numericLinks();
  expect(
    ids(
      await call(db, "referencedBy", {
        ...args,
        column: "related",
        rowId: "1",
      }),
    ),
  ).toEqual([row.id]);
  expect(
    ids(
      await call(db, "referencedBy", {
        ...args,
        column: "related",
        rowId: "01",
      }),
    ),
  ).toEqual([]);
});
