// Original replica events keep their IDs. Value trails, not timestamp order,
// decide whether those facts already explain the hub's cell transition.
import { literal, qident, validEditTimestamp } from './validate.js';

const FIELDS = ['id','tbl','row_id','col','old','new','origin','created_at','updated_at'];
const ENGINE = new Set(['catalog_tables','catalog_properties','catalog_rules','catalog_log','history','provenance']);

export function historyTrail(events, old, value) {
  const degree = new Map(), neighbors = new Map();
  for (const e of events) {
    degree.set(e.old, (degree.get(e.old) ?? 0) + 1);
    degree.set(e.new, (degree.get(e.new) ?? 0) - 1);
    for (const [a,b] of [[e.old,e.new],[e.new,e.old]]) {
      if (!neighbors.has(a)) neighbors.set(a,new Set());
      neighbors.get(a).add(b);
    }
  }
  if (!neighbors.has(old) || !neighbors.has(value)) return false;
  for (const [v,n] of degree) if (n !== Number(v === old) - Number(v === value)) return false;
  const seen = new Set(), todo = [old];
  while (todo.length) {
    const v = todo.pop();
    if (seen.has(v)) continue;
    seen.add(v);
    for (const n of neighbors.get(v)) if (!seen.has(n)) todo.push(n);
  }
  return seen.size === neighbors.size;
}

export async function historyPlan(view, db, table, rows, supplied = []) {
  if (ENGINE.has(table)) return null;
  const ids = new Set(rows.map(r=>r.id));
  const events = supplied.filter(e=>ids.has(e.row_id));
  const exists = !!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'").first();
  const stored = new Map();
  if (exists && events.length) {
    const {results} = await view.prepare('SELECT * FROM history WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(events.map(e=>e.id))).all();
    for (const e of results ?? []) stored.set(e.id,e);
  }
  const cols = (await db.prepare(`PRAGMA table_info(${qident(table)})`).all()).results.map(c=>c.name);
  const unseen = [];
  for (const e of events) {
    if (FIELDS.some(c=>!Object.hasOwn(e,c)) || typeof e.id !== 'string' || !e.id ||
        e.tbl !== table || !cols.includes(e.col) || ['updated_at','hub_at'].includes(e.col) ||
        ['old','new'].some(c=>e[c] !== null && typeof e[c] !== 'string') ||
        !validEditTimestamp(e.created_at) || !validEditTimestamp(e.updated_at)) {
      throw new Error('life_history: invalid attached history event');
    }
    if (stored.has(e.id)) {
      if (FIELDS.some(c=>stored.get(e.id)[c] !== e[c])) throw new Error('life_history: history ID reused for a different event');
    } else { unseen.push(e); stored.set(e.id,e); }
  }
  const groups = new Map();
  for (const e of unseen) {
    const key = JSON.stringify([e.row_id,e.col]);
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(e);
  }
  const summaries = [];
  for (const events of groups.values()) {
    const degree = new Map();
    for (const e of events) {
      degree.set(e.old,(degree.get(e.old) ?? 0)+1);
      degree.set(e.new,(degree.get(e.new) ?? 0)-1);
    }
    const start = [...degree].find(([,n])=>n===1), end = [...degree].find(([,n])=>n===-1);
    summaries.push({row_id:events[0].row_id, col:events[0].col, old:start?.[0] ?? null, new:end?.[0] ?? null,
      valid:!!start && !!end && historyTrail(events,start[0],end[0])});
  }
  const histCols = exists ? (await db.prepare('PRAGMA table_info(history)').all()).results.map(c=>c.name) : [...FIELDS,'deleted_at','hub_at'];
  return {cols, unseen, summaries, exists, stamp:histCols.includes('hub_at')};
}

export function historyStatements(db, table, key, plan, now) {
  if (!plan) return {begin:[],end:[]};
  const begin = [], end = [];
  if (!plan.exists) {
    begin.push(db.prepare(`CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (${NOW}), ddl TEXT NOT NULL)`));
    for (const ddl of HISTORY_DDL) {
      begin.push(db.prepare(ddl));
      begin.push(db.prepare('INSERT INTO _schema_log (ddl) VALUES (?)').bind(ddl));
    }
  }
  const receipts = key + '_receipts', trigger = key + '_history';
  begin.push(db.prepare(`CREATE TABLE ${qident(receipts)} AS SELECT value FROM json_each(?)`).bind(JSON.stringify(plan.summaries)));
  const cell = (c) => `SELECT value FROM ${qident(receipts)} WHERE json_extract(value,'$.row_id') IS NEW.id AND json_extract(value,'$.col')=${literal(c)}`;
  const checks = plan.cols.filter(c=>!['updated_at','hub_at'].includes(c)).map(c=> {
    const old = `CAST(OLD.${qident(c)} AS TEXT)`, value = `CAST(NEW.${qident(c)} AS TEXT)`;
    return `INSERT INTO history (id,tbl,row_id,col,old,new,origin,created_at,updated_at${plan.stamp?',hub_at':''})
      SELECT lower(hex(randomblob(16))),${literal(table)},NEW.id,${literal(c)},${old},${value},
        CASE WHEN EXISTS (${cell(c)}) THEN 'hub:reconcile' ELSE 'hub' END,
        NEW.updated_at,${literal(now)}${plan.stamp?','+literal(now):''}
      WHERE OLD.${qident(c)} IS NOT NEW.${qident(c)} AND NOT EXISTS (
        ${cell(c)} AND json_extract(value,'$.valid')=1
        AND json_extract(value,'$.old') IS ${old} AND json_extract(value,'$.new') IS ${value});`;
  }).join('\n');
  if (checks) {
    begin.push(db.prepare(`CREATE TRIGGER ${qident(trigger)} AFTER UPDATE ON ${qident(table)} BEGIN ${checks} END`));
    end.push(db.prepare(`DROP TRIGGER ${qident(trigger)}`));
  }
  if (plan.unseen.length) {
    const cols = [...FIELDS, ...(plan.stamp?['hub_at']:[])];
    const values = cols.map(c=>c==='hub_at'?'?':`json_extract(value,'$.${c}')`);
    end.push(db.prepare(`INSERT INTO history (${cols.map(qident).join(',')}) SELECT ${values.join(',')} FROM json_each(?)`)
      .bind(...(plan.stamp?[now]:[]),JSON.stringify(plan.unseen)));
  }
  end.push(db.prepare(`DROP TABLE ${qident(receipts)}`));
  return {begin,end};
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HISTORY_DDL = [
  "CREATE TABLE \"history\" (\n    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),\n    \"tbl\" TEXT,\n    \"row_id\" TEXT,\n    \"col\" TEXT,\n    \"old\" TEXT,\n    \"new\" TEXT,\n    \"origin\" TEXT,\n    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),\n    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),\n    deleted_at TEXT,\n    hub_at TEXT\n)",
  "CREATE TRIGGER \"history_updated_at\" AFTER UPDATE ON \"history\" FOR EACH ROW\nWHEN NEW.updated_at = OLD.updated_at\nBEGIN\n    UPDATE \"history\" SET updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE rowid = NEW.rowid;\nEND"
];
