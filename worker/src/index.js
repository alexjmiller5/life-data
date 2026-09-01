// life-data hub: the sync service. Speaks the narrow sync protocol over HTTP,
// keeps the canonical replica in D1, and writes tiered SQL backups to R2.
//
// Auth is deliberately behind one seam (`authenticate`): today a shared bearer
// token identifies the single tenant. Swapping in real per-user accounts means
// changing that function and nothing else — no route, no query, no sync logic
// knows how the caller was authenticated.

const CHUNK_COLUMNS_SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

// THE AUTH SEAM. Returns a tenant handle or null. Single-tenant today.
function authenticate(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.HUB_TOKEN || !tokensMatch(token, env.HUB_TOKEN)) return null;
  return { db: env.DB };
}

function ident(name) {
  if (!CHUNK_COLUMNS_SAFE.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

async function ensureReady(db) {
  for (const stmt of PLUMBING) await db.prepare(stmt).run();
}

function upsertSql(table, cols) {
  const t = ident(table);
  const c = cols.map(ident);
  const extracts = c.map((x) => `json_extract(value, '$.${x}')`).join(", ");
  const sets = c.filter((x) => x !== "id").map((x) => `${x} = excluded.${x}`).join(", ");
  return (
    `INSERT INTO ${t} (${c.join(", ")}) SELECT ${extracts} FROM json_each(?) WHERE true ` +
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
    const cols = (body.columns ?? []).map(ident).join(", ");
    const { results } = await db
      .prepare(`SELECT ${cols} FROM ${ident(body.table)} WHERE updated_at > ?`)
      .bind(body.since ?? "")
      .all();
    return { rows: results ?? [] };
  },

  "/v1/rows/push": async (body, db) => {
    const rows = body.rows ?? [];
    if (rows.length) {
      await db.prepare(upsertSql(body.table, body.columns)).bind(JSON.stringify(rows)).run();
    }
    return { upserted: rows.length };
  },

  // Backups normally run on the cron; this makes the path triggerable and
  // therefore testable. Handled specially in fetch() (needs env, not just db).
  "/v1/backup": null,

  "/v1/cursor": async (body, db) => {
    let top = "";
    for (const table of body.tables ?? []) {
      const row = await db.prepare(`SELECT max(updated_at) AS m FROM ${ident(table)}`).first();
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
    const { results: rows } = await db.prepare(`SELECT * FROM ${ident(obj.name)}`).all();
    for (const row of rows ?? []) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => sqlLiteral(row[c])).join(", ");
      lines.push(`INSERT INTO ${obj.name} (${cols.join(", ")}) VALUES (${vals});`);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });

    const tenant = authenticate(request, env);
    if (!tenant) return json({ error: "forbidden" }, 403);

    if (!(url.pathname in ROUTES) || request.method !== "POST") {
      return json({ error: "not found" }, 404);
    }

    try {
      if (url.pathname === "/v1/backup") {
        return json({ keys: await runBackup(env, new Date()) });
      }
      await ensureReady(tenant.db);
      return json(await ROUTES[url.pathname](await request.json(), tenant.db));
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBackup(env, new Date(event.scheduledTime)));
  },
};
