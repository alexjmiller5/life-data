import { expect, test } from "bun:test";
import hub, { SWEEP_CRON } from "../src/index.js";
import worker from "../src/main.js";
import { hashToken } from "../src/auth.js";
import { D1Shim } from "./d1shim.js";
import { period, withUsage, meteredDb, Meter, notify, ensureUsage } from "../src/usage.js";
import contract from "../../tests/fixtures/hub-usage-contract.json";

// D1 reports what it billed on every result; the bun:sqlite shim does not, so
// this one adds meta the way D1 does: rows returned as rows read, one row
// written per mutating statement, and the database size.
class MetaShim extends D1Shim {
  prepare(sql) {
    const stmt = super.prepare(sql);
    const write = /^\s*(insert|update|delete|replace)/i.test(sql) ? 1 : 0;
    for (const name of ["all", "run"]) {
      const inner = stmt[name].bind(stmt);
      stmt[name] = async () => {
        const r = await inner();
        return { ...r, meta: { rows_read: r.results?.length ?? 0, rows_written: write, size_after: 8192 } };
      };
    }
    return stmt;
  }
}

function environment(extra = {}) {
  return { HUB_TOKEN: "root", DB: new MetaShim(), AUTH_DB: new MetaShim(), ...extra };
}

// waitUntil work is what the meter flushes in; tests await all of it.
function context() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), async settle() { while (pending.length) await pending.shift(); } };
}

async function call(env, path, { method = "GET", body, token = "root" } = {}) {
  const ctx = context();
  const res = await worker.fetch(
    new Request(`https://hub.test${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

async function addToken(env, name, scopes, label = null) {
  await call(env, "/v1/usage"); // creates the auth registry
  await env.AUTH_DB.prepare("INSERT INTO _tokens (hash, name, scopes, label) VALUES (?, ?, ?, ?)")
    .bind(await hashToken(`t-${name}`), name, scopes, label).run();
  return `t-${name}`;
}

async function seedUsage(env, values, now = new Date()) {
  await ensureUsage(env.AUTH_DB);
  const { start } = period(now, 1);
  await env.AUTH_DB.prepare(
    "INSERT INTO _usage (period, principal, rows_read, rows_written, requests, updated_at) VALUES (?, 'seed', ?, ?, ?, ?)",
  ).bind(start, values.rows_read ?? 0, values.rows_written ?? 0, values.requests ?? 0, now.toISOString()).run();
}

test("operator delivery test uses the feed, deduplicates retries, and deletes only its own event", async () => {
  const env = environment();
  await ensureUsage(env.AUTH_DB);
  await notify(env.AUTH_DB, {id: "real", producer: "usage", type: "usage.threshold",
    severity: "warning", title: "Real event", body: "Unchanged"});
  const path = "/v1/notifications/test/00000000-0000-4000-8000-000000000001";
  const full = await addToken(env, "consumer", "full");
  expect((await call(env, path, {method: "POST", token: full})).status).toBe(403);
  expect((await call(env, path, {method: "DELETE", token: full})).status).toBe(403);
  expect((await call(env, path, {token: full})).status).toBe(403);
  expect((await call(env, path, {method: "POST", token: null})).status).toBe(403);
  const first = await call(env, path, {method: "POST"});
  expect(first.status).toBe(201);
  const created = await first.json();
  expect(created.id).toBe("notification-test:00000000-0000-4000-8000-000000000001");
  const status = await call(env, path);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({id: created.id, deliveries: []});
  await env.AUTH_DB.prepare(`INSERT INTO _push_registrations
    (token_hash,app_profile,installation_id,revision,state,device_token,activated_after_seq,delivery_cursor,updated_at)
    VALUES ('private-hash','fixture-app','installation','revision','active','private-token',0,0,'2026-01-01')`).run();
  await env.AUTH_DB.prepare(`INSERT INTO _push_deliveries
    (installation_id,event_id,revision,outcome,attempts,next_attempt) VALUES ('installation',?,'revision','accepted',1,0)`)
    .bind(created.id).run();
  expect(await (await call(env, path)).json()).toEqual({id: created.id,
    deliveries: [{appProfile: "fixture-app", outcome: "accepted", attempts: 1}]});
  expect((await call(env, path, {method: "POST"})).status).toBe(200);
  const feed = await (await call(env, "/v1/notifications")).json();
  expect(feed.notifications).toHaveLength(2);
  expect(feed.notifications[1]).toMatchObject({id: created.id, producer: "delivery-test",
    type: "notification.test", title: "Life notification test", read_at: null, data: {}});
  expect((await call(env, path, {method: "DELETE"})).status).toBe(200);
  expect((await call(env, path, {method: "DELETE"})).status).toBe(200);
  expect((await call(env, path)).status).toBe(404);
  expect((await env.AUTH_DB.prepare("SELECT * FROM _push_deliveries WHERE event_id=?").bind(created.id).all()).results).toEqual([]);
  const after = await (await call(env, "/v1/notifications")).json();
  expect(after.notifications).toHaveLength(1);
  expect(after.notifications[0]).toMatchObject({id: "real", read_at: null});
  await notify(env.AUTH_DB, {id: created.id, producer: "usage", type: "usage.threshold",
    severity: "warning", title: "Unrelated producer", body: "Keep"});
  await call(env, path, {method: "DELETE"});
  expect(await env.AUTH_DB.prepare("SELECT producer FROM _notifications WHERE id=?")
    .bind(created.id).first()).toEqual({producer: "usage"});
  expect((await call(env, "/v1/notifications/test/real", {method: "DELETE"})).status).toBe(404);
  expect((await call(env, path + "/extra", {method: "POST"})).status).toBe(404);
  expect((await call(env, path, {method: "PUT"})).status).toBe(404);
});

// --- the period window -------------------------------------------------------

test("period runs from the anchor day to the same day next month, UTC", () => {
  expect(period(new Date("2026-10-02T12:00:00Z"), 1)).toEqual({
    start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z",
  });
  expect(period(new Date("2026-10-14T12:00:00Z"), 15)).toEqual({
    start: "2026-09-15T00:00:00.000Z", end: "2026-10-15T00:00:00.000Z",
  });
  expect(period(new Date("2026-12-31T23:59:59Z"), 1)).toEqual({
    start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z",
  });
  expect(period(new Date("2026-10-15T00:00:00Z"), 15).start).toBe("2026-10-15T00:00:00.000Z");
});

// --- the meter ---------------------------------------------------------------

test("the metered binding sums what D1 reports, and first() keeps D1's semantics", async () => {
  const raw = new MetaShim();
  await raw.prepare("CREATE TABLE t (a INTEGER, b TEXT)").run();
  await raw.prepare("INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z')").run();
  const db = meteredDb(raw);
  expect(meteredDb(raw)).toBe(db); // one stable wrapper per binding: identity caches keep working
  const meter = new Meter();
  await Meter.run(meter, async () => {
    expect((await db.prepare("SELECT * FROM t").all()).results.length).toBe(3);
    expect(await db.prepare("SELECT a FROM t WHERE a > ?").bind(1).first("a")).toBe(2);
    expect(await db.prepare("SELECT * FROM t WHERE a > 9").first()).toBe(null);
    await expect(db.prepare("SELECT a FROM t").first("nope")).rejects.toThrow("D1_COLUMN_NOTFOUND");
    await db.batch([db.prepare("UPDATE t SET b = 'w' WHERE a = 1"), db.prepare("SELECT * FROM t")]);
  });
  // 3 (all) + 2 (first a>1) + 0 + 3 (first nope) + 0 + 3 (batch select) rows read; one write
  expect(meter.rows_read).toBe(11);
  expect(meter.rows_written).toBe(1);
  expect(meter.size).toBe(8192);
});

test("queries outside a metered request are not attributed to anyone", async () => {
  const raw = new MetaShim();
  const db = meteredDb(raw);
  const meter = new Meter();
  await db.prepare("SELECT 1").all();
  expect(meter.rows_read).toBe(0);
});

test("every request is recorded per principal for the current period", async () => {
  const env = environment();
  const token = await addToken(env, "device:mac", "full", "Mac");
  await call(env, "/v1/cursor", { method: "POST", body: { tables: [] }, token });
  await call(env, "/v1/cursor", { method: "POST", body: { tables: [] }, token });
  const usage = await (await call(env, "/v1/usage")).json();
  const mac = usage.by_principal.find((p) => p.id === "device:mac");
  expect(mac).toMatchObject({ label: "Mac", kind: "token", requests: 2 });
  expect(mac.rows_read).toBeGreaterThan(0);
  const admin = usage.by_principal.find((p) => p.id === "admin");
  expect(admin.kind).toBe("operator");
  expect(usage.metrics.requests.used).toBe(usage.by_principal.reduce((n, p) => n + p.requests, 0));
  expect(usage.metrics.d1_storage_bytes).toMatchObject({ kind: "gauge", used: 16384 }); // DB + AUTH_DB
});

// --- thresholds and notifications --------------------------------------------

test("crossing an alert threshold creates exactly one notification", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { allowance: 10, cap: null, alert_at: [0.2] } }) });
  await seedUsage(env, { rows_read: 1 });
  await env.DB.prepare("CREATE TABLE t (id TEXT PRIMARY KEY, updated_at TEXT)").run();
  await env.DB.prepare("INSERT INTO t VALUES ('a', 'x'), ('b', 'y'), ('c', 'z')").run();
  // each cursor round reads t's schema and max(updated_at): crosses 2 of 10
  await call(env, "/v1/cursor", { method: "POST", body: { tables: ["t"] } });
  await call(env, "/v1/cursor", { method: "POST", body: { tables: ["t"] } });
  const page = await (await call(env, "/v1/notifications")).json();
  const alerts = page.notifications.filter((n) => n.type === "usage.threshold");
  expect(alerts.length).toBe(1);
  expect(alerts[0]).toMatchObject({ producer: "usage", severity: "info", read_at: null });
  expect(alerts[0].data).toMatchObject({ metric: "d1_rows_read", fraction: 0.2, allowance: 10 });
  expect(alerts[0].id).toBe(`usage:${period(new Date(), 1).start.slice(0, 10)}:d1_rows_read:20`);
  sameShape(alerts[0].data, contract.notification_data["usage.threshold"]);
});

test("the same threshold id is never inserted twice (concurrent isolates)", async () => {
  const env = environment();
  await ensureUsage(env.AUTH_DB);
  const n = { id: "usage:x:1", producer: "usage", type: "usage.threshold", severity: "info", title: "t", body: "b", data: {} };
  expect(await notify(env.AUTH_DB, n)).toBe(true);
  expect(await notify(env.AUTH_DB, n)).toBe(false);
});

// --- the hard cap ---------------------------------------------------------------

test("at the cap, sync routes refuse with a structured error and the rest stays up", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 100 } }) });
  await seedUsage(env, { rows_read: 100 });
  const refused = await call(env, "/v1/rows/pull", { method: "POST", body: { table: "t" } });
  expect(refused.status).toBe(429);
  const err = await refused.json();
  expect(err).toMatchObject({ error: "usage_cap", metric: "d1_rows_read", used: 100, cap: 100 });
  expect(err.retry_after).toBeGreaterThan(0);
  expect(refused.headers.get("Retry-After")).toBe(String(err.retry_after));
  expect(Date.parse(err.resets_at)).toBeGreaterThan(Date.now());
  for (const path of ["/health", "/v1/usage", "/v1/notifications"]) {
    expect((await call(env, path)).status).toBe(200);
  }
  const usage = await (await call(env, "/v1/usage")).json();
  expect(usage.capped).toMatchObject({ metric: "d1_rows_read", cap: 100 });
  expect(usage.capped.used).toBeGreaterThanOrEqual(100); // usage and feed reads still count
});

test("below the cap, sync routes run normally", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 100 } }) });
  await seedUsage(env, { rows_read: 99 });
  expect((await call(env, "/v1/cursor", { method: "POST", body: { tables: [] } })).status).toBe(200);
});

test("the request that reaches the cap raises a critical notification", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 2, alert_at: [] } }) });
  await env.DB.prepare("CREATE TABLE t (id TEXT PRIMARY KEY, updated_at TEXT)").run();
  await env.DB.prepare("INSERT INTO t VALUES ('a', 'x'), ('b', 'y'), ('c', 'z')").run();
  await call(env, "/v1/cursor", { method: "POST", body: { tables: ["t"] } });
  const { notifications } = await (await call(env, "/v1/notifications")).json();
  expect(notifications.map((n) => [n.type, n.severity])).toEqual([["usage.cap", "critical"]]);
  sameShape(notifications[0].data, contract.notification_data["usage.cap"]);
});

test("a capped period skips the derivation sweep but keeps the backup", async () => {
  const calls = [];
  const fake = { fetch: async () => new Response("ok"), scheduled: async (event) => calls.push(event.cron) };
  const wrapped = withUsage(fake, { authenticate: async () => null, sweepCron: SWEEP_CRON });
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 1 } }) });
  await seedUsage(env, { rows_read: 5 });
  for (const cron of [SWEEP_CRON, "10 9 * * *"]) {
    const ctx = context();
    await wrapped.scheduled({ cron, scheduledTime: Date.now() }, env, ctx);
    await ctx.settle();
  }
  expect(calls).toEqual(["10 9 * * *"]);
});

// --- notifications feed ---------------------------------------------------------

async function seedNotifications(env, n) {
  await ensureUsage(env.AUTH_DB);
  for (let i = 1; i <= n; i++) {
    await notify(env.AUTH_DB, { id: `test:${i}`, producer: "test", type: "test.event", severity: "info", title: `t${i}`, body: "b", data: { i } });
  }
}

test("the feed pages in order with a cursor, and reports the baseline and unread count", async () => {
  const env = environment();
  await seedNotifications(env, 3);
  const first = await (await call(env, "/v1/notifications?limit=2")).json();
  expect(first.notifications.map((n) => n.id)).toEqual(["test:1", "test:2"]);
  expect(first.unread_count).toBe(3);
  expect(first.latest_cursor).toBe(first.notifications[1].seq + 1);
  const second = await (await call(env, `/v1/notifications?after=${first.next_cursor}`)).json();
  expect(second.notifications.map((n) => n.id)).toEqual(["test:3"]);
  expect(second.next_cursor).toBe(null);
  expect(second.notifications[0].data).toEqual({ i: 3 });
});

test("mark-read is shared, idempotent, and by id or through a cursor", async () => {
  const env = environment();
  await seedNotifications(env, 3);
  const { notifications } = await (await call(env, "/v1/notifications")).json();
  const through = { method: "POST", body: { through: notifications[1].seq } };
  expect((await (await call(env, "/v1/notifications/read", through)).json()).unread_count).toBe(1);
  expect((await (await call(env, "/v1/notifications/read", through)).json()).unread_count).toBe(1);
  const byId = { method: "POST", body: { ids: ["test:3", "missing"] } };
  expect((await (await call(env, "/v1/notifications/read", byId)).json()).unread_count).toBe(0);
  const after = await (await call(env, "/v1/notifications")).json();
  expect(after.notifications.every((n) => typeof n.read_at === "string")).toBe(true);
});

test("bad feed requests are 400s", async () => {
  const env = environment();
  expect((await call(env, "/v1/notifications?limit=0")).status).toBe(400);
  expect((await call(env, "/v1/notifications?after=x")).status).toBe(400);
  expect((await call(env, "/v1/notifications/read", { method: "POST", body: {} })).status).toBe(400);
});

test("scopes: tables:read may read usage and the feed; marking read needs full", async () => {
  const env = environment();
  const reader = await addToken(env, "svc:reader", "tables:read");
  const appender = await addToken(env, "svc:append", "streams:append");
  const device = await addToken(env, "device:phone", "full");
  expect((await call(env, "/v1/usage", { token: reader })).status).toBe(200);
  expect((await call(env, "/v1/notifications", { token: reader })).status).toBe(200);
  expect((await call(env, "/v1/notifications/read", { method: "POST", body: { ids: [] }, token: reader })).status).toBe(403);
  expect((await call(env, "/v1/usage", { token: appender })).status).toBe(403);
  expect((await call(env, "/v1/notifications/read", { method: "POST", body: { ids: [] }, token: device })).status).toBe(200);
  expect((await call(env, "/v1/usage", { token: null })).status).toBe(403);
});

// --- the client contract ---------------------------------------------------------

// Same keys and value types as the shared fixture (null on either side is a
// wildcard: a field may be unmeasured). Lists compare their first element.
function sameShape(actual, expected, path = "$") {
  if (actual === null || expected === null) return;
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    if (expected.length && actual.length) sameShape(actual[0], expected[0], `${path}[0]`);
    return;
  }
  if (typeof expected === "object") {
    expect([path, Object.keys(actual).sort()]).toEqual([path, Object.keys(expected).sort()]);
    for (const k of Object.keys(expected)) sameShape(actual[k], expected[k], `${path}.${k}`);
    return;
  }
  expect([path, typeof actual]).toEqual([path, typeof expected]);
}

test("responses match the shared client contract fixture", async () => {
  // Seeded at the cap before any request: an isolate re-reads totals every 30 s.
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 50 } }) });
  await seedUsage(env, { rows_read: 50 });
  await addToken(env, "device:mac", "full", "Mac");
  await seedNotifications(env, 1);
  sameShape(await (await call(env, "/v1/usage")).json(), contract.usage);
  sameShape(await (await call(env, "/v1/notifications")).json(), contract.notifications);
  sameShape(await (await call(env, "/v1/notifications/read", { method: "POST", body: { ids: [] } })).json(), contract.mark_read);
  const capped = await call(env, "/v1/rows/pull", { method: "POST", body: { table: "t" } });
  sameShape(await capped.json(), contract.cap_error);
  sameShape((await (await call(env, "/v1/usage")).json()).capped, contract.usage_capped.capped);
});

test("the unwrapped hub still serves requests (main.js is the deployed entry)", async () => {
  const env = environment();
  const res = await hub.fetch(new Request("https://hub.test/health"), env, context());
  expect(res.status).toBe(200);
});

test("the meter and the hub share one token lookup per request", async () => {
  const env = environment();
  const token = await addToken(env, "device:mac", "full");
  let lookups = 0;
  const prepare = env.AUTH_DB.prepare.bind(env.AUTH_DB);
  env.AUTH_DB.prepare = (sql) => {
    if (/FROM _tokens WHERE hash/.test(sql)) lookups++;
    return prepare(sql);
  };
  await call(env, "/v1/cursor", { method: "POST", body: { tables: [] }, token });
  expect(lookups).toBe(1);
});

// --- CORS for the meter's own routes (browser clients) ---------------------------

const ORIGIN = "https://client.example";

async function raw(env, path, init) {
  const ctx = context();
  const res = await worker.fetch(new Request(`https://hub.test${path}`, init), env, ctx);
  await ctx.settle();
  return res;
}

const preflight = (method, headers = "authorization", origin = ORIGIN) => ({
  method: "OPTIONS",
  headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": headers },
});

test("preflight for the usage and feed routes is answered before authentication", async () => {
  const env = environment({ CORS_ORIGINS: `https://other.example, ${ORIGIN}` });
  for (const [path, method, headers] of [
    ["/v1/notifications", "GET", "authorization"],
    ["/v1/usage", "GET", "Authorization"],
    ["/v1/notifications/read", "POST", "authorization, content-type"],
  ]) {
    const res = await raw(env, path, preflight(method, headers));
    expect([path, res.status]).toEqual([path, 204]);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain(method);
    expect(res.headers.get("Access-Control-Allow-Headers").toLowerCase()).toContain("authorization");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Vary")).toContain("Origin");
  }
});

test("preflight stays narrow: unlisted origin, method or header is refused", async () => {
  const env = environment({ CORS_ORIGINS: ORIGIN });
  for (const init of [
    preflight("GET", "authorization", "https://evil.example"),
    preflight("DELETE"),
    preflight("GET", "authorization, x-evil"),
    { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } }, // no Origin
  ]) {
    const res = await raw(env, "/v1/notifications", init);
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(null);
  }
  expect((await raw(environment(), "/v1/notifications", preflight("GET"))).status).toBe(403); // no CORS_ORIGINS
});

test("browser GET and mark-read carry CORS headers for a listed origin only", async () => {
  const env = environment({ CORS_ORIGINS: ORIGIN });
  const auth = { Authorization: "Bearer root" };
  const get = await raw(env, "/v1/notifications", { headers: { ...auth, Origin: ORIGIN } });
  expect(get.status).toBe(200);
  expect(get.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  expect(get.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  const post = await raw(env, "/v1/notifications/read", {
    method: "POST", headers: { ...auth, Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [] }),
  });
  expect(post.status).toBe(200);
  expect(post.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  const stranger = await raw(env, "/v1/usage", { headers: { ...auth, Origin: "https://evil.example" } });
  expect(stranger.status).toBe(200);
  expect(stranger.headers.get("Access-Control-Allow-Origin")).toBe(null);
});

test("a capped deployment never answers a preflight with the cap error", async () => {
  const env = environment({ CORS_ORIGINS: ORIGIN, USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 1 } }) });
  await seedUsage(env, { rows_read: 5 });
  const res = await raw(env, "/v1/rows/pull", { ...preflight("POST", "authorization, content-type"), headers: { ...preflight("POST", "authorization, content-type").headers, Authorization: "Bearer root" } });
  expect(res.status).not.toBe(429);
  const capped = await raw(env, "/v1/rows/pull", {
    method: "POST", headers: { Authorization: "Bearer root", Origin: ORIGIN }, body: JSON.stringify({ table: "t" }),
  });
  expect(capped.status).toBe(429);
  expect(capped.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN); // the browser can read why
});

// --- robustness to routes and handlers added later --------------------------------

test("the cap covers every /v1 route except the ones that never read the data D1", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 1 } }) });
  await seedUsage(env, { rows_read: 5 });
  // a route added after this wrapper (e.g. a per-table rows API) is capped by default
  expect((await call(env, "/v1/tables/products/rows", { method: "POST", body: {} })).status).toBe(429);
  for (const [path, init] of [
    ["/v1/session", {}],
    ["/v1/tokens/list", { method: "POST", body: {} }],
    ["/v1/files/a/b.txt", {}],
    ["/v1/streams/x/latest", {}],
  ]) {
    expect([path, (await call(env, path, init)).status === 429]).toEqual([path, false]);
  }
});

test("a capped deployment refuses even a token whose scope the route would reject", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 1 } }) });
  const reader = await addToken(env, "svc:narrow", "streams:append");
  await seedUsage(env, { rows_read: 5 });
  expect((await call(env, "/v1/rows/pull", { method: "POST", body: { table: "t" }, token: reader })).status).toBe(429);
});

test("handlers the hub adds later pass through instead of being dropped", () => {
  const queue = async () => {};
  const wrapped = withUsage({ fetch: async () => new Response(), scheduled: async () => {}, queue }, { authenticate: async () => null });
  expect(wrapped.queue).toBe(queue);
});

test("a restricted token's cap error carries no deployment usage numbers", async () => {
  const env = environment({ USAGE_LIMITS: JSON.stringify({ d1_rows_read: { cap: 7 } }) });
  const narrow = await addToken(env, "svc:archiver", "tables:read:products,files:read:captures/pages/");
  await seedUsage(env, { rows_read: 1234 });
  const res = await call(env, "/v1/rows/pull", { method: "POST", body: { table: "products" }, token: narrow });
  expect(res.status).toBe(429);
  const body = await res.json();
  sameShape(body, contract.cap_error_restricted);
  expect(JSON.stringify(body)).not.toMatch(/1234|1\.2K|\b7\b/);
  expect(Number(res.headers.get("Retry-After"))).toBe(body.retry_after);
});


test("subscription consumption, ACK and admin routes stay capped without leaking totals", async () => {
  const env = environment({USAGE_LIMITS:JSON.stringify({d1_rows_read:{cap:1}}),CORS_ORIGINS:"https://client.test"});
  await seedUsage(env,{rows_read:5});
  const token=await addToken(env,"narrow-capture","subscriptions:consume:11111111-1111-4111-8111-111111111111,tables:read:articles");
  const path="/v1/subscriptions/11111111-1111-4111-8111-111111111111";
  for(const [target,method,body] of [[path+"/events?wait=0","GET"],[path+"/ack","POST",{delivery_id:"unknown"}],[path,"PATCH",{state:"paused"}],["/v1/subscriptions","GET"]]) {
    const response=await call(env,target,{token,method,body});
    expect(response.status).toBe(429);sameShape(await response.json(),contract.cap_error_restricted);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await call(env,target,{method,body})).status).toBe(429);
  }
  expect((await call(env,"/v1/session",{token})).status).toBe(200);
  const response=await worker.fetch(new Request(`https://hub.test${path}`,{method:"OPTIONS",headers:{Origin:"https://client.test","Access-Control-Request-Method":"PATCH"}}),env,context());
  expect(response.status).toBe(204);
  expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
});
