// Consumer access to hub backups: list, download and take one now. Only the
// BACKUP_DATA_DATABASE entry's copies are visible; the auth registry's never
// are. Named explicitly: Cloudflare returns JSON vars with sorted keys. `backups:read` / `backups:write` grant these
// routes (full and admin imply both); table grants never do.
import { backupNow } from "./backup.js";

const TIERS = ["manual", "daily", "weekly", "monthly", "yearly"];
const MANUAL_INTERVAL_MS = 3600_000;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const dataName = (env) => (Object.hasOwn(env.BACKUP_DATABASES ?? {}, env.BACKUP_DATA_DATABASE ?? "") ? env.BACKUP_DATA_DATABASE : null);
const keyPattern = (name) =>
  new RegExp(`^(?:${TIERS.join("|")})/${name.replace(/[^A-Za-z0-9_-]/g, "")}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.sql\\.gz$`);

export function backupsAllowed(pathname, method, scopes) {
  if (scopes.includes("admin") || scopes.includes("full")) return ["GET", "HEAD", "POST"].includes(method);
  if (method === "POST") return pathname === "/v1/backups" && scopes.includes("backups:write");
  return ["GET", "HEAD"].includes(method) && scopes.includes("backups:read");
}

async function listTier(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function listBackups(env, prefixes = TIERS) {
  const name = dataName(env);
  if (!name) return [];
  const pattern = keyPattern(name);
  const out = [];
  for (const tier of prefixes) {
    const objects = await listTier(env.BACKUPS, `${tier}/${name}-`);
    const hashes = new Map(objects.filter((o) => o.key.endsWith(".sha256")).map((o) => [o.key.slice(0, -7), o.customMetadata?.sha256]));
    for (const o of objects) {
      if (!pattern.test(o.key)) continue;
      const sha256 = hashes.get(o.key);
      out.push({ key: o.key, taken_at: o.uploaded.toISOString(), bytes: o.size, sha256: /^[0-9a-f]{64}$/.test(sha256 ?? "") ? sha256 : null });
    }
  }
  return out.sort((a, b) => (a.taken_at < b.taken_at ? 1 : a.taken_at > b.taken_at ? -1 : 0));
}

export async function handleBackups(request, env, url) {
  if (url.pathname === "/v1/backups") {
    if (request.method === "GET") return json({ backups: await listBackups(env) });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    // A D1 export blocks the data database for its duration (about 30 s).
    const [last] = await listBackups(env, ["manual"]);
    const wait = last ? Date.parse(last.taken_at) + MANUAL_INTERVAL_MS - Date.now() : 0;
    if (wait > 0) {
      const retry = Math.ceil(wait / 1000);
      return json({ error: "backup_rate_limited", retry_after: retry }, 429, { "Retry-After": String(retry) });
    }
    const { key, bytes, sha256 } = await backupNow(env, new Date());
    const stored = await env.BACKUPS.head(key);
    return json({ backup: { key, taken_at: stored.uploaded.toISOString(), bytes, sha256 } }, 201);
  }
  const key = url.pathname.slice("/v1/backups/".length);
  const name = dataName(env);
  const object = name && keyPattern(name).test(key) ? await env.BACKUPS.get(key) : null;
  if (!object) return json({ error: "not found" }, 404);
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${key.split("/").pop()}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
