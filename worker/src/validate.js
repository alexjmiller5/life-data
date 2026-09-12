// Mirror of life_data.catalog.validate_row / validate_push. The shared
// fixture in tests/fixtures/validation-cases.json is the contract for
// validateRow; keep the two implementations in step.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function validEditTimestamp(value) {
  if (typeof value !== "string" || !DATETIME_RE.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{5,}$/;

const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function asList(v) {
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
}

function same(a, b) {
  const la = asList(a), lb = asList(b);
  if (la && lb) return JSON.stringify(la) === JSON.stringify(lb);
  return a === b || (a == null && b == null);
}

export function allowed(p, extraOptions) {
  const vals = (p.options ?? []).map((o) => o.v);
  if (p.options_sql && extraOptions) for (const x of extraOptions(p)) if (!vals.includes(x)) vals.push(x);
  return vals;
}

// Spec order: deprecated, derived, immutable, required, type (incl.
// cardinality), pattern, ref/multi_ref existence. First failure per column
// wins.
//
// `touched` (a Set, or null for "every column") names the columns a partial
// write actually carries; `after` is then the MERGED row. Whole-row rules
// (required) still see every column - that is the point of merging - but the
// per-value checks (type/options/pattern/ref, and the deprecated/derived/
// immutable protections) only judge what the writer wrote: a stored value is
// not this write's claim, and re-checking it would reject a partial update
// over any legacy or hub-written cell.
export function validateRow(props, before, after, { inDerive = new Set(), refOk = null, extraOptions = null, touched = null } = {}) {
  const out = [];
  for (const p of props) {
    const col = p.col;
    const v = after[col];
    const was = before ? before[col] : null;
    const changed = before == null ? !empty(v) : !same(v, was);
    const label = p.label ?? col;
    const fail = (rule, message) => out.push({ col, rule, message });

    if (touched && !touched.has(col)) {
      if (p.required && empty(v)) fail("required", `${label} is required.`);
      continue;
    }
    if (p.deprecated && !empty(v)) { fail("deprecated", `${col} is deprecated. Never write it.`); continue; }
    if (p.derived_by && changed && !inDerive.has(col)) { fail("derived", `${col} is derived by ${p.derived_by} on the hub. Never write it.`); continue; }
    if (p.immutable && before != null && changed) { fail("immutable", `${col} is set once and never changed.`); continue; }
    if (p.required && empty(v)) { fail("required", `${label} is required.`); continue; }
    if (empty(v)) continue;

    const t = p.type ?? "text";
    if (t === "number" || t === "int") {
      const n = Number(v);
      if (typeof v === "boolean" || v === "" || !Number.isFinite(n)) { fail("type", `${label} must be a number.`); continue; }
      if (t === "int" && !Number.isInteger(n)) { fail("type", `${label} must be an integer.`); continue; }
    } else if (t === "bool" && ![0, 1, true, false].includes(v)) { fail("type", `${label} must be 0 or 1.`); continue; }
    else if (t === "date" && !(typeof v === "string" && DATE_RE.test(v))) { fail("type", `${label} must be YYYY-MM-DD.`); continue; }
    else if (t === "datetime" && !(typeof v === "string" && DATETIME_RE.test(v))) { fail("type", `${label} must be ISO-8601 UTC with milliseconds.`); continue; }
    else if (t === "json") {
      try { typeof v === "string" ? JSON.parse(v) : JSON.stringify(v); } catch { fail("type", `${label} must be JSON.`); continue; }
    } else if (t === "url" && !(typeof v === "string" && /^https?:\/\//.test(v))) { fail("type", `${label} must be an http(s) URL.`); continue; }
    else if (t === "email" && !(typeof v === "string" && EMAIL_RE.test(v))) { fail("type", `${label} must be an email address.`); continue; }
    else if (t === "phone" && !(typeof v === "string" && PHONE_RE.test(v))) { fail("type", `${label} must be a phone number.`); continue; }
    else if (t === "select") {
      const a = allowed(p, extraOptions);
      if (a.length && !a.includes(v)) { fail("options", `${v} is not an option for ${col}. Allowed: ${a.join(", ")}`); continue; }
    } else if (t === "multi_select" || t === "multi_ref") {
      const items = asList(v);
      if (!items) { fail("type", `${label} must be a JSON array.`); continue; }
      if (t === "multi_select") {
        const a = allowed(p, extraOptions);
        const bad = items.filter((x) => a.length && !a.includes(x));
        if (bad.length) { fail("options", `Not options for ${col}: ${bad.join(", ")}. Allowed: ${a.join(", ")}`); continue; }
      }
      if (p.min_items && items.length < p.min_items) { fail("min_items", `${label} needs at least ${p.min_items}.`); continue; }
      if (p.max_items && items.length > p.max_items) { fail("max_items", `${label} allows at most ${p.max_items}.`); continue; }
    }

    // Pattern runs before ref/multi_ref existence checks (matches Python).
    if (p.pattern && typeof v === "string" && !new RegExp(`^(?:${p.pattern})$`).test(v)) { fail("pattern", `${label} is not in the expected form.`); continue; }

    if (t === "ref" && refOk && p.ref_table && !refOk(p.ref_table, v)) { fail("ref", `No ${p.ref_table} row with id ${v}.`); continue; }
    if (t === "multi_ref" && refOk && p.ref_table) {
      const missing = (asList(v) ?? []).filter((x) => !refOk(p.ref_table, x));
      if (missing.length) { fail("ref", `No ${p.ref_table} row: ${missing.join(", ")}`); continue; }
    }
  }
  return out;
}

// provenance is engine-created but validated like a user table: clients write edges into it.
const ENGINE_TABLES = new Set(["catalog_tables", "catalog_properties", "catalog_rules", "catalog_log", "history"]);

export async function sha256hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tableExists(db, name) {
  return !!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first());
}

export async function propertiesFor(db, table) {
  if (ENGINE_TABLES.has(table) || !(await tableExists(db, "catalog_properties"))) return [];
  const { results } = await db
    .prepare("SELECT * FROM catalog_properties WHERE deleted_at IS NULL AND tbl = ? ORDER BY sort, col")
    .bind(table).all();
  return (results ?? []).map((p) => ({
    ...p,
    options: p.options ? JSON.parse(p.options) : null,
    inputs: p.inputs ? JSON.parse(p.inputs) : [],
  }));
}

// SQLite stores a `number` column as REAL, so the client hashes 4 as "4.0".
// The pushed JSON carries a bare 4, which binds as INTEGER and would render
// "4". Cast every cataloged `number` through REAL first so both sides agree.
// (This is why a derivation's inputs must themselves be cataloged columns.)
const castText = (isNumber) => (isNumber ? "CAST(CAST(? AS REAL) AS TEXT)" : "CAST(? AS TEXT)");

// The two hashes provenance is made of, rendered by SQLite so the client, the
// hub validator and the derivation engine agree byte for byte. `typeOf` is a
// {col: type} object from the catalog.
export async function inputsHash(db, typeOf, inputs, row) {
  const casts = inputs.map((c) => castText(typeOf[c] === "number")).join(", ") || "NULL";
  const stmt = db.prepare(`SELECT json_array(${casts}) AS j`).bind(...inputs.map((c) => row[c] ?? null));
  return sha256hex(Object.values(await stmt.first())[0]);
}

export async function valueHash(db, typeOf, col, value) {
  const stmt = db.prepare(`SELECT coalesce(${castText(typeOf[col] === "number")}, '') AS v`).bind(value ?? null);
  return sha256hex(Object.values(await stmt.first())[0]);
}

// Every identifier interpolated into SQL passes through here first. `ident`
// validates and returns the bare name (it is also used as a bound VALUE, e.g.
// in provenance ids); `qident` is what goes into SQL — quoted, so a column
// named `cast` or `order` is legal.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function ident(name) {
  if (!SAFE_IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return name;
}

export function qident(name) {
  return `"${ident(name)}"`;
}

// Pre-resolve every lookup the pure validator needs (D1 is async), then validate.
export async function validatePush(db, table, rows, storageDb = null, insertOnly = false) {
  const exists = await tableExists(db, table);
  // One read for the whole push (D1 caps bind params at ~100), not one per row:
  // a push of 500 rows must not cost 500 round trips.
  const stored = new Map();
  if (exists) {
    const ids = [...new Set(rows.map((r) => r.id))];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const { results } = await db
        .prepare(`SELECT * FROM ${qident(table)} WHERE id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(...chunk).all();
      for (const r of results ?? []) stored.set(r.id, r);
    }
  }

  const existing = [], rejected = [];
  if (insertOnly) {
    rows = rows.filter(row => {
      if (stored.has(row.id)) { existing.push(row.id); return false; }
      if (validEditTimestamp(row.updated_at)) return true;
      rejected.push({id:row.id,col:'updated_at',rule:row.updated_at == null ? 'required' : 'type',
        message:'updated_at must be a valid UTC millisecond timestamp.'});
      return false;
    });
    // Ignored content must not reach catalog lookups, validation or defaults.
    if (!rows.length) return {accepted:[],rejected,existing,expected:[],transitions:[],props:[]};
  }
  const props = await propertiesFor(db, table);
  const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
  const derivedCols = new Set(props.filter((p) => p.derived_by).map((p) => p.col));

  const refSet = new Set();
  for (const p of props.filter((p) => (p.type === "ref" || p.type === "multi_ref") && p.ref_table)) {
    if (!(await tableExists(db, p.ref_table))) continue;
    const ids = new Set();
    for (const r of rows) for (const x of asList(r[p.col]) ?? [r[p.col]]) if (x != null) ids.add(x);
    if (ids.size) {
      const { results } = await db.prepare(`SELECT id FROM ${qident(p.ref_table)} WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`)
        .bind(JSON.stringify([...ids])).all();
      for (const hit of results ?? []) refSet.add(`${p.ref_table}:${hit.id}`);
    }
  }
  const extra = {};
  for (const p of props.filter((p) => p.options_sql)) {
    const { results } = await db.prepare(p.options_sql).all();
    extra[p.col] = (results ?? []).map((r) => Object.values(r)[0]);
    p.optionColumn = results?.length ? Object.keys(results[0])[0] : null;
  }

  // Resolve INSERT defaults once, then explicitly store the approved values.
  // Re-evaluating a clock/random default in a read guard would self-conflict.
  let schema = [];
  const defaults = new Map();
  if (storageDb) {
    schema = (await storageDb.prepare(`PRAGMA table_info(${qident(table)})`).all()).results;
    const fresh = [...new Set(rows.filter(r=>!stored.has(r.id)).map(r=>r.id))];
    if (fresh.length) {
      const fields = schema.filter(c=>c.dflt_value != null && !['id','updated_at','hub_at'].includes(c.name));
      const {results} = await storageDb.prepare(`SELECT value AS id${fields.map(c=>`, (${c.dflt_value}) AS ${qident(c.name)}`).join('')} FROM json_each(?)`)
        .bind(JSON.stringify(fresh)).all();
      for (const r of results) defaults.set(r.id, Object.fromEntries(schema.map(c=>[c.name,r[c.name] ?? null])));
    }
  }
  const accepted = [], expected = [], transitions = [];
  for (let row of rows) {
    // A push carries only the columns it writes. Required (and the derived
    // provenance check below) judge the row as it will BE - stored columns
    // plus this write - so a partial update need not echo the whole row.
    const before = stored.get(row.id) ?? null;
    if (before && row.updated_at <= before.updated_at) {
      accepted.push(row);
      continue;
    }
    if (storageDb) row = storageRow(schema, before ? row : {...defaults.get(row.id), ...row});
    const merged = before ? { ...before, ...row } : row;
    const approve = () => {
      accepted.push(row); stored.set(row.id, merged); expected.push(merged);
      transitions.push({before, after:merged, touched:Object.keys(row)});
    };
    if (merged.deleted_at) {
      approve();
      continue;
    }
    const viol = validateRow(storageDb ? props.map(p=>p.options_sql ? {...p,options:null,options_sql:null} : p) : props, before, merged, {
      inDerive: derivedCols,
      refOk: storageDb ? null : (t, id) => refSet.has(`${t}:${id}`),
      extraOptions: (p) => extra[p.col] ?? [],
      touched: before ? new Set(Object.keys(row)) : null,
    });
    for (const p of props.filter((p) => p.derived_by)) {
      const changed = before == null ? merged[p.col] != null : !same(merged[p.col], before[p.col]);
      if (!changed) continue;
      const prov = await db.prepare("SELECT inputs_hash, value_hash FROM provenance WHERE id = ? AND deleted_at IS NULL")
        .bind(`${table}:${row.id}:${p.col}`).first();
      const ok =
        prov &&
        prov.inputs_hash === (await inputsHash(db, typeOf, p.inputs, merged)) &&
        prov.value_hash === (await valueHash(db, typeOf, p.col, merged[p.col]));
      if (!ok) {
        viol.push({ col: p.col, rule: "provenance", message: `${p.col} changed without a matching provenance record.` });
      }
    }
    if (viol.length) rejected.push(...viol.map((v) => ({ id: row.id, ...v })));
    else approve();
  }
  return { accepted, rejected, expected, transitions, props, existing };
}

export const literal = (v) => v == null ? "NULL" : "'" + String(v).replaceAll("'", "''") + "'";

// SQLite column affinity, applied before validation and approval comparison.
// Non-numeric text in a numeric column remains text (CAST alone would turn it 0).
export function storageRow(schema, row) {
  const out = {...row};
  for (const c of schema) {
    let v = out[c.name];
    if (v == null || typeof v === 'object' || typeof v === 'boolean') continue;
    const type = c.type.toUpperCase();
    if (/INT/.test(type)) {
      if (typeof v === 'string' && /^[\t\n\r ]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[\t\n\r ]*$/.test(v)) v = Number(v);
    } else if (/CHAR|CLOB|TEXT/.test(type)) v = String(v);
    else if (type && !/BLOB/.test(type) && typeof v === 'string' && /^[\t\n\r ]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[\t\n\r ]*$/.test(v)) v = Number(v);
    out[c.name] = v;
  }
  return out;
}
