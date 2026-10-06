// Typed evidence is attached to canonical history IDs. Heads are continuity
// proofs, not a second row revision store. Unverified history invalidates them.
import { literal, qident } from './validate.js';
import {ensureContinuityGuards,hasContinuityGuards,storageChanged} from './governance-continuity.js';

export const EVIDENCE_DDL=[
  `CREATE TABLE IF NOT EXISTS _governance_invalidations (tbl TEXT NOT NULL,row_id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(tbl,row_id))`,
  `CREATE TABLE IF NOT EXISTS _governance_writes (tbl TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS _governance_layouts (tbl TEXT PRIMARY KEY,sql TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _governance_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    tbl TEXT NOT NULL,row_id TEXT NOT NULL,col TEXT NOT NULL,
    previous_id TEXT,before_json TEXT,after_json TEXT,before_real REAL,after_real REAL,
    canonical_json TEXT NOT NULL,operation_id TEXT,actor_json TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS _governance_history_target ON _governance_history(tbl,row_id,seq)',
  `CREATE TABLE IF NOT EXISTS _governance_heads (
    tbl TEXT NOT NULL,row_id TEXT NOT NULL,col TEXT NOT NULL,event_id TEXT,
    PRIMARY KEY(tbl,row_id,col)
  )`,
];

const invalidate=prefix=>`INSERT INTO _governance_heads(tbl,row_id,col,event_id)
  VALUES (${prefix}.tbl,${prefix}.row_id,${prefix}.col,NULL)
  ON CONFLICT(tbl,row_id,col) DO UPDATE SET event_id=NULL;`;
export const EVIDENCE_TRIGGERS=['INSERT','UPDATE','DELETE'].map(event=>({
  name:'_governance_history_'+event.toLowerCase(),
  sql:`CREATE TRIGGER _governance_history_${event.toLowerCase()} AFTER ${event} ON history
    WHEN ${event==='DELETE'?'OLD':'NEW'}.tbl IS NOT NULL AND ${event==='DELETE'?'OLD':'NEW'}.row_id IS NOT NULL AND ${event==='DELETE'?'OLD':'NEW'}.col IS NOT NULL
    BEGIN ${event==='INSERT'?'':invalidate('OLD')+' DELETE FROM _governance_history WHERE event_id=OLD.id;'}
    ${event==='DELETE'?'':invalidate('NEW')} END`,
}));

export function trustedEvidenceTrigger(trigger) {
  return trigger.tbl_name==='history' && EVIDENCE_TRIGGERS.some(t=>t.name===trigger.name && t.sql.replace(/\s+/g,' ').trim()===String(trigger.sql).replace(/\s+/g,' ').trim());
}

export async function ensureEvidenceStorage(db) {
  for(const sql of EVIDENCE_DDL) await db.prepare(sql).run();
  if (await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'").first()) {
    for(const {sql} of EVIDENCE_TRIGGERS) await db.prepare(sql.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS ')).run();
  }
  await ensureContinuityGuards(db);
}

// REAL values travel in native REAL columns, never SQLite JSON/printf decimal
// rendering: supported SQLite versions can round either representation.
export const typedSql=expression=>`CASE typeof(${expression})
  WHEN 'null' THEN json_object('type','null')
  WHEN 'text' THEN json_object('type','text','value',${expression})
  WHEN 'integer' THEN json_object('type','integer','value',CAST(${expression} AS TEXT))
  WHEN 'real' THEN CASE WHEN abs(${expression})<=1.7976931348623157e308
    THEN '{"type":"real"}' END ELSE NULL END`;

export function evidenceHistorySql(table,column,origin,condition,stamp,actor=null,operationId=null) {
  const col=qident(column),tbl=literal(table),name=literal(column);
  const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const canonical=`json_object('tbl',${tbl},'row_id',NEW.id,'col',${name},'old',CAST(OLD.${col} AS TEXT),'new',CAST(NEW.${col} AS TEXT),'origin',${origin},'created_at',NEW.updated_at,'updated_at',${now},'deleted_at',NULL)`;
  const latest=`SELECT event_id FROM _governance_history ORDER BY seq DESC LIMIT 1`;
  return `INSERT INTO _governance_history
    (event_id,tbl,row_id,col,previous_id,before_json,after_json,before_real,after_real,canonical_json,operation_id,actor_json)
    SELECT lower(hex(randomblob(16))),${tbl},NEW.id,${name},
      (SELECT event_id FROM _governance_heads WHERE tbl=${tbl} AND row_id=NEW.id AND col=${name}),
      ${typedSql('OLD.'+col)},${typedSql('NEW.'+col)},
      CASE WHEN typeof(OLD.${col})='real' THEN OLD.${col} END,CASE WHEN typeof(NEW.${col})='real' THEN NEW.${col} END,${canonical},${literal(operationId)},${literal(actor===null?null:JSON.stringify(actor))}
    WHERE ${condition};
    INSERT INTO history (id,tbl,row_id,col,old,new,origin,created_at,updated_at${stamp?',hub_at':''})
    SELECT (${latest}),${tbl},NEW.id,${name},CAST(OLD.${col} AS TEXT),CAST(NEW.${col} AS TEXT),${origin},NEW.updated_at,${now}${stamp?','+now:''}
    WHERE ${condition};
    INSERT INTO _governance_heads(tbl,row_id,col,event_id)
    SELECT ${tbl},NEW.id,${name},(${latest}) WHERE ${condition}
    ON CONFLICT(tbl,row_id,col) DO UPDATE SET event_id=excluded.event_id;
    INSERT INTO _governance_heads(tbl,row_id,col,event_id)
    SELECT ${tbl},NEW.id,${name},NULL WHERE ${storageChanged('OLD.'+col,'NEW.'+col)} AND NOT (${condition})
    ON CONFLICT(tbl,row_id,col) DO UPDATE SET event_id=NULL;`;
}

function decodeCell(encoded,real){
  if(encoded===null)return null;
  const value=JSON.parse(encoded);
  return value.type==='real' ? (typeof real==='number' && Number.isFinite(real)?{type:'real',value:real}:null) : value;
}
export async function typedCells(view,target,columns) {
  if(!columns.length)return {};
  const row=await view.prepare(`SELECT ${columns.map((c,i)=>`${typedSql(qident(c))} AS typed_${i},CASE WHEN typeof(${qident(c)})='real' THEN ${qident(c)} END AS real_${i}`).join(',')}
    FROM ${qident(target.table)} WHERE id=?`).bind(target.rowId).first();
  return row ? Object.fromEntries(columns.map((c,i)=>[c,decodeCell(row['typed_'+i],row['real_'+i])])) : {};
}

export function verifiedEvent(metadata,history) {
  if (!history || history.deleted_at!==null) return null;
  const canonical=JSON.parse(metadata.canonical_json);
  if(Object.entries(canonical).some(([k,v])=>history[k]!==v)) return null;
  return {
    id:history.id,operationId:metadata.operation_id,target:{table:history.tbl,rowId:history.row_id},column:history.col,
    before:decodeCell(metadata.before_json,metadata.before_real),after:decodeCell(metadata.after_json,metadata.after_real),
    occurredAt:history.created_at,actor:metadata.actor_json===null?null:JSON.parse(metadata.actor_json),claimedOrigin:history.origin,
    reversible:metadata.before_json!==null && metadata.after_json!==null,unavailableReason:null,
  };
}

export async function inverseEvidence(view,target,revision,selectedIds,limit=2000) {
  const unknown={target,revision,current:{},events:[],complete:false};
  if(!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_governance_history'").first())return unknown;
  const {results:triggers}=await view.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name IN (SELECT value FROM json_each(?)) ORDER BY name")
    .bind(JSON.stringify(EVIDENCE_TRIGGERS.map(t=>t.name))).all();
  if(triggers.length!==EVIDENCE_TRIGGERS.length || triggers.some(t=>!trustedEvidenceTrigger(t)))return unknown;
  if(!await hasContinuityGuards(view,target.table))return unknown;
  const {results:metadata}=await view.prepare('SELECT * FROM _governance_history WHERE tbl=? AND row_id=? ORDER BY seq LIMIT ?')
    .bind(target.table,target.rowId,limit+1).all();
  if(metadata.length>limit)return unknown;
  const byId=new Map(metadata.map(e=>[e.event_id,e]));
  if(selectedIds.some(id=>!byId.has(id)))return unknown;
  const columns=[...new Set(selectedIds.map(id=>byId.get(id).col))];
  const {results:heads}=await view.prepare('SELECT * FROM _governance_heads WHERE tbl=? AND row_id=? ORDER BY col').bind(target.table,target.rowId).all();
  const reachable=new Map();
  for(const column of columns){
    let id=heads.find(h=>h.col===column)?.event_id;
    const needed=new Set(selectedIds.filter(id=>byId.get(id).col===column));
    const visited=new Set();
    while(id && needed.size){
      const e=byId.get(id);
      if(!e || e.col!==column || visited.has(id))return unknown;
      visited.add(id);reachable.set(id,e);needed.delete(id);id=e.previous_id;
    }
    if(needed.size)return unknown;
  }
  const {results:history}=await view.prepare('SELECT * FROM history WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(JSON.stringify([...reachable.keys()])).all();
  const canonical=new Map(history.map(e=>[e.id,e]));
  const events=[...reachable.values()].sort((a,b)=>a.seq-b.seq).map(e=>verifiedEvent(e,canonical.get(e.event_id)));
  if(events.some(e=>!e))return unknown;
  return {target,revision,current:await typedCells(view,target,columns),events,complete:true};
}
