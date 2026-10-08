import { afterEach, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import worker from "../src/index.js";
import { D1Shim } from "./d1shim.js";
import scopes from "../../tests/fixtures/enrollment-scopes.json";
import { validEnrollmentScopes } from "../../core/src/enrollment-scopes.ts";

const STAMP = "2026-10-07T09-10-00";
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

class Bucket {
  constructor() {
    this.objects = new Map();
    this.now = new Date("2026-10-08T12:00:00.000Z");
  }
  seed(key, bytes, uploaded, sha256) {
    this.objects.set(key, { body: bytes, uploaded: new Date(uploaded), customMetadata: {} });
    if (sha256) this.objects.set(`${key}.sha256`, { body: new Uint8Array(), uploaded: new Date(uploaded), customMetadata: { sha256 } });
  }
  async put(key, body, options = {}) {
    this.objects.set(key, { body: new Uint8Array(await new Response(body).arrayBuffer()), uploaded: this.now, customMetadata: options.customMetadata ?? {} });
  }
  async head(key) {
    const o = this.objects.get(key);
    return o && { key, size: o.body.length, uploaded: o.uploaded, customMetadata: o.customMetadata };
  }
  async get(key) {
    const o = this.objects.get(key);
    return o && { key, size: o.body.length, uploaded: o.uploaded, body: new Blob([o.body]).stream(), customMetadata: o.customMetadata };
  }
  // R2 pages at most 1000 keys; this fake pages at 2 so the route must follow cursors.
  async list({ prefix = "", cursor, include = [] } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && (!cursor || k > cursor)).sort();
    const page = keys.slice(0, 2);
    return {
      objects: page.map((key) => {
        const o = this.objects.get(key);
        return { key, size: o.body.length, uploaded: o.uploaded, ...(include.includes("customMetadata") ? { customMetadata: o.customMetadata } : {}) };
      }),
      truncated: keys.length > 2,
      ...(keys.length > 2 ? { cursor: page.at(-1) } : {}),
    };
  }
  async createMultipartUpload(key) {
    const parts = new Map();
    const bucket = this;
    return {
      async uploadPart(n, data) { parts.set(n, new Uint8Array(data)); return { partNumber: n }; },
      async complete(done) {
        const bodies = done.map((p) => parts.get(p.partNumber));
        const body = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of bodies) body.set(b, at), (at += b.length);
        bucket.objects.set(key, { body, uploaded: bucket.now, customMetadata: {} });
      },
      async abort() {},
    };
  }
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setSystemTime(); });

// D1's export API: one poll, then the signed URL of the finished SQL file.
function exportApi(sql) {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://signed.test/life") return new Response(sql);
    if (!url.endsWith("/d1/database/db-life/export") || init.method !== "POST") return new Response("no", { status: 404 });
    const body = JSON.parse(init.body);
    return Response.json({ success: true, result: body.current_bookmark
      ? { status: "complete", result: { signed_url: "https://signed.test/life" } }
      : { status: "active", at_bookmark: "bm" } });
  };
}

async function setup() {
  const env = {
    HUB_TOKEN: "root", DB: new D1Shim(), AUTH_DB: new D1Shim(), BACKUPS: new Bucket(),
    ACCOUNT_ID: "acct", BACKUP_API_TOKEN: "backup-token", BACKUP_DATABASES: { life: "db-life", auth: "db-auth" },
  };
  const ctx = { waitUntil() {} };
  const call = (path, { method = "GET", token = "root" } = {}) =>
    worker.fetch(new Request(`https://hub.test${path}`, { method, headers: { Authorization: `Bearer ${token}` } }), env, ctx);
  const mint = async (name, scopes) => {
    const r = await worker.fetch(new Request("https://hub.test/v1/tokens/create", {
      method: "POST", headers: { Authorization: "Bearer root" }, body: JSON.stringify({ name, scopes }),
    }), env, ctx);
    return (await r.json()).token;
  };
  const daily = new TextEncoder().encode("daily life dump");
  env.BACKUPS.seed(`daily/life-${STAMP}.sql.gz`, daily, "2026-10-07T09:12:00.000Z", hex(daily));
  env.BACKUPS.seed(`weekly/life-2026-10-04T09-10-00.sql.gz`, new Uint8Array([1, 2]), "2026-10-04T09:12:00.000Z");
  env.BACKUPS.seed(`daily/auth-${STAMP}.sql.gz`, new TextEncoder().encode("token hashes"), "2026-10-07T09:12:00.000Z", hex("x"));
  env.BACKUPS.seed(`manual/life-2026-10-08T08-00-00.sql.gz`, new Uint8Array([3]), "2026-10-08T08:00:30.000Z");
  return { env, call, mint, daily };
}

test("backups:read lists the data database's backups, newest first, never the auth registry's", async () => {
  const { call, mint, daily } = await setup();
  const reader = await mint("reader", "backups:read");
  const res = await call("/v1/backups", { token: reader });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ backups: [
    { key: "manual/life-2026-10-08T08-00-00.sql.gz", taken_at: "2026-10-08T08:00:30.000Z", bytes: 1, sha256: null },
    { key: `daily/life-${STAMP}.sql.gz`, taken_at: "2026-10-07T09:12:00.000Z", bytes: daily.length, sha256: hex(daily) },
    { key: "weekly/life-2026-10-04T09-10-00.sql.gz", taken_at: "2026-10-04T09:12:00.000Z", bytes: 2, sha256: null },
  ] });
});

test("a backup downloads as its stored gzip bytes; other keys are not served", async () => {
  const { call, mint, daily } = await setup();
  const reader = await mint("reader", "backups:read");
  const res = await call(`/v1/backups/daily/life-${STAMP}.sql.gz`, { token: reader });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/gzip");
  expect(res.headers.get("Content-Length")).toBe(String(daily.length));
  expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="life-${STAMP}.sql.gz"`);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(daily);
  for (const key of [`daily/auth-${STAMP}.sql.gz`, `daily/life-${STAMP}.sql.gz.sha256`, "daily/../auth.sql.gz", "daily/life-missing.sql.gz", `daily/life-2026-10-01T09-10-00.sql.gz`]) {
    expect((await call(`/v1/backups/${key}`, { token: reader })).status).toBe(404);
  }
  expect((await call(`/v1/backups/daily/auth-${STAMP}.sql.gz`)).status).toBe(404);
});

test("backup grants are their own: table grants never imply them, read never implies write", async () => {
  const { call, mint } = await setup();
  const tables = await mint("tables", "tables:read,tables:write");
  const reader = await mint("reader", "backups:read");
  expect((await call("/v1/backups", { token: tables })).status).toBe(403);
  expect((await call(`/v1/backups/daily/life-${STAMP}.sql.gz`, { token: tables })).status).toBe(403);
  expect((await call("/v1/backups", { method: "POST", token: tables })).status).toBe(403);
  expect((await call("/v1/backups", { method: "POST", token: reader })).status).toBe(403);
  expect((await call("/v1/backups", { method: "DELETE", token: reader })).status).toBe(403);
  const full = await mint("device", "full");
  expect((await call("/v1/backups", { token: full })).status).toBe(200);
  // Enrollment profiles may carry them; core, the Worker and the CLI share this grammar.
  expect(validEnrollmentScopes(["backups:read", "backups:write"])).toBe(true);
  expect(scopes.cases.filter((c) => Array.isArray(c.scopes) && c.scopes.some((s) => s.startsWith("backups:"))).every((c) => validEnrollmentScopes(c.scopes) === c.valid)).toBe(true);
});

test("backups:write takes a manual copy of the data database, at most once an hour", async () => {
  const { env, call, mint } = await setup();
  const writer = await mint("writer", "backups:write");
  exportApi("CREATE TABLE t (id TEXT);\n");
  // An hour has not passed since the seeded manual copy.
  setSystemTime(new Date("2026-10-08T08:30:00.000Z"));
  const limited = await call("/v1/backups", { method: "POST", token: writer });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBe(1830);
  expect(await limited.json()).toEqual({ error: "backup_rate_limited", retry_after: 1830 });

  setSystemTime(env.BACKUPS.now = new Date("2026-10-08T09:00:31.000Z"));
  const taken = await call("/v1/backups", { method: "POST", token: writer });
  expect(taken.status).toBe(201);
  const { backup } = await taken.json();
  const key = backup.key;
  expect(key).toMatch(/^manual\/life-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql\.gz$/);
  const stored = env.BACKUPS.objects.get(key).body;
  expect(new TextDecoder().decode(gunzipSync(stored))).toBe("CREATE TABLE t (id TEXT);\n");
  expect(backup).toEqual({ key, taken_at: "2026-10-08T09:00:31.000Z", bytes: stored.length, sha256: hex(stored) });
  expect([...env.BACKUPS.objects.keys()].filter((k) => k.includes("auth-") && k.startsWith("manual/"))).toEqual([]);
  const listed = (await (await call("/v1/backups", { token: await mint("reader", "backups:read") })).json()).backups[0];
  expect(listed).toEqual(backup);
});
