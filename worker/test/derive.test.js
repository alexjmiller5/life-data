// Hub derivation engine: named HTTP endpoints named only by the DERIVATIONS
// secret, validated output, value + provenance in one batch, and the sweep
// that finds underived and stale rows.
import { expect, test } from "bun:test";
import { D1Shim } from "./d1shim.js";
import { deriveRows, loadDerivations, sweep } from "../src/derive.js";
import { ROUTES } from "../src/index.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// Names are test fixtures only — nothing in worker/src knows them.
const ENV = {
  DERIVATIONS: JSON.stringify({
    tmdb_movie: { url: "https://derivations.example/movie", headers: { "Modal-Key": "key-1" } },
    blurb: { url: "https://derivations.example/blurb" },
  }),
};

async function seed(db) {
  for (const sql of [
    `CREATE TABLE catalog_properties (id TEXT PRIMARY KEY, tbl TEXT, col TEXT, label TEXT, sort INTEGER, type TEXT, required INTEGER, default_value TEXT, options TEXT, options_sql TEXT, min_items INTEGER, max_items INTEGER, pattern TEXT, ref_table TEXT, derived_by TEXT, inputs TEXT, immutable INTEGER, deprecated INTEGER, description TEXT, source TEXT, source_ref TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE provenance (id TEXT PRIMARY KEY, tbl TEXT, row_id TEXT, col TEXT, derived_by TEXT, inputs_hash TEXT, value_hash TEXT, source_ref TEXT, produced_at TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `CREATE TABLE movies (id TEXT PRIMARY KEY, title TEXT, genres TEXT, blurb TEXT, status TEXT, created_at TEXT DEFAULT (${NOW}), updated_at TEXT DEFAULT (${NOW}), deleted_at TEXT)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, required, immutable) VALUES ('movies.id','movies','id',0,'text',1,1)`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, pattern, derived_by, inputs) VALUES ('movies.title','movies','title',1,'text','[A-Za-z0-9 ]+','http:tmdb_movie','["id"]')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.genres','movies','genres',2,'json','http:tmdb_movie','["id"]')`,
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, options) VALUES ('movies.status','movies','status',3,'select','[{"v":"Not Started"},{"v":"Finished"}]')`,
    `INSERT INTO movies (id, status, updated_at) VALUES ('78','Not Started','2026-09-04T00:00:00.000Z')`,
  ])
    await db.prepare(sql).run();
  return db;
}

const fresh = async () => seed(new D1Shim());

// A fetch stub that records its calls and replies with whatever it's given.
function stub(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = typeof reply === "function" ? reply(url) : reply;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { calls, fetchImpl };
}

test("loadDerivations parses the secret and is empty when unset", () => {
  expect(loadDerivations({}).size).toBe(0);
  const m = loadDerivations(ENV);
  expect(m.get("tmdb_movie")).toEqual({ url: "https://derivations.example/movie", headers: { "Modal-Key": "key-1" } });
  expect(m.get("blurb").headers).toEqual({});
});

test("derives a row: writes values, provenance, and bumps updated_at", async () => {
  const db = await fresh();
  const { calls, fetchImpl } = stub({
    body: { title: "Blade Runner", genres: ["Sci-Fi", "Drama"], _source_ref: "tmdb:movie/78@2026-09-04" },
  });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out).toEqual({ derived: 1, failed: [] });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe("https://derivations.example/movie");
  expect(calls[0].headers["Modal-Key"]).toBe("key-1");
  expect(calls[0].body).toEqual({ tbl: "movies", id: "78", inputs: { id: "78" } });

  const row = await db.prepare("SELECT * FROM movies WHERE id = '78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.genres).toBe('["Sci-Fi","Drama"]');
  expect(row.updated_at > "2026-09-04T00:00:00.000Z").toBe(true);

  const { results } = await db.prepare("SELECT * FROM provenance ORDER BY col").all();
  expect(results.map((r) => r.id)).toEqual(["movies:78:genres", "movies:78:title"]);
  for (const p of results) {
    expect(p.tbl).toBe("movies");
    expect(p.row_id).toBe("78");
    expect(p.derived_by).toBe("http:tmdb_movie");
    expect(p.source_ref).toBe("tmdb:movie/78@2026-09-04");
    expect(p.inputs_hash).toBe(await hex('["78"]'));
    expect(p.produced_at).toBeTruthy();
    expect(p.deleted_at).toBe(null);
  }
  expect(results.find((r) => r.col === "title").value_hash).toBe(await hex("Blade Runner"));
  expect(results.find((r) => r.col === "genres").value_hash).toBe(await hex('["Sci-Fi","Drama"]'));
});

test("a non-2xx endpoint writes nothing and is reported in failed", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ status: 500, body: { error: "boom" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(0);
  expect(out.failed.length).toBe(1);
  expect(out.failed[0].id).toBe("78");
  expect(out.failed[0].error).toContain("500");

  expect((await db.prepare("SELECT * FROM movies WHERE id='78'").first()).title).toBe(null);
  expect((await db.prepare("SELECT count(*) AS n FROM provenance").first()).n).toBe(0);
});

test("keys that are not derived columns of this derivation are ignored", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ body: { status: "Nope", _source_ref: "x" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out).toEqual({ derived: 0, failed: [] });
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.status).toBe("Not Started");
  expect(row.title).toBe(null);
  expect((await db.prepare("SELECT count(*) AS n FROM provenance").first()).n).toBe(0);
});

test("a value failing its property check is not written; siblings still are", async () => {
  const db = await fresh();
  const { fetchImpl } = stub({ body: { title: "!!!", genres: ["Sci-Fi"] } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(1);
  expect(out.failed).toEqual([
    { id: "78", col: "title", error: expect.stringContaining("expected form") },
  ]);
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe(null);
  expect(row.genres).toBe('["Sci-Fi"]');
  const { results } = await db.prepare("SELECT col FROM provenance").all();
  expect(results.map((r) => r.col)).toEqual(["genres"]);
});

test("an unconfigured derivation name fails softly", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:nope','["status"]')`,
  ).run();
  const { calls, fetchImpl } = stub({ body: { title: "Blade Runner" } });

  const out = await deriveRows(db, ENV, "movies", ["78"], { fetchImpl });
  expect(out.derived).toBe(1); // tmdb_movie still ran
  expect(out.failed.length).toBe(1);
  expect(out.failed[0].error).toContain("no derivation configured");
  expect(calls.length).toBe(1);
});

test("sweep derives underived rows, skips fresh ones, and re-derives on changed inputs", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["status"]')`,
  ).run();
  const replies = {
    "https://derivations.example/movie": { body: { title: "Blade Runner", genres: ["Sci-Fi"] } },
    "https://derivations.example/blurb": { body: { blurb: "a blurb" } },
  };
  let s = stub((url) => replies[url]);

  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 2, failed: [] });
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.blurb).toBe("a blurb");

  // nothing stale now
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);

  // a bumped updated_at with unchanged inputs re-hashes but derives nothing
  await db.prepare("UPDATE movies SET updated_at = '2030-01-01T00:00:00.000Z' WHERE id='78'").run();
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);

  // changing an input re-derives (only the derivation whose inputs changed)
  await db.prepare("UPDATE movies SET status='Finished', updated_at='2030-01-02T00:00:00.000Z' WHERE id='78'").run();
  replies["https://derivations.example/blurb"] = { body: { blurb: "another blurb" } };
  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 1, failed: [] });
  expect(s.calls.map((c) => c.url)).toEqual(["https://derivations.example/blurb"]);
  expect((await db.prepare("SELECT blurb FROM movies WHERE id='78'").first()).blurb).toBe("another blurb");
});

test("POST /v1/derive: guarded identifier, capped ids, col narrows the work", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["status"]')`,
  ).run();

  await expect(ROUTES["/v1/derive"]({ table: "movies; DROP TABLE x", ids: [] }, db, ENV)).rejects.toThrow("unsafe identifier");

  const res = await ROUTES["/v1/derive"]({ table: "movies", ids: Array(51).fill("78") }, db, ENV);
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "at most 50 ids per call" });

  // col picks the derivation that produces it; its siblings ride along
  const { calls, fetchImpl } = stub({ body: { title: "Blade Runner", genres: ["Sci-Fi"] } });
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl, col: "genres" })).toEqual({ derived: 1, failed: [] });
  expect(calls.map((c) => c.url)).toEqual(["https://derivations.example/movie"]);
  const row = await db.prepare("SELECT * FROM movies WHERE id='78'").first();
  expect(row.title).toBe("Blade Runner");
  expect(row.blurb).toBe(null);
});

test("sweep on a hub with no catalog is a no-op", async () => {
  expect(await sweep(new D1Shim(), ENV)).toEqual({ derived: 0, failed: [] });
});

test("a derivation reading another's output hashes the fresh value, so it settles", async () => {
  const db = await fresh();
  await db.prepare(
    `INSERT INTO catalog_properties (id, tbl, col, sort, type, derived_by, inputs) VALUES ('movies.blurb','movies','blurb',4,'text','http:blurb','["title"]')`,
  ).run();
  const replies = {
    "https://derivations.example/movie": { body: { title: "Blade Runner", genres: ["Sci-Fi"] } },
    "https://derivations.example/blurb": { body: { blurb: "a blurb" } },
  };
  // one call, both derivations: the second must see the first's write
  let s = stub((url) => replies[url]);
  expect(await deriveRows(db, ENV, "movies", ["78"], { fetchImpl: s.fetchImpl })).toEqual({ derived: 2, failed: [] });
  // blurb's inputs_hash must be over the title this same pass wrote, not the
  // NULL it had when the row was first read
  const prov = await db.prepare("SELECT inputs_hash FROM provenance WHERE id='movies:78:blurb'").first();
  expect(prov.inputs_hash).toBe(await hex('["Blade Runner"]'));

  s = stub((url) => replies[url]);
  expect(await sweep(db, ENV, { fetchImpl: s.fetchImpl })).toEqual({ derived: 0, failed: [] });
  expect(s.calls.length).toBe(0);
});
