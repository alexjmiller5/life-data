// life-data hub: the sync service. Speaks the narrow sync protocol over HTTP,
// keeps the canonical replica in D1, and writes tiered SQL backups to R2.
//
// Auth is deliberately behind one seam (`authenticate`): today a shared bearer
// token identifies the single tenant. Swapping in real per-user accounts means
// changing that function and nothing else — no route, no query, no sync logic
// knows how the caller was authenticated.

import { deriveRows, deriveStale, sweep } from "./derive.js";
import { ident, qident, sha256hex, validatePush } from "./validate.js";

// Must match the trigger in wrangler.jsonc.
const SWEEP_CRON = "*/15 * * * *";

const PLUMBING = [
  `CREATE TABLE IF NOT EXISTS _schema_log (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ddl TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _sync_state (key TEXT PRIMARY KEY, value TEXT)`,
];

// Constant-time compare so a token can't be recovered by timing the response.
function tokensMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// THE AUTH SEAM. Returns a tenant handle {db, archive, scopes} or null.
// Accepts Bearer (the CLI, dashboards) and HTTP Basic with the token as the
// password (clients that only speak Basic, e.g. OwnTracks).
//
// Two tiers: the HUB_TOKEN Worker secret is the ADMIN/root credential (full
// access + token management; lives only in 1Password and on the owner's
// machines). Everything else authenticates against the _tokens table in D1 —
// scoped, individually revocable, minted via /v1/tokens/* with the admin
// token. Tokens are stored as SHA-256 hashes; a lost D1 leaks no secrets.
const TOKENS_TABLE = `CREATE TABLE IF NOT EXISTS _tokens (
  hash TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  last_used_at TEXT
)`;

async function authenticate(request, env, ctx) {
  const header = request.headers.get("Authorization") || "";
  let token = "";
  if (header.startsWith("Bearer ")) {
    token = header.slice(7);
  } else if (header.startsWith("Basic ")) {
    try {
      token = atob(header.slice(6)).split(":").slice(1).join(":");
    } catch {
      return null;
    }
  }
  if (!token || !env.HUB_TOKEN) return null;
  if (tokensMatch(token, env.HUB_TOKEN)) {
    return { db: env.DB, archive: env.ARCHIVE, scopes: ["admin"], name: "admin" };
  }
  await env.DB.prepare(TOKENS_TABLE).run();
  const row = await env.DB.prepare(
    "SELECT name, scopes FROM _tokens WHERE hash = ? AND revoked_at IS NULL"
  )
    .bind(await sha256hex(token))
    .first();
  if (!row) return null;
  ctx.waitUntil(
    env.DB.prepare(
      "UPDATE _tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?"
    )
      .bind(row.name)
      .run()
  );
  return { db: env.DB, archive: env.ARCHIVE, scopes: row.scopes.split(","), name: row.name };
}

// Route family → scopes that may use it. "admin" implies everything;
// "full" implies everything except token management.
function allowed(pathname, method, scopes) {
  if (scopes.includes("admin")) return true;
  if (pathname.startsWith("/v1/tokens/")) return false; // admin only
  if (pathname === "/v1/backup") return scopes.includes("full");
  if (pathname.match(/^\/v1\/streams\/[^/]+\/append$/)) {
    return scopes.includes("full") || scopes.includes("streams:append");
  }
  if (pathname === "/v1/rows/push" || pathname === "/v1/derive") {
    return scopes.includes("full") || scopes.includes("tables:write");
  }
  const readOnly =
    pathname === "/v1/schema/pull" ||
    pathname === "/v1/rows/pull" ||
    pathname === "/v1/cursor" ||
    pathname === "/v1/catalog" ||
    ((method === "GET" || method === "HEAD") &&
      (pathname.startsWith("/v1/streams/") || pathname.startsWith("/v1/archive/")));
  if (readOnly) return scopes.includes("full") || scopes.includes("tables:read");
  return scopes.includes("full"); // schema/push, archive/query
}

const TOKEN_ROUTES = {
  "/v1/tokens/create": async (body, db) => {
    const value =
      "lt_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await db.prepare(TOKENS_TABLE).run();
    await db
      .prepare("INSERT INTO _tokens (hash, name, scopes) VALUES (?, ?, ?)")
      .bind(await sha256hex(value), body.name, body.scopes || "full")
      .run();
    return { name: body.name, scopes: body.scopes || "full", token: value }; // value shown ONCE
  },
  "/v1/tokens/revoke": async (body, db) => {
    await db
      .prepare(
        "UPDATE _tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?"
      )
      .bind(body.name)
      .run();
    return { revoked: body.name };
  },
  "/v1/tokens/list": async (_body, db) => {
    await db.prepare(TOKENS_TABLE).run();
    const { results } = await db
      .prepare("SELECT name, scopes, created_at, revoked_at, last_used_at FROM _tokens ORDER BY created_at")
      .all();
    return results ?? [];
  },
};

// Background derivation reports nothing to a caller, so its per-row failures
// and any thrown error are the only trace it leaves. Structured, one line.
const logDerive = (p) =>
  p
    .then((r) => {
      if (r.failed.length) console.log(JSON.stringify({ derive_failed: r.failed }));
      return r;
    })
    .catch((e) => console.log(JSON.stringify({ derive_error: String(e) })));

async function ensureReady(db) {
  for (const stmt of PLUMBING) await db.prepare(stmt).run();
}

function upsertSql(table, cols) {
  const t = qident(table);
  // the json path uses the RAW column name (it is a JSON key, not SQL)
  const extracts = cols.map((x) => `json_extract(value, '$.${ident(x)}')`).join(", ");
  const sets = cols.filter((x) => x !== "id").map((x) => `${qident(x)} = excluded.${qident(x)}`).join(", ");
  return (
    `INSERT INTO ${t} (${cols.map(qident).join(", ")}) SELECT ${extracts} FROM json_each(?) WHERE true ` +
    `ON CONFLICT(id) DO UPDATE SET ${sets} WHERE excluded.updated_at > ${t}.updated_at`
  );
}

const ROUTES = {
  "/v1/schema/pull": async (_body, db) => {
    const { results } = await db
      .prepare("SELECT applied_at, ddl FROM _schema_log ORDER BY applied_at, id")
      .all();
    return { entries: results ?? [] };
  },

  "/v1/schema/push": async (body, db) => {
    const { results } = await db.prepare("SELECT ddl FROM _schema_log").all();
    const known = new Set((results ?? []).map((r) => r.ddl));
    let applied = 0;
    for (const entry of body.entries ?? []) {
      if (known.has(entry.ddl)) continue;
      try {
        await db.prepare(entry.ddl).run();
      } catch (e) {
        const msg = String(e).toLowerCase();
        // replay is idempotent-by-skip for DDL the hub already has
        if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw e;
      }
      await db
        .prepare("INSERT INTO _schema_log (applied_at, ddl) VALUES (?, ?)")
        .bind(entry.applied_at, entry.ddl)
        .run();
      applied++;
    }
    return { applied };
  },

  "/v1/rows/pull": async (body, db) => {
    const cols = (body.columns ?? []).map(qident).join(", ");
    const { results } = await db
      .prepare(`SELECT ${cols} FROM ${qident(body.table)} WHERE updated_at > ?`)
      .bind(body.since ?? "")
      .all();
    return { rows: results ?? [] };
  },

  "/v1/rows/push": async (body, db, env, ctx) => {
    const table = ident(body.table); // before any SQL is built from it
    const rows = body.rows ?? [];
    const { accepted, rejected } = await validatePush(db, table, rows);
    if (accepted.length) {
      await db.prepare(upsertSql(table, body.columns)).bind(JSON.stringify(accepted)).run();
    }
    // Derivation happens in the background: the push response never waits on
    // an external endpoint, and a failure here is retried by the cron sweep.
    if (accepted.length && ctx && env) ctx.waitUntil(logDerive(deriveStale(db, env, table, accepted)));
    return { upserted: accepted.length, rejected };
  },

  // Synchronous derivation for a named set of rows: `life derive` and the
  // migration backfill. Capped so one call stays inside a request's budget.
  "/v1/derive": async (body, db, env) => {
    const table = ident(body.table);
    const ids = body.ids ?? [];
    if (ids.length > 50) return json({ error: "at most 50 ids per call" }, 400);
    return deriveRows(db, env, table, ids, { col: body.col ?? null });
  },

  // Backups normally run on the cron; this makes the path triggerable and
  // therefore testable. Handled specially in fetch() (needs env, not just db).
  "/v1/backup": null,

  "/v1/cursor": async (body, db) => {
    let top = "";
    for (const table of body.tables ?? []) {
      const row = await db.prepare(`SELECT max(updated_at) AS m FROM ${qident(table)}`).first();
      if (row?.m && row.m > top) top = row.m;
    }
    return { max_updated_at: top };
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// --- backups: tiered SQL dumps to R2 ----------------------------------------
//
// R2 lifecycle rules can only expire a whole prefix by age, so tiered
// (grandfather-father-son) retention comes from WRITING into the prefix whose
// rule matches how long that copy should live. scripts/cf-r2-lifecycle.py owns
// the expiries; this function only decides which prefixes today belongs to.
function backupPrefixes(now) {
  const prefixes = ["daily"];
  if (now.getUTCDay() === 0) prefixes.push("weekly");
  if (now.getUTCDate() === 1) prefixes.push("monthly");
  if (now.getUTCMonth() === 0 && now.getUTCDate() === 1) prefixes.push("yearly");
  return prefixes;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (value instanceof ArrayBuffer) return `X'${[...new Uint8Array(value)].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dumpSql(db) {
  const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
  // D1 keeps internal tables (_cf_KV, ...) in the same schema and forbids
  // reading them (SQLITE_AUTH), so they must be excluded from the dump.
  const { results: objects } = await db
    .prepare(
      `SELECT name, type, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`
    )
    .all();
  for (const obj of objects ?? []) {
    lines.push(`${obj.sql};`);
    if (obj.type !== "table") continue;
    const { results: rows } = await db.prepare(`SELECT * FROM ${qident(obj.name)}`).all();
    for (const row of rows ?? []) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => sqlLiteral(row[c])).join(", ");
      lines.push(`INSERT INTO ${qident(obj.name)} (${cols.map(qident).join(", ")}) VALUES (${vals});`);
    }
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}

async function runBackup(env, now) {
  await ensureReady(env.DB);
  const sql = await dumpSql(env.DB);
  const gz = new Response(sql).body.pipeThrough(new CompressionStream("gzip"));
  const body = await new Response(gz).arrayBuffer();
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const keys = [];
  for (const prefix of backupPrefixes(now)) {
    const key = `${prefix}/life-${stamp}.sql.gz`;
    await env.BACKUPS.put(key, body, {
      httpMetadata: { contentType: "application/gzip" },
    });
    keys.push(key);
  }
  return keys;
}

// --- streams: verbatim JSON landing + manifest + tail ------------------------
//
// Streams are append-only: the hub stores whatever JSON body arrives, byte for
// byte, as a landing object (raw is sacred; landing is never deleted). Keys
// are time-prefixed so lexicographic order == chronological order. The
// compactor reads landing via the S3 API and writes year=YYYY Parquet
// partitions; nothing here knows about any particular source.

const STREAM_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_APPEND_BYTES = 1_000_000;

function landingKey(stream, now) {
  const ts = now.toISOString().replace(/[:]/g, "-");
  return `landing/${stream}/${ts}-${crypto.randomUUID().slice(0, 8)}.json`;
}

async function streamAppend(env, stream, body, now) {
  const key = landingKey(stream, now);
  await env.ARCHIVE.put(key, body, { httpMetadata: { contentType: "application/json" } });
  // small "latest" pointer so tail is O(1) instead of a full listing
  await env.ARCHIVE.put(`state/${stream}/latest.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
  // tee into the managed pipeline (→ Iceberg table life.events in the data
  // catalog). Landing is the source of truth; the pipeline is the queryable
  // projection, so its failure must never fail an append — everything is
  // rebuildable from landing.
  let piped = false;
  try {
    const record = JSON.parse(new TextDecoder().decode(body));
    await env.EVENTS.send([{ stream, ingested_at: now.toISOString(), record }]);
    piped = true;
  } catch (e) {
    console.log(`pipeline tee failed for ${key}: ${e}`);
  }
  return { key, piped };
}

async function listAll(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function streamManifest(env, stream, origin) {
  // parquet partitions + only the landing objects NOT yet covered by them
  // (the compactor records its high-water landing key per stream)
  const toUrl = (k) => `${origin}/v1/archive/${k.split("/").map(encodeURIComponent).join("/")}`;
  const parquet = (await listAll(env.ARCHIVE, `parquet/${stream}/`)).filter((k) =>
    k.endsWith(".parquet")
  );
  const watermarkObj = await env.ARCHIVE.get(`state/${stream}/compacted_through`);
  const watermark = watermarkObj ? await watermarkObj.text() : "";
  const landing = (await listAll(env.ARCHIVE, `landing/${stream}/`)).filter((k) => k > watermark);
  return { parquet: parquet.map(toUrl), landing: landing.map(toUrl) };
}

async function handleStreams(request, env, url) {
  const parts = url.pathname.split("/").filter(Boolean); // v1 streams <name> <op>
  const [, , stream, op] = parts;
  if (!STREAM_NAME.test(stream ?? "")) return json({ error: "bad stream name" }, 400);

  if (op === "append" && request.method === "POST") {
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_APPEND_BYTES) {
      return json({ error: "body must be 1..1MB of JSON" }, 400);
    }
    return json(await streamAppend(env, stream, body, new Date()));
  }
  if (op === "replay" && request.method === "POST") {
    // Projection rebuild: tee records into the pipeline WITHOUT writing
    // landing — for replaying existing landing objects into a recreated
    // table. Same enrichment as batch. Landing is never duplicated.
    const records = await request.json();
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
      return json({ error: "body must be a JSON array of 1..1000 records" }, 400);
    }
    const ingested = new Date().toISOString();
    for (let i = 0; i < records.length; i += 100) {
      await env.EVENTS.send(
        records.slice(i, i + 100).map((record) => ({ stream, ingested_at: ingested, record }))
      );
    }
    return json({ replayed: records.length });
  }
  if (op === "batch" && request.method === "POST") {
    // Bulk import: ONE landing object holding the whole batch, pipeline sends
    // in chunks, and — unlike append — the latest.json pointer is left alone,
    // so historical imports never masquerade as the current position.
    const records = await request.json();
    if (!Array.isArray(records) || records.length === 0 || records.length > 1000) {
      return json({ error: "body must be a JSON array of 1..1000 records" }, 400);
    }
    const now = new Date();
    const key = `landing/${stream}/${now.toISOString().replace(/[:]/g, "-")}-batch-${crypto.randomUUID().slice(0, 8)}.json`;
    await env.ARCHIVE.put(key, JSON.stringify(records), {
      httpMetadata: { contentType: "application/json" },
    });
    const ingested = now.toISOString();
    for (let i = 0; i < records.length; i += 100) {
      await env.EVENTS.send(
        records.slice(i, i + 100).map((record) => ({ stream, ingested_at: ingested, record }))
      );
    }
    return json({ count: records.length, key });
  }
  if (op === "tail" && request.method === "GET") {
    const latest = await env.ARCHIVE.get(`state/${stream}/latest.json`);
    return latest
      ? new Response(latest.body, { headers: { "Content-Type": "application/json" } })
      : json(null);
  }
  if (op === "manifest" && request.method === "GET") {
    return json(await streamManifest(env, stream, url.origin));
  }
  return json({ error: "not found" }, 404);
}

async function handleArchiveGet(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice("/v1/archive/".length));
  if (key.includes("..")) return json({ error: "bad key" }, 400);
  // HEAD: DuckDB's httpfs sizes files with HEAD before ranged GETs
  if (request.method === "HEAD") {
    const head = await env.ARCHIVE.head(key);
    if (!head) return new Response(null, { status: 404 });
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(head.size));
    return new Response(null, { headers });
  }
  // range: pass the Headers object only when a Range header exists — R2
  // parses it natively. No onlyIf: conditional requests aren't needed and
  // passing arbitrary headers there caused 500s.
  const rangeHeader = request.headers.get("Range");
  const obj = rangeHeader
    ? await env.ARCHIVE.get(key, { range: request.headers })
    : await env.ARCHIVE.get(key);
  if (!obj) return json({ error: "not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  if (rangeHeader && obj.range) {
    const start = obj.range.offset ?? Math.max(0, obj.size - (obj.range.suffix ?? 0));
    const length = obj.range.length ?? obj.size - start;
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${obj.size}`);
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    const tenant = await authenticate(request, env, ctx);
    if (!tenant) return json({ error: "forbidden" }, 403);
    if (!allowed(url.pathname, request.method, tenant.scopes)) {
      return json({ error: "insufficient scope" }, 403);
    }

    try {
      if (url.pathname.startsWith("/v1/tokens/") && request.method === "POST") {
        const route = TOKEN_ROUTES[url.pathname];
        if (!route) return json({ error: "not found" }, 404);
        return json(await route(await request.json(), tenant.db));
      }
      if (url.pathname === "/v1/archive/query" && request.method === "POST") {
        // proxy to R2 SQL with the hub's own service credential, so clients
        // never hold a provider token. Table: life.events (stream, ingested_at, record.*)
        const { sql } = await request.json();
        const resp = await fetch(
          `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.ACCOUNT_ID}/r2-sql/query/${env.ARCHIVE_BUCKET}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.R2_SQL_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query: sql }),
          }
        );
        return new Response(resp.body, {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/v1/catalog" && request.method === "GET") {
        await ensureReady(tenant.db);
        const out = {};
        for (const t of ["catalog_tables", "catalog_properties", "catalog_rules"]) {
          const exists = await tenant.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(t).first();
          const { results } = exists ? await tenant.db.prepare(`SELECT * FROM ${qident(t)} WHERE deleted_at IS NULL ORDER BY id`).all() : { results: [] };
          out[t.replace("catalog_", "")] = results ?? [];
        }
        const text = JSON.stringify(out);
        const etag = `"${(await sha256hex(text)).slice(0, 32)}"`;
        if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(text, { headers: { "Content-Type": "application/json", ETag: etag } });
      }
      if (url.pathname.startsWith("/v1/streams/")) return await handleStreams(request, env, url);
      if (
        url.pathname.startsWith("/v1/archive/") &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return await handleArchiveGet(request, env, url);
      }
      if (!(url.pathname in ROUTES) || request.method !== "POST") {
        return json({ error: "not found" }, 404);
      }
      if (url.pathname === "/v1/backup") {
        return json({ keys: await runBackup(env, new Date()) });
      }
      await ensureReady(tenant.db);
      const out = await ROUTES[url.pathname](await request.json(), tenant.db, env, ctx);
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // One Worker, two schedules — dispatch on which trigger fired.
    if (event.cron === SWEEP_CRON) ctx.waitUntil(logDerive(sweep(env.DB, env)));
    else ctx.waitUntil(runBackup(env, new Date(event.scheduledTime)));
  },
};

export { ROUTES, allowed, validatePush };
