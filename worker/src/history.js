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

// Find an explanatory segment for one accepted revision. Full Euler trails
// handle coalesced edits/cycles; a bounded graph search handles intermediate
// revisions. Neither uses timestamp ties as an invented chronological order.
function historySegment(events, old, value) {
  if (historyTrail(events, old, value)) return events.map(e=>e.id);
  const outgoing = new Map();
  for (const e of events) {
    if (!outgoing.has(e.old)) outgoing.set(e.old,[]);
    outgoing.get(e.old).push(e);
  }
  const parent = new Map([[old,null]]), todo = [old];
  for (let i=0; i<todo.length && !parent.has(value); i++) for (const e of outgoing.get(todo[i]) ?? []) {
    if (!parent.has(e.new)) { parent.set(e.new,e); todo.push(e.new); }
  }
  if (!parent.has(value)) return [];
  const ids = [];
  for (let v=value; v!==old;) { const e=parent.get(v); ids.push(e.id); v=e.old; }
  return ids;
}

export async function historyPlan(view, db, table, rows, supplied = [], transitions = [], state = {known:new Set(), eligible:new Map(), consumed:new Set()}) {
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
  const schema = (await db.prepare(`PRAGMA table_info(${qident(table)})`).all()).results;
  const cols = schema.map(c=>c.name);
  const unseen = [];
  for (const e of events) {
    if (FIELDS.some(c=>!Object.hasOwn(e,c)) || typeof e.id !== 'string' || !e.id ||
        e.tbl !== table || !cols.includes(e.col) || ['updated_at','hub_at'].includes(e.col) ||
        ['old','new'].some(c=>e[c] !== null && typeof e[c] !== 'string') ||
        !validEditTimestamp(e.created_at) || !validEditTimestamp(e.updated_at)) {
      throw new Error('life_history: invalid attached history event');
    }
    if (!state.known.has(e.id)) {
      state.known.add(e.id);
      if (!stored.has(e.id)) state.eligible.set(e.id,e);
    }
    if (stored.has(e.id)) {
      if (FIELDS.some(c=>stored.get(e.id)[c] !== e[c])) throw new Error('life_history: history ID reused for a different event');
    } else { unseen.push(e); stored.set(e.id,e); }
  }
  const available = [...state.eligible.values()].filter(e=>!state.consumed.has(e.id));
  const summaries = [], consumed = new Set();
  const cellText = (row,c) => {
    const v = row[c];
    if (v == null) return null;
    if (typeof v === 'number' && Number.isInteger(v) && /REAL|FLOA|DOUB/i.test(schema.find(x=>x.name===c).type)) return v.toFixed(1);
    return String(v);
  };
  for (const {before, after} of transitions) {
    if (!before) continue;
    for (const c of cols.filter(c=>!['updated_at','hub_at'].includes(c))) {
      const old = cellText(before,c), value = cellText(after,c);
      if (old === value) continue;
      const related = available.filter(e=>e.row_id===after.id && e.col===c && !consumed.has(e.id));
      if (!related.length) continue;
      const segment = historySegment(related,old,value);
      for (const id of segment) consumed.add(id);
      summaries.push({row_id:after.id,col:c,updated_at:after.updated_at,old,new:value,valid:segment.length>0});
    }
  }
  const histCols = exists ? (await db.prepare('PRAGMA table_info(history)').all()).results.map(c=>c.name) : [...FIELDS,'deleted_at','hub_at'];
  return {cols, unseen, summaries, consumed, exists, stamp:histCols.includes('hub_at')};
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
  const cell = (c) => `SELECT value FROM ${qident(receipts)} WHERE json_extract(value,'$.row_id') IS NEW.id AND json_extract(value,'$.col')=${literal(c)} AND json_extract(value,'$.updated_at') IS NEW.updated_at`;
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
