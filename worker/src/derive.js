// Hub-side derivations. A derived property declares `derived_by = "http:<name>"`;
// the name is resolved ONLY through the DERIVATIONS Worker secret, so no
// external source is ever named in this repo.
//
// Protocol: POST <url> {tbl, id, inputs:{col: value}} -> a JSON object whose
// keys are column names to write, plus an optional `_source_ref`. Keys that
// are not derived columns of that derivation are ignored; a non-2xx reply or
// bad JSON leaves the cell underived and is reported in `failed`.
//
// A write is one D1 batch: the value UPDATE plus a provenance upsert per
// column, so a replica pulling the row also pulls the provenance that proves
// it and the client's `derived` rule never fires.

import { castText, ident, propertiesFor, sha256hex, validateRow } from "./validate.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function loadDerivations(env) {
  if (!env?.DERIVATIONS) return new Map();
  const obj = JSON.parse(env.DERIVATIONS);
  return new Map(Object.entries(obj).map(([k, v]) => [k, { url: v.url, headers: v.headers ?? {} }]));
}

// Derived properties of `table`, grouped by derivation name.
async function derivationProps(db, table) {
  const props = await propertiesFor(db, table);
  const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
  const byName = new Map();
  for (const p of props) {
    if (!p.derived_by?.startsWith("http:")) continue;
    const name = p.derived_by.slice(5);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(p);
  }
  return { typeOf, byName };
}

// Hash values the way SQLite renders them — a cataloged `number` binds through
// REAL — so the client and the hub agree byte for byte.
async function sqlText(db, expr, value) {
  const row = await db.prepare(`SELECT ${expr} AS v`).bind(value ?? null).first();
  return Object.values(row)[0];
}

async function inputsHash(db, typeOf, inputs, row) {
  const casts = inputs.map((c) => castText(typeOf[c] === "number")).join(", ") || "NULL";
  const stmt = db.prepare(`SELECT json_array(${casts}) AS j`).bind(...inputs.map((c) => row[c] ?? null));
  return sha256hex(Object.values(await stmt.first())[0]);
}

const valueHash = (db, isNumber, value) =>
  sqlText(db, `coalesce(${castText(isNumber)}, '')`, value).then(sha256hex);

export async function deriveRows(db, env, table, ids, { fetchImpl = fetch, names = null, col = null } = {}) {
  const t = ident(table);
  const derivations = loadDerivations(env);
  const { typeOf, byName } = await derivationProps(db, t);
  const out = { derived: 0, failed: [] };

  for (const id of ids) {
    for (const [name, cols] of byName) {
      if (names && !names.has(name)) continue;
      // `col` narrows to the derivation that produces it; its siblings come
      // back in the same response, so they are written too rather than wasted.
      if (col && !cols.some((p) => p.col === col)) continue;

      // Re-read per derivation: one derivation's output can be another's
      // input, and hashing a stale row would leave provenance that never
      // matches (an endless re-derive loop on the sweep).
      const row = await db.prepare(`SELECT * FROM ${t} WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
      if (!row) break;
      const target = derivations.get(name);
      if (!target) {
        out.failed.push({ id, col: cols[0].col, error: `no derivation configured for ${name}` });
        continue;
      }
      const inputs = cols[0].inputs ?? [];
      const body = { tbl: t, id, inputs: Object.fromEntries(inputs.map((c) => [c, row[c] ?? null])) };
      let result;
      try {
        const res = await fetchImpl(target.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...target.headers },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`endpoint ${name} returned ${res.status}`);
        result = await res.json();
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          throw new Error(`endpoint ${name} returned a non-object`);
        }
      } catch (e) {
        out.failed.push({ id, col: cols[0].col, error: String(e) });
        continue;
      }

      const values = {};
      for (const p of cols) {
        if (!(p.col in result)) continue;
        const v = result[p.col];
        values[p.col] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      }
      // A misbehaving endpoint must not corrupt a locked column: check the
      // values we are about to write, and drop the ones that fail.
      const viol = validateRow(cols.filter((p) => p.col in values), row, { ...row, ...values }, {
        inDerive: new Set(Object.keys(values)),
      });
      for (const v of viol) {
        delete values[v.col];
        out.failed.push({ id, col: v.col, error: v.message });
      }

      const written = Object.entries(values);
      if (!written.length) continue;
      const sets = written.map(([c]) => `${ident(c)} = ?`).join(", ");
      const stmts = [
        db
          .prepare(`UPDATE ${t} SET ${sets}, updated_at = (${NOW}) WHERE id = ?`)
          .bind(...written.map(([, v]) => v), id),
      ];
      for (const [c, v] of written) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash, source_ref, produced_at, updated_at, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, (${NOW}), (${NOW}), NULL)
               ON CONFLICT(id) DO UPDATE SET derived_by = excluded.derived_by, inputs_hash = excluded.inputs_hash,
                 value_hash = excluded.value_hash, source_ref = excluded.source_ref, produced_at = excluded.produced_at,
                 updated_at = excluded.updated_at, deleted_at = NULL`
            )
            .bind(
              `${t}:${id}:${c}`,
              t,
              id,
              c,
              `http:${name}`,
              await inputsHash(db, typeOf, inputs, row),
              await valueHash(db, typeOf[c] === "number", v),
              result._source_ref ?? null
            )
        );
      }
      await db.batch(stmts);
      out.derived += 1;
    }
  }
  return out;
}

// Which (row, derivation) pairs are underived or stale: no live provenance, or
// provenance whose inputs_hash no longer matches the row's current inputs.
async function staleWork(db, table, typeOf, byName, rows) {
  const work = new Map();
  for (const row of rows) {
    for (const [name, cols] of byName) {
      for (const p of cols) {
        const prov = await db
          .prepare("SELECT inputs_hash FROM provenance WHERE id = ? AND deleted_at IS NULL")
          .bind(`${table}:${row.id}:${p.col}`)
          .first();
        if (prov && prov.inputs_hash === (await inputsHash(db, typeOf, p.inputs ?? [], row))) continue;
        if (!work.has(name)) work.set(name, new Set());
        work.get(name).add(row.id);
        break;
      }
    }
  }
  return work;
}

// Derive only what needs it, for rows already in hand (the on-push path).
export async function deriveStale(db, env, table, rows, { fetchImpl = fetch, limit = 50 } = {}) {
  const t = ident(table);
  const { typeOf, byName } = await derivationProps(db, t);
  const out = { derived: 0, failed: [] };
  if (!byName.size) return out;
  for (const [name, ids] of await staleWork(db, t, typeOf, byName, rows)) {
    const r = await deriveRows(db, env, t, [...ids].slice(0, limit), { fetchImpl, names: new Set([name]) });
    out.derived += r.derived;
    out.failed.push(...r.failed);
  }
  return out;
}

// Cheap SQL prefilter: rows with no provenance for this column, or whose
// updated_at moved past it. staleWork then re-hashes to decide for real.
async function candidates(db, table, col, limit) {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM ${table} t
       LEFT JOIN provenance p ON p.id = ? || ':' || t.id || ':' || ? AND p.deleted_at IS NULL
       WHERE t.deleted_at IS NULL AND (p.id IS NULL OR t.updated_at > p.produced_at)
       LIMIT ?`
    )
    .bind(table, col, limit)
    .all();
  return results ?? [];
}

export async function sweep(db, env, { limit = 50, fetchImpl = fetch } = {}) {
  const out = { derived: 0, failed: [] };
  const catalog = await db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'")
    .first();
  if (!catalog) return out; // a hub with no catalog yet
  const { results: tables } = await db
    .prepare("SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL AND derived_by LIKE 'http:%'")
    .all();
  for (const { tbl } of tables ?? []) {
    const t = ident(tbl);
    const { byName } = await derivationProps(db, t);
    const rows = new Map();
    for (const cols of byName.values()) {
      for (const p of cols) for (const row of await candidates(db, t, p.col, limit)) rows.set(row.id, row);
    }
    if (!rows.size) continue;
    const r = await deriveStale(db, env, t, [...rows.values()], { fetchImpl, limit });
    out.derived += r.derived;
    out.failed.push(...r.failed);
  }
  return out;
}
