// The deployment's own usage meter, hard cap and notification feed.
//
// D1 bills rows read and written, and every D1 result reports exactly those
// numbers in `meta`. One stable wrapper per binding (so identity-keyed caches
// like ensureHubAtIndexes still hit) adds each result's meta to the meter of
// the request it runs in, found through AsyncLocalStorage, including work the
// request hands to ctx.waitUntil. After the request and that work settle, the
// meter is flushed into the period's per-principal counters in AUTH_DB (hub
// state that user schema DDL cannot reach). The flush that crosses an alert
// threshold or the cap writes a notification at that moment; once a D1 metric
// reaches its cap, the sync routes refuse with a structured 429 until the
// period resets. Usage, the feed, login and health stay up.
//
// Everything here is this deployment's own consumption. Defaults are the
// provider's included monthly allowances; USAGE_LIMITS (JSON, per metric
// {allowance, cap, alert_at}) and USAGE_PERIOD_ANCHOR_DAY override them.
import { AsyncLocalStorage } from "node:async_hooks";
import { ensureAuthReady } from "./auth.js";
import {pushRegistrationRoute,deliverPush} from './apple-push.js';
import { governanceOperation, governanceFailure } from './governance-protocol.js';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const als = new AsyncLocalStorage();

const DEFAULT_LIMITS = {
  d1_rows_read: { unit: "rows", label: "D1 reads", allowance: 25e9, cap: 25e9, alert_at: [0.2, 0.5, 0.8] },
  d1_rows_written: { unit: "rows", label: "D1 writes", allowance: 50e6, cap: 50e6, alert_at: [0.2, 0.5, 0.8] },
  // A refused request is still a billed request, so requests never cap.
  requests: { unit: "requests", label: "requests", allowance: 10e6, cap: null, alert_at: [0.5, 0.8] },
  d1_storage_bytes: { unit: "bytes", label: "D1 storage", allowance: 5e9, cap: null, alert_at: [] },
};
const CUMULATIVE = ["d1_rows_read", "d1_rows_written", "requests"];

// A capped deployment refuses every authenticated /v1 request except these,
// which never read the data D1 (usage and the feed, session, token admin, and
// files/streams/archive on R2). Deny by default, so a route added later is
// capped unless it is listed here.
const UNCAPPED_ROUTE = /^\/v1\/(usage|notifications|session|tokens|files|streams|archive)(\/|$)/;

export function limits(env) {
  let over = {};
  try {
    over = JSON.parse(env?.USAGE_LIMITS || "{}");
  } catch {
    console.log(JSON.stringify({ usage_limits_error: "USAGE_LIMITS is not JSON; using defaults" }));
  }
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_LIMITS)) out[k] = { ...v, ...(over[k] ?? {}) };
  out.requests.cap = null;
  return out;
}

const anchorDay = (env) => Math.min(28, Math.max(1, parseInt(env?.USAGE_PERIOD_ANCHOR_DAY, 10) || 1));

// [start, end) of the usage period containing `now`, UTC, from the anchor day.
export function period(now, anchor = 1) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = now.getTime() >= Date.UTC(y, m, anchor) ? Date.UTC(y, m, anchor) : Date.UTC(y, m - 1, anchor);
  const s = new Date(start);
  return { start: s.toISOString(), end: new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, anchor)).toISOString() };
}

export class Meter {
  rows_read = 0;
  rows_written = 0;
  sizes = {};
  principal = "anonymous";
  add(meta, name) {
    if (!meta) return;
    this.rows_read += meta.rows_read ?? 0;
    this.rows_written += meta.rows_written ?? 0;
    if (typeof meta.size_after === "number") this.sizes[name] = meta.size_after;
  }
  get size() {
    return Object.values(this.sizes).reduce((a, b) => a + b, 0);
  }
  static run(meter, fn) {
    return als.run(meter, fn);
  }
}

const RAW = Symbol("raw");
const wrappers = new WeakMap();

export function meteredDb(raw, name = "DB") {
  if (!raw) return raw;
  if (!wrappers.has(raw)) {
    const record = (r) => {
      als.getStore()?.add(r?.meta, name);
      return r;
    };
    const statement = (inner) => ({
      [RAW]: inner,
      bind: (...args) => statement(inner.bind(...args)),
      all: async () => record(await inner.all()),
      run: async () => record(await inner.run()),
      // D1 returns no meta from raw(); the hub's only raw() call reads zero rows.
      raw: (...args) => inner.raw(...args),
      // D1's own first() runs the whole statement and drops the meta, so all()
      // bills the same; this keeps first()'s return and error semantics.
      async first(col) {
        const row = record(await inner.all()).results?.[0];
        if (!row) return null;
        if (col === undefined) return row;
        if (!(col in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
        return row[col];
      },
    });
    wrappers.set(
      raw,
      new Proxy(raw, {
        get(target, key) {
          if (key === "prepare") return (sql) => statement(target.prepare(sql));
          if (key === "batch") {
            return async (stmts) => {
              const out = await target.batch(stmts.map((s) => s[RAW] ?? s));
              out.forEach(record);
              return out;
            };
          }
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
    );
  }
  return wrappers.get(raw);
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS _usage (
    period TEXT NOT NULL, principal TEXT NOT NULL,
    rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY (period, principal))`,
  `CREATE TABLE IF NOT EXISTS _usage_gauges (name TEXT PRIMARY KEY, value INTEGER NOT NULL, measured_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _notifications (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    producer TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', read_at TEXT)`,
];
const ready = new WeakSet();
export async function ensureUsage(db) {
  if (ready.has(db)) return;
  await db.batch(TABLES.map((s) => db.prepare(s)));
  ready.add(db);
}

const TOTALS = `SELECT coalesce(sum(rows_read), 0) AS d1_rows_read, coalesce(sum(rows_written), 0) AS d1_rows_written,
  coalesce(sum(requests), 0) AS requests, max(updated_at) AS measured_at FROM _usage WHERE period = ?`;

// A notification id is its dedupe key: the same event from two isolates (or a
// later APNs push) carries the same id, and only the first insert lands.
export async function notify(db, n) {
  const { results } = await db
    .prepare(
      "INSERT OR IGNORE INTO _notifications (id, producer, type, severity, title, body, data) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
    )
    .bind(n.id, n.producer, n.type, n.severity, n.title, n.body, JSON.stringify(n.data ?? {}))
    .all();
  return (results ?? []).length > 0;
}

const compact = (n) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const day = (iso) => new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

function crossings(L, before, after, p) {
  const out = [];
  for (const metric of CUMULATIVE) {
    const l = L[metric], was = before[metric], now = after[metric];
    const data = (fraction) => ({
      metric, unit: l.unit, used: now, allowance: l.allowance, cap: l.cap, fraction,
      period_start: p.start, period_end: p.end,
    });
    const key = `usage:${p.start.slice(0, 10)}:${metric}`;
    for (const f of l.alert_at ?? []) {
      const at = f * l.allowance;
      if (!(was < at && now >= at)) continue;
      out.push({
        id: `${key}:${Math.round(f * 100)}`, producer: "usage", type: "usage.threshold",
        severity: f >= 0.8 ? "warning" : "info",
        title: `Life Data used ${Math.round(f * 100)}% of its monthly ${l.label}`,
        body: `${compact(now)} of ${compact(l.allowance)} ${l.unit} this period (resets ${day(p.end)}).` +
          (l.cap == null ? "" : ` Sync pauses at ${compact(l.cap)}.`),
        data: data(f),
      });
    }
    if (l.cap != null && was < l.cap && now >= l.cap) {
      out.push({
        id: `${key}:cap`, producer: "usage", type: "usage.cap", severity: "critical",
        title: `Life Data paused sync: monthly ${l.label} cap reached`,
        body: `${compact(now)} of the ${compact(l.cap)} ${l.unit} cap this period. Sync resumes ${day(p.end)}.`,
        data: data(now / l.allowance),
      });
    }
  }
  return out;
}

// First cumulative metric at or past its cap, or null.
function over(L, totals, p) {
  for (const metric of CUMULATIVE) {
    const cap = L[metric].cap;
    if (cap != null && totals[metric] >= cap) return { metric, used: totals[metric], cap, resets_at: p.end };
  }
  return null;
}

// Per-isolate view of the period totals: refreshed every 30 s, and by every
// flush in this isolate, so a cap this isolate crosses applies at once.
const seen = new WeakMap();
async function capState(env, now) {
  const db = env.AUTH_DB;
  if (!db) return null;
  const p = period(now, anchorDay(env));
  let c = seen.get(db);
  if (!c || c.start !== p.start || Date.now() - c.at > 30_000) {
    await ensureUsage(db);
    c = { start: p.start, totals: await db.prepare(TOTALS).bind(p.start).first(), at: Date.now() };
    seen.set(db, c);
  }
  return over(limits(env), c.totals, p);
}

async function previewCapState(env,now) {
  const db=env.AUTH_DB;
  if (!db || !await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_usage'").first()) return null;
  const p=period(now,anchorDay(env));
  return over(limits(env),await db.prepare(TOTALS).bind(p.start).first(),p);
}

const gaugeAt = new WeakMap();
async function flush(env, meter, now) {
  const db = env.AUTH_DB; // raw binding: the meter's bookkeeping is not metered
  if (!db) return;
  await ensureUsage(db);
  const p = period(now, anchorDay(env));
  const stamp = now.toISOString();
  const [, sum] = await db.batch([
    db.prepare(
      `INSERT INTO _usage (period, principal, rows_read, rows_written, requests, updated_at) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (period, principal) DO UPDATE SET rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written, requests = requests + 1, updated_at = excluded.updated_at`,
    ).bind(p.start, meter.principal, meter.rows_read, meter.rows_written, stamp),
    db.prepare(TOTALS).bind(p.start),
  ]);
  const after = sum.results[0];
  seen.set(db, { start: p.start, totals: after, at: Date.now() });
  const before = {
    d1_rows_read: after.d1_rows_read - meter.rows_read,
    d1_rows_written: after.d1_rows_written - meter.rows_written,
    requests: after.requests - 1,
  };
  for (const n of crossings(limits(env), before, after, p)) await notify(db, n);
  // Database size changes slowly: record each binding's at most every 10 min.
  const last = gaugeAt.get(db) ?? new Map();
  gaugeAt.set(db, last);
  const due = Object.entries(meter.sizes).filter(([name]) => Date.now() - (last.get(name) ?? 0) > 600_000);
  if (due.length) {
    due.forEach(([name]) => last.set(name, Date.now()));
    await db.batch(
      due.map(([name, value]) =>
        db.prepare(
          "INSERT INTO _usage_gauges (name, value, measured_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, measured_at = excluded.measured_at",
        ).bind(`d1:${name}`, value, stamp),
      ),
    );
  }
}

// Runs `fn` under a fresh meter with metered bindings, then flushes once the
// response and everything it handed to waitUntil have settled.
async function measure(env, ctx, fn, deliverNotifications) {
  const meter = new Meter();
  const pending = [];
  const mctx = new Proxy(ctx ?? {}, {
    get(target, key) {
      if (key === "waitUntil") {
        return (p) => {
          pending.push(p);
          target.waitUntil?.(p);
        };
      }
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const menv = { ...env, DB: meteredDb(env.DB, "DB"), AUTH_DB: meteredDb(env.AUTH_DB, "AUTH_DB") };
  try {
    return await Meter.run(meter, () => fn(menv, mctx, meter));
  } finally {
    const done = (async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
      await flush(env, meter, new Date());
      try { await deliverNotifications?.(env); }
      catch { console.log(JSON.stringify({push_delivery_error:true})); }
    })().catch((e) => console.log(JSON.stringify({ usage_flush_error: String(e) })));
    ctx?.waitUntil?.(done);
  }
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

// CORS for the routes this wrapper answers itself, with the hub's CORS_ORIGINS
// rule (exact listed origins; bearer auth, never cookies). Preflight is answered
// before authentication: browsers never send credentials on OPTIONS.
// ponytail: mirrors the hub's own CORS (life-ui-foundation); share one helper once both land.
const OWN_METHODS = { "/v1/usage": ["GET"], "/v1/notifications": ["GET"], "/v1/notifications/read": ["POST"] };
const ALLOW_HEADERS = ["authorization", "content-type", "if-none-match"];

function listedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  return origin && (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).includes(origin) ? origin : null;
}

function cors(request, env, res) {
  const origin = listedOrigin(request, env);
  if (!origin) return res;
  const out = new Response(res.body, res);
  out.headers.set("Access-Control-Allow-Origin", origin);
  out.headers.append("Vary", "Origin");
  out.headers.set("Access-Control-Expose-Headers", "ETag, Date, Retry-After");
  return out;
}

function preflight(request, env, methods) {
  const origin = listedOrigin(request, env);
  const method = request.headers.get("Access-Control-Request-Method");
  const asked = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  if (!methods.includes(method) || !asked.every((h) => ALLOW_HEADERS.includes(h))) {
    return json({ error: "method or header not allowed" }, 403);
  }
  return cors(request, env, new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": methods.join(", "),
      "Access-Control-Allow-Headers": ALLOW_HEADERS.join(", "),
      "Access-Control-Max-Age": "86400",
    },
  }));
}

// Usage numbers go only to tokens that may read /v1/usage; a narrower token
// learns that the deployment is capped and when it resumes, nothing more.
function capResponse(cap, showUsage) {
  const retry = Math.max(1, Math.ceil((Date.parse(cap.resets_at) - Date.now()) / 1000));
  const l = DEFAULT_LIMITS[cap.metric];
  const { used, cap: limit, ...rest } = cap;
  return json(
    {
      error: "usage_cap",
      message: showUsage
        ? `Monthly ${l.label} cap reached (${compact(limit)} ${l.unit}); sync resumes ${cap.resets_at}.`
        : `Monthly ${l.label} cap reached; sync resumes ${cap.resets_at}.`,
      ...rest,
      ...(showUsage ? { used, cap: limit } : {}),
      retry_after: retry,
    },
    429,
    { "Retry-After": String(retry) },
  );
}

const principalKind = (id) =>
  id === "admin" ? "operator" : id === "anonymous" ? "anonymous" : id.startsWith("system:") ? "system" : "token";

export async function usageReport(env, now) {
  const db = env.AUTH_DB;
  await ensureUsage(db);
  await ensureAuthReady(db);
  const p = period(now, anchorDay(env));
  const L = limits(env);
  const [totals, principals, gauges] = await db.batch([
    db.prepare(TOTALS).bind(p.start),
    db.prepare(
      `SELECT u.principal AS id, t.label, u.rows_read, u.rows_written, u.requests
       FROM _usage u LEFT JOIN _tokens t ON t.name = u.principal WHERE u.period = ? ORDER BY u.rows_read DESC, u.principal`,
    ).bind(p.start),
    db.prepare("SELECT sum(value) AS used, max(measured_at) AS measured_at FROM _usage_gauges WHERE name LIKE 'd1:%'"),
  ]);
  const t = totals.results[0], g = gauges.results[0] ?? {};
  const metric = (key, used, measured_at) => ({
    kind: CUMULATIVE.includes(key) ? "cumulative" : "gauge",
    unit: L[key].unit,
    used,
    allowance: L[key].allowance,
    cap: L[key].cap ?? null,
    alert_at: CUMULATIVE.includes(key) ? L[key].alert_at ?? [] : [],
    measured_at: measured_at ?? null,
  });
  return {
    period: { ...p, anchor_day: anchorDay(env) },
    measured_at: t.measured_at ?? null,
    capped: over(L, t, p),
    metrics: {
      d1_rows_read: metric("d1_rows_read", t.d1_rows_read, t.measured_at),
      d1_rows_written: metric("d1_rows_written", t.d1_rows_written, t.measured_at),
      requests: metric("requests", t.requests, t.measured_at),
      d1_storage_bytes: metric("d1_storage_bytes", g.used ?? null, g.measured_at),
    },
    by_principal: (principals.results ?? []).map((r) => ({
      id: r.id, label: r.label ?? null, kind: principalKind(r.id),
      rows_read: r.rows_read, rows_written: r.rows_written, requests: r.requests,
    })),
  };
}

async function feed(db, url) {
  const q = url.searchParams;
  const limit = q.has("limit") ? Number(q.get("limit")) : 50;
  const after = q.has("after") ? Number(q.get("after")) : 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(after) || after < 0) {
    return json({ error: "limit must be 1-200 and after a non-negative integer" }, 400);
  }
  await ensureUsage(db);
  const [page, stats] = await db.batch([
    db.prepare(
      "SELECT seq, id, created_at, producer, type, severity, title, body, data, read_at FROM _notifications WHERE seq > ? ORDER BY seq LIMIT ?",
    ).bind(after, limit + 1),
    db.prepare("SELECT coalesce(max(seq), 0) AS latest, coalesce(sum(read_at IS NULL), 0) AS unread FROM _notifications"),
  ]);
  const rows = page.results ?? [];
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  return json({
    notifications: items,
    next_cursor: more ? items.at(-1).seq : null,
    latest_cursor: stats.results[0].latest,
    unread_count: stats.results[0].unread,
  });
}

async function markRead(db, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const ids = body?.ids, through = body?.through;
  const idsOk = Array.isArray(ids) && ids.every((s) => typeof s === "string");
  if (!idsOk && !Number.isInteger(through)) return json({ error: "send ids (strings) or through (a seq)" }, 400);
  await ensureUsage(db);
  const stmts = [];
  if (idsOk && ids.length) {
    stmts.push(db.prepare(
      `UPDATE _notifications SET read_at = ${NOW} WHERE read_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(ids)));
  }
  if (Number.isInteger(through)) {
    stmts.push(db.prepare(`UPDATE _notifications SET read_at = ${NOW} WHERE read_at IS NULL AND seq <= ?`).bind(through));
  }
  stmts.push(db.prepare("SELECT coalesce(sum(read_at IS NULL), 0) AS unread FROM _notifications"));
  const out = await db.batch(stmts);
  return json({ unread_count: out.at(-1).results[0].unread });
}

const READ_SCOPES = ["admin", "full", "tables:read"];
const WRITE_SCOPES = ["admin", "full"];

async function ownRoute(request, url, env, tenant) {
  if (!tenant) return json({ error: "forbidden" }, 403);
  const may = (scopes) => scopes.some((s) => tenant.scopes.includes(s));
  const { pathname } = url, method = request.method;
  if (pathname === "/v1/usage" && method === "GET") {
    return may(READ_SCOPES) ? json(await usageReport(env, new Date())) : json({ error: "insufficient scope" }, 403);
  }
  if (pathname === "/v1/notifications" && method === "GET") {
    return may(READ_SCOPES) ? feed(env.AUTH_DB, url) : json({ error: "insufficient scope" }, 403);
  }
  if (pathname === "/v1/notifications/read" && method === "POST") {
    return may(WRITE_SCOPES) ? markRead(env.AUTH_DB, request) : json({ error: "insufficient scope" }, 403);
  }
  return json({ error: "not found" }, 404);
}

export function withUsage(hub, { authenticate, sweepCron, deliverNotifications = deliverPush }) {
  return {
    // Handlers added to the hub later (queue, email, ...) pass through
    // unmetered until they are wrapped here, instead of being dropped.
    ...hub,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const governance=governanceOperation(request);
      if (governance?.preview) {
        // Preview is authenticated and capped, but never initialized, metered,
        // flushed or scheduled. Provider security logs are outside this seam.
        try {
          const tenant=await authenticate(request,env,ctx);
          const cap=tenant && await previewCapState(env,new Date());
          if (cap) return cors(request,env,governanceFailure(governance,429,'unavailable',
            {'Retry-After':String(Math.max(1,Math.ceil((Date.parse(cap.resets_at)-Date.now())/1000)))}));
          return hub.fetch(request,env,ctx);
        } catch { return cors(request,env,governanceFailure(governance,503)); }
      }
      return measure(env, ctx, async (menv, mctx, meter) => {
        if (!url.pathname.startsWith("/v1/")) return hub.fetch(request, menv, mctx);
        if (request.method === "OPTIONS") {
          // Never authenticated, never capped: the hub answers other routes' preflight.
          const methods = OWN_METHODS[url.pathname];
          return methods ? preflight(request, env, methods) : hub.fetch(request, menv, mctx);
        }
        const tenant = await authenticate(request, menv, mctx);
        if (tenant) meter.principal = tenant.name;
        try {
          if (url.pathname === "/v1/usage" || url.pathname.startsWith("/v1/notifications")) {
            return cors(request, env, await ownRoute(request, url, menv, tenant));
          }
          // Not gated on the route's scope check: a finer-grained check added
          // later (e.g. one that reads the request body) must not bypass the cap.
          if (tenant && !UNCAPPED_ROUTE.test(url.pathname) && !pushRegistrationRoute(request)) {
            const cap = await capState(env, new Date());
            if (cap) {
              const capped=capResponse(cap,READ_SCOPES.some(s=>tenant.scopes.includes(s)));
              return cors(request,env,governance
                ? governanceFailure(governance,429,'unavailable',{'Retry-After':capped.headers.get('Retry-After')})
                : capped);
            }
          }
        } catch (e) {
          return cors(request, env, json({ error: String(e) }, 500));
        }
        return hub.fetch(request, menv, mctx);
      }, deliverNotifications);
    },

    async scheduled(event, env, ctx) {
      return measure(env, ctx, async (menv, mctx, meter) => {
        const sweep = event.cron === sweepCron;
        meter.principal = sweep ? "system:sweep" : "system:backup";
        // Backups keep running at the cap: one dump is cheap next to losing data.
        if (sweep && (await capState(env, new Date()))) {
          console.log(JSON.stringify({ sweep_skipped: "usage_cap" }));
          return;
        }
        return hub.scheduled(event, menv, mctx);
      }, deliverNotifications);
    },
  };
}
