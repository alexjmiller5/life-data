import { sha256hex } from "./validate.js";

export const TOKENS_TABLE = `CREATE TABLE IF NOT EXISTS _tokens (
  hash TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  last_used_at TEXT,
  label TEXT
)`;

export async function ensureAuthReady(db) {
  if (!db) throw new Error("auth database unavailable");
  await db.prepare(TOKENS_TABLE).run();
  const { results } = await db.prepare("PRAGMA table_info(_tokens)").all();
  if (!(results ?? []).some((column) => column.name === "label")) {
    try {
      await db.prepare("ALTER TABLE _tokens ADD COLUMN label TEXT").run();
    } catch (error) {
      if (!String(error).toLowerCase().includes("duplicate column"))
        throw error;
    }
  }
}

export async function hashToken(token) {
  return sha256hex(token);
}

export function deviceName(fingerprint) {
  return `device:${fingerprint}`;
}

export function validFingerprint(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validLabel(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 100 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
