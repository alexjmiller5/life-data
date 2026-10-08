// --- backups: tiered SQL dumps to R2 ----------------------------------------
//
// Each database in BACKUP_DATABASES ({name: database_id}) is exported through
// D1's export API, which writes the whole SQL dump to a signed URL. The Worker
// streams that file through gzip into R2 multipart uploads, one fixed-size part
// at a time, so memory stays bounded however large the database grows. (A
// SELECT-based dump fails once one table's result outgrows D1's response
// limit: "D1_ERROR: Memory limit exceeded before EOF".) A running export
// blocks other queries on that database for its duration.
//
// R2 lifecycle rules can only expire a whole prefix by age, so tiered
// (grandfather-father-son) retention comes from WRITING into the prefix whose
// rule matches how long that copy should live. scripts/cf-r2-lifecycle.py owns
// the expiries; backupPrefixes only decides which prefixes today belongs to.
//
// Every failure posts a critical notification into the usage feed (pushed to
// enrolled devices), and the first success after a failure, or after a gap in
// the stored daily copies, posts a recovery notice.
import { ensureUsage, notify } from "./usage.js";

const API = "https://api.cloudflare.com/client/v4";
const POLL_MS = 3000;
const POLL_LIMIT = 200; // 10 minutes, inside a cron's 15-minute wall clock
// R2 multipart: every part but the last has the same size, at least 5 MiB.
const PART_BYTES = 8 << 20;
// The cron runs daily; a newer copy than this means no run was missed.
const GAP_MS = 26 * 3600_000;

export function backupPrefixes(now) {
  const prefixes = ["daily"];
  if (now.getUTCDay() === 0) prefixes.push("weekly");
  if (now.getUTCDate() === 1) prefixes.push("monthly");
  if (now.getUTCMonth() === 0 && now.getUTCDate() === 1) prefixes.push("yearly");
  return prefixes;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function backup(env, now, io = { fetch, wait }) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const db = env.AUTH_DB;
  await ensureUsage(db);
  try {
    const recovering = await missedRuns(env, now);
    const keys = await runBackup(env, now, stamp, io);
    if (recovering) {
      await notify(db, {
        id: `backup:${stamp}:recovered`, producer: "backup", type: "backup.recovered", severity: "info",
        title: "Life Data backups are working again",
        body: `Backed up ${keys.length} copies.` + (recovering.since ? ` The previous copy was from ${day(recovering.since)}.` : ""),
        data: { keys },
      });
    }
    return keys;
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 300);
    await notify(db, {
      id: `backup:${stamp}:failed`, producer: "backup", type: "backup.failed", severity: "critical",
      title: "Life Data backup failed",
      body: `The ${day(now)} backup to R2 did not complete: ${error}`,
      data: { error },
    }).catch((n) => console.log(JSON.stringify({ backup_notify_error: String(n) })));
    throw e;
  }
}

const day = (d) => d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

// A recovery is due when the last backup notice was a failure, or when the
// newest daily copy is older than one missed run (failures before alerting
// existed, or runs that never started).
async function missedRuns(env, now) {
  const last = await env.AUTH_DB.prepare(
    "SELECT type FROM _notifications WHERE producer = 'backup' ORDER BY seq DESC LIMIT 1",
  ).first();
  if (last?.type === "backup.failed") return {};
  const [name] = Object.keys(env.BACKUP_DATABASES ?? {});
  const { objects } = await env.BACKUPS.list({ prefix: `daily/${name}-` });
  const newest = objects.at(-1)?.uploaded;
  return newest && now - newest > GAP_MS ? { since: newest } : null;
}

async function runBackup(env, now, stamp, io) {
  if (!env.BACKUP_API_TOKEN) throw new Error("BACKUP_API_TOKEN is not set");
  const keys = [];
  for (const [name, id] of Object.entries(env.BACKUP_DATABASES ?? {})) {
    const url = await exportUrl(env, id, io);
    const res = await io.fetch(url);
    if (!res.ok) throw new Error(`D1 export download ${res.status}`);
    const named = backupPrefixes(now).map((prefix) => `${prefix}/${name}-${stamp}.sql.gz`);
    const stored = await store(env.BACKUPS, named, res.body.pipeThrough(new CompressionStream("gzip")));
    console.log(JSON.stringify({ backup: name, keys: named, sql_bytes: Number(res.headers.get("content-length")), gz_bytes: stored }));
    keys.push(...named);
  }
  return keys;
}

// Starts an export, then polls with its bookmark until the file is ready.
async function exportUrl(env, id, io) {
  const url = `${API}/accounts/${env.ACCOUNT_ID}/d1/database/${id}/export`;
  let body = { output_format: "polling" };
  for (let poll = 0; poll < POLL_LIMIT; poll++) {
    const res = await io.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.BACKUP_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => null);
    if (!out?.success) throw new Error(`D1 export ${res.status}: ${JSON.stringify(out?.errors ?? out)}`);
    const { status, error, at_bookmark, result } = out.result;
    if (status === "error") throw new Error(`D1 export: ${error}`);
    if (result?.signed_url) return result.signed_url;
    body = { output_format: "polling", current_bookmark: at_bookmark };
    await io.wait(POLL_MS);
  }
  throw new Error("D1 export did not finish in 10 minutes");
}

// Streams into one multipart upload per key; aborts all of them on any error,
// so a broken stream never leaves a truncated copy. Returns the bytes stored.
async function store(bucket, keys, stream) {
  const uploads = await Promise.all(
    keys.map((key) => bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/gzip" } })),
  );
  const parts = uploads.map(() => []);
  let bytes = 0;
  try {
    let n = 0;
    for await (const part of fixedParts(stream, PART_BYTES)) {
      n++;
      bytes += part.length;
      const done = await Promise.all(uploads.map((u) => u.uploadPart(n, part)));
      done.forEach((p, i) => parts[i].push(p));
    }
    await Promise.all(uploads.map((u, i) => u.complete(parts[i])));
    return bytes;
  } catch (e) {
    await Promise.allSettled(uploads.map((u) => u.abort()));
    throw e;
  }
}

async function* fixedParts(stream, size) {
  let buf = new Uint8Array(size);
  let fill = 0;
  for await (const chunk of stream) {
    for (let at = 0; at < chunk.length; ) {
      const n = Math.min(size - fill, chunk.length - at);
      buf.set(chunk.subarray(at, at + n), fill);
      fill += n;
      at += n;
      if (fill === size) {
        yield buf;
        buf = new Uint8Array(size);
        fill = 0;
      }
    }
  }
  if (fill) yield buf.subarray(0, fill);
}
