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

// Match disjoint paths for the explained transitions, revisiting earlier
// choices when values repeat. Exhaustion is UNKNOWN, never proof of no match.
function historySegments(events, transitions) {
  if (transitions.length === 1 && historyTrail(events, ...transitions[0])) return true;
  const edges = new Map();
  for (const e of events) {
    if (!edges.has(e.old)) edges.set(e.old,[]);
    edges.get(e.old).push(e);
  }
  const start = transitions[0][0];
  const todo = [{step:0,value:start,used:new Set(),visited:new Set([start])}];
  let budget = 10_000;
  const enqueue = state => {
    if (!budget--) throw Object.assign(new Error('History matching budget exhausted; split revisions into smaller requests and retry.'), {code:'history-ambiguity'});
    todo.push(state);
  };
  while (todo.length) {
    const {step,value,used,visited} = todo.pop();
    const target = transitions[step][1];
    if (value === target) {
      if (step+1 === transitions.length) return true;
      const start = transitions[step+1][0];
      enqueue({step:step+1,value:start,used,visited:new Set([start])});
      continue;
    }
    // Direct events first in the DFS, without treating attachment order as time.
    for (const e of [...(edges.get(value) ?? [])].sort((a,b)=>Number(a.new===target)-Number(b.new===target))) {
      if (!used.has(e.id) && !visited.has(e.new)) enqueue({step,value:e.new,used:new Set([...used,e.id]),visited:new Set([...visited,e.new])});
    }
  }
  return false;
}

export async function historyPlan(view, db, table, rows, supplied = [], transitions = [], upsertSql = null) {
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
    if (stored.has(e.id)) {
      if (FIELDS.some(c=>stored.get(e.id)[c] !== e[c])) throw new Error('life_history: history ID reused for a different event');
    } else { unseen.push(e); stored.set(e.id,e); }
  }
  const summaries = [], matched = new Map();
  const changes = unseen.length && transitions.length
    ? await storedTransitions(db,table,schema,rows,upsertSql) : [];
  for (const change of changes) {
    const related = unseen.filter(e=>e.row_id===change.row_id && e.col===change.col);
    if (!related.length) continue;
    const key = JSON.stringify([change.row_id,change.col]);
    const sequence = [...(matched.get(key) ?? []),[change.old,change.new]];
    const valid = historySegments(related,sequence);
    if (valid) matched.set(key,sequence);
    summaries.push({...change,valid});
  }
  const histCols = exists ? (await db.prepare('PRAGMA table_info(history)').all()).results.map(c=>c.name) : [...FIELDS,'deleted_at','hub_at'];
  return {cols, unseen, summaries, exists, stamp:histCols.includes('hub_at')};
}

// Let SQLite apply column affinity and render OLD/NEW, using the same upsert
// as the real write. Copy stored cells directly: a JS round trip loses storage
// types (and integer precision). Helpers are created/dropped in one batch;
// existing read guards and final receipt comparisons still protect the commit.
async function storedTransitions(db, table, schema, rows, upsertSql) {
  const key = '_life_write_' + crypto.randomUUID().replaceAll('-', '');
  const copy = qident(key), changes = qident(key + '_changes');
  const cols = schema.map(c=>qident(c.name)).join(',');
  const statements = [
    db.prepare(`CREATE TABLE ${copy} (${schema.map(c=>`${qident(c.name)} ${literal(c.type)}`).join(',')}, PRIMARY KEY(id))`),
    db.prepare(`INSERT INTO ${copy} (${cols}) SELECT ${cols} FROM ${qident(table)} WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`).bind(JSON.stringify(rows)),
    db.prepare(`CREATE TABLE ${changes} (row_id TEXT, col TEXT, updated_at TEXT, old TEXT, new TEXT)`),
    db.prepare(`CREATE TRIGGER ${qident(key + '_capture')} AFTER UPDATE ON ${copy} BEGIN ${schema.filter(c=>!['updated_at','hub_at'].includes(c.name)).map(c=>
      `INSERT INTO ${changes} SELECT NEW.id,${literal(c.name)},NEW.updated_at,CAST(OLD.${qident(c.name)} AS TEXT),CAST(NEW.${qident(c.name)} AS TEXT) WHERE OLD.${qident(c.name)} IS NOT NEW.${qident(c.name)};`
    ).join('\n')} END`),
  ];
  const groups = [];
  for (const row of rows) {
    const cols = Object.keys(row), last = groups.at(-1);
    if (last && last.cols.join(',')===cols.join(',')) last.rows.push(row);
    else groups.push({cols,rows:[row]});
  }
  for (const {cols,rows} of groups) statements.push(db.prepare(upsertSql(key,cols)).bind(JSON.stringify(rows)));
  const result = statements.length;
  statements.push(db.prepare(`SELECT * FROM ${changes} ORDER BY rowid`), db.prepare(`DROP TABLE ${copy}`), db.prepare(`DROP TABLE ${changes}`));
  return (await db.batch(statements))[result].results;
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
