import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import hub from "../src/index.js";
import { backup } from "../src/backup.js";
import { D1Shim } from "./d1shim.js";

const MiB = 1 << 20;
const ACCOUNT = "acct";
const DATABASES = { life: "db-life", auth: "db-auth" };
const SUNDAY = new Date("2026-10-11T09:10:00.000Z");

// R2's multipart rules: every part but the last is the same size and at
// least 5 MiB; nothing is visible until complete(). `now` stands in for R2's
// upload clock.
class FakeBucket {
  constructor() {
    this.objects = new Map();
    this.aborted = [];
    this.now = new Date();
  }
  seed(key, uploaded) {
    this.objects.set(key, { body: new Uint8Array(), uploaded, parts: 1 });
  }
  async list({ prefix = "" } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    return { objects: keys.map((key) => ({ key, uploaded: this.objects.get(key).uploaded })), truncated: false };
  }
  async createMultipartUpload(key, options) {
    const parts = new Map();
    const bucket = this;
    return {
      key,
      async uploadPart(n, data) {
        parts.set(n, new Uint8Array(data));
        return { partNumber: n, etag: `etag-${n}` };
      },
      async complete(uploaded) {
        const bodies = uploaded.map((p) => parts.get(p.partNumber));
        bodies.slice(0, -1).forEach((b) => {
          if (b.length < 5 * MiB || b.length !== bodies[0].length) throw new Error("bad part size");
        });
        const body = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of bodies) body.set(b, at), (at += b.length);
        bucket.objects.set(key, { body, uploaded: bucket.now, parts: bodies.length, options });
      },
      async abort() {
        bucket.aborted.push(key);
      },
    };
  }
}

// Incompressible, so the gzipped dump spans more than one multipart part.
function noise(bytes) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(bytes, i + 65536)));
  return out;
}

// D1's export API: the first poll reports the export running, the next one
// (carrying the bookmark) hands out the signed URL of the finished file.
function d1Api(dumps, { fail } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://signed.test/")) {
      const body = dumps[url.slice("https://signed.test/".length)];
      return body instanceof Response ? body : new Response(body);
    }
    const id = url.match(/\/accounts\/acct\/d1\/database\/([^/]+)\/export$/)?.[1];
    if (!id || init.method !== "POST") return new Response("not found", { status: 404 });
    if (fail) return Response.json({ success: false, errors: [{ code: 10000, message: fail }] }, { status: 403 });
    const body = JSON.parse(init.body);
    if (!body.current_bookmark) {
      return Response.json({ success: true, result: { type: "export", status: "active", at_bookmark: `bm-${id}` } });
    }
    return Response.json({
      success: true,
      result: {
        type: "export", status: "complete", at_bookmark: body.current_bookmark,
        result: { filename: `${id}.sql`, signed_url: `https://signed.test/${id}` },
      },
    });
  };
  return { fetch, calls };
}

function environment(extra = {}) {
  return {
    ACCOUNT_ID: ACCOUNT,
    BACKUP_API_TOKEN: "backup-token",
    BACKUP_DATABASES: DATABASES,
    BACKUPS: new FakeBucket(),
    AUTH_DB: new D1Shim(),
    ...extra,
  };
}

const io = (api) => ({ fetch: api.fetch, wait: async () => {} });
const at = (env, iso) => (env.BACKUPS.now = new Date(iso));
const notices = (env) => env.AUTH_DB.db.query("SELECT id, type, severity, title, body FROM _notifications ORDER BY seq").all();

test("backup streams each database's D1 export, gzipped, into every tier prefix it qualifies for", async () => {
  const life = noise(9 * MiB);
  const auth = new TextEncoder().encode("CREATE TABLE _tokens (hash TEXT);\n");
  const api = d1Api({ "db-life": life, "db-auth": auth });
  const env = environment();

  const keys = await backup(env, SUNDAY, io(api));

  const stamp = "2026-10-11T09-10-00";
  expect(keys).toEqual([
    `daily/life-${stamp}.sql.gz`, `weekly/life-${stamp}.sql.gz`,
    `daily/auth-${stamp}.sql.gz`, `weekly/auth-${stamp}.sql.gz`,
  ]);
  for (const key of keys) {
    const stored = env.BACKUPS.objects.get(key);
    expect(new Uint8Array(gunzipSync(stored.body))).toEqual(key.includes("/life-") ? life : auth);
    expect(stored.options.httpMetadata.contentType).toBe("application/gzip");
  }
  expect(env.BACKUPS.objects.get(keys[0]).parts).toBeGreaterThan(1);

  const exports = api.calls.filter((c) => c.url.includes("/export"));
  expect(exports.map((c) => [c.url, JSON.parse(c.init.body)])).toEqual([
    [`https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-life/export`, { output_format: "polling" }],
    [`https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-life/export`, { output_format: "polling", current_bookmark: "bm-db-life" }],
    [`https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-auth/export`, { output_format: "polling" }],
    [`https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-auth/export`, { output_format: "polling", current_bookmark: "bm-db-auth" }],
  ]);
  expect(exports.every((c) => new Headers(c.init.headers).get("Authorization") === "Bearer backup-token")).toBe(true);
});

test("a failed backup posts a critical notification, stores nothing and rethrows", async () => {
  const env = environment();
  const api = d1Api({}, { fail: "Authentication error" });

  await expect(backup(env, SUNDAY, io(api))).rejects.toThrow("Authentication error");

  expect(env.BACKUPS.objects.size).toBe(0);
  const [n, ...rest] = notices(env);
  expect(rest).toEqual([]);
  expect(n).toMatchObject({ id: "backup:2026-10-11T09-10-00:failed", type: "backup.failed", severity: "critical" });
  expect(n.body).toContain("Authentication error");
});

test("a dump that breaks mid-stream aborts its uploads instead of storing a truncated copy", async () => {
  const env = environment();
  let sent = false;
  const broken = new ReadableStream({
    pull(c) {
      if (sent) return c.error(new Error("connection reset"));
      c.enqueue(noise(9 * MiB));
      sent = true;
    },
  });
  const api = d1Api({ "db-life": new Response(broken), "db-auth": "x" });

  await expect(backup(env, SUNDAY, io(api))).rejects.toThrow("connection reset");

  expect(env.BACKUPS.objects.size).toBe(0);
  expect(env.BACKUPS.aborted.sort()).toEqual(["daily/life-2026-10-11T09-10-00.sql.gz", "weekly/life-2026-10-11T09-10-00.sql.gz"]);
  expect(notices(env).map((n) => n.type)).toEqual(["backup.failed"]);
});

test("a signed URL the export cannot be read from fails the backup", async () => {
  const env = environment();
  const api = d1Api({ "db-life": new Response("expired", { status: 403 }), "db-auth": "x" });
  await expect(backup(env, SUNDAY, io(api))).rejects.toThrow("403");
  expect(env.BACKUPS.objects.size).toBe(0);
});

test("a missing API token fails loudly", async () => {
  const env = environment({ BACKUP_API_TOKEN: undefined });
  await expect(backup(env, SUNDAY, io(d1Api({})))).rejects.toThrow("BACKUP_API_TOKEN");
  expect(notices(env).map((n) => n.type)).toEqual(["backup.failed"]);
});

test("the first success after a failure posts a recovery notification; later successes stay quiet", async () => {
  const env = environment();
  await expect(backup(env, SUNDAY, io(d1Api({}, { fail: "boom" })))).rejects.toThrow();
  const dumps = { "db-life": "life", "db-auth": "auth" };

  await backup(env, at(env, "2026-10-11T12:00:00.000Z"), io(d1Api(dumps)));
  await backup(env, at(env, "2026-10-12T09:10:00.000Z"), io(d1Api(dumps)));

  expect(notices(env).map((n) => [n.id, n.severity])).toEqual([
    ["backup:2026-10-11T09-10-00:failed", "critical"],
    ["backup:2026-10-11T12-00-00:recovered", "info"],
  ]);
});

test("a success after a gap in stored copies counts as a recovery, a daily cadence does not", async () => {
  const env = environment();
  env.BACKUPS.seed("daily/life-2026-09-07T09-10-00.sql.gz", new Date("2026-09-07T09:12:00.000Z"));
  const dumps = { "db-life": "life", "db-auth": "auth" };

  await backup(env, at(env, "2026-10-08T09:10:00.000Z"), io(d1Api(dumps)));
  await backup(env, at(env, "2026-10-09T09:10:00.000Z"), io(d1Api(dumps)));

  const all = notices(env);
  expect(all.map((n) => n.type)).toEqual(["backup.recovered"]);
  expect(all[0].body).toContain("Sep 7");
});

test("the backup cron rejects when the backup fails, so the cron history records it", async () => {
  const env = environment({ BACKUP_API_TOKEN: undefined });
  const ctx = { waitUntil() {} };
  await expect(hub.scheduled({ cron: "10 9 * * *", scheduledTime: SUNDAY.getTime() }, env, ctx)).rejects.toThrow(
    "BACKUP_API_TOKEN",
  );
});
