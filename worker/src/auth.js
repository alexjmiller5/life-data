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

const AUTHORITY_TABLE = `CREATE TABLE IF NOT EXISTS _governance_authorities (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('user','agent','service')),
  can_propose INTEGER NOT NULL CHECK(can_propose IN (0,1)),
  can_approve INTEGER NOT NULL CHECK(can_approve IN (0,1) AND (can_approve=0 OR kind='user')),
  revoked_at TEXT
)`;

export async function ensureAuthReady(db) {
  if (!db) throw new Error("auth database unavailable");
  await db.prepare(TOKENS_TABLE).run();
  await db.prepare(AUTHORITY_TABLE).run();
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

// Only verified browser enrollment calls this with user kind. Token-admin
// requests always use agent kind; request fields never select these grants.
export function authorityStatement(db,tokenHash,kind) {
  if (!['user','agent','service'].includes(kind)) throw new Error('invalid principal kind');
  return db.prepare(`INSERT INTO _governance_authorities
    (token_hash,principal_id,kind,can_propose,can_approve)
    SELECT hash,?,?,1,? FROM _tokens WHERE hash=? AND revoked_at IS NULL
    ON CONFLICT(token_hash) DO NOTHING`).bind(crypto.randomUUID(),kind,Number(kind==='user'),tokenHash);
}

export async function readGovernanceAuthority(db,tokenHash) {
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_governance_authorities'").first()) return null;
  const row=await db.prepare(`SELECT a.* FROM _governance_authorities a JOIN _tokens t ON t.hash=a.token_hash
    WHERE a.token_hash=? AND a.revoked_at IS NULL AND t.revoked_at IS NULL`).bind(tokenHash).first();
  if (!row || !row.principal_id || !['user','agent','service'].includes(row.kind)) return null;
  return {actor:{principalId:row.principal_id,kind:row.kind},propose:row.can_propose===1,approve:row.kind==='user' && row.can_approve===1};
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
