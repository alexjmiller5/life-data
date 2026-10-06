// Permanent guards observe writes from every SQL path, including triggers on
// other tables. Only a checked writer with verified trigger topology may skip
// invalidation while it records the actual OLD/NEW values in the same batch.
import {literal,qident} from './validate.js';

const ordinary=table=>/^[A-Za-z][A-Za-z0-9_]*$/.test(table)
  && !/^(?:sqlite_|catalog_)/i.test(table) && !/^(?:history|provenance|purges)$/i.test(table);
export const storageChanged=(a,b)=>`(${a} COLLATE BINARY IS NOT ${b} COLLATE BINARY OR typeof(${a})<>typeof(${b}))`;
const normalized=sql=>String(sql).replace(/\s+/g,' ').trim();
export function continuityTriggers(table,columns){
  if(!ordinary(table) || !['id','updated_at'].every(c=>columns.includes(c)))return [];
  const prefix='_governance_rows_'+Array.from(table,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  const changed=columns.filter(c=>!['updated_at','hub_at'].includes(c))
    .map(c=>storageChanged('OLD.'+qident(c),'NEW.'+qident(c))).join(' OR ');
  const lifecycle=['id','deleted_at'].filter(c=>columns.includes(c)).map(c=>storageChanged('OLD.'+qident(c),'NEW.'+qident(c))).join(' OR ');
  return ['INSERT','UPDATE','DELETE'].map(event=>{
    const name=prefix+'_'+event.toLowerCase(),rows=event==='UPDATE'?['OLD','NEW']:[event==='DELETE'?'OLD':'NEW'];
    const when=event==='UPDATE'?`WHEN (${changed}) AND ((${lifecycle}) OR NOT EXISTS (SELECT 1 FROM _governance_writes WHERE tbl=${literal(table)}))`:'';
    return {name,tbl_name:table,sql:`CREATE TRIGGER ${qident(name)} AFTER ${event} ON ${qident(table)} ${when} BEGIN
      ${rows.map(row=>`UPDATE _governance_heads SET event_id=NULL WHERE tbl=${literal(table)} AND row_id=${row}.id;
      INSERT INTO _governance_invalidations(tbl,row_id,version) SELECT ${literal(table)},${row}.id,lower(hex(randomblob(16))) WHERE ${row}.id IS NOT NULL
      ON CONFLICT(tbl,row_id) DO UPDATE SET version=excluded.version;`).join('\n')}
    END`};
  });
}
export const trustedContinuityTrigger=(trigger,columns)=>continuityTriggers(trigger.tbl_name,columns)
  .some(t=>t.name===trigger.name && normalized(t.sql)===normalized(trigger.sql));
export async function continuitySchemas(view){
  const {results}=await view.prepare("SELECT m.name AS tbl,m.sql,p.name AS col FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p WHERE m.type='table' AND m.name NOT GLOB '_*' ORDER BY m.name,p.cid").all();
  const tables=new Map();
  for(const {tbl,col,sql} of results)if(ordinary(tbl) && /^CREATE\s+TABLE\b/i.test(sql)){if(!tables.has(tbl))tables.set(tbl,[]);tables.get(tbl).push(col);}
  return tables;
}
export async function ensureContinuityGuards(db){
  const schemas=await continuitySchemas(db);
  const {results}=await db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB '_governance_rows_*' ORDER BY name").all();
  const {results:tables}=await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  const {results:layouts}=await db.prepare('SELECT tbl,sql FROM _governance_layouts').all();
  for(const [table,columns] of schemas){
    const sql=tables.find(t=>t.name===table).sql;
    const expected=continuityTriggers(table,columns);
    if(!expected.length || (layouts.some(l=>l.tbl===table && l.sql===sql) && expected.every(t=>results.some(r=>r.name===t.name && normalized(r.sql)===normalized(t.sql)))))continue;
    // Missing guards are a gap, including a dropped/recreated table. Reinstall
    // atomically, breaking old continuity and revoking previously issued plans.
    const old=results.filter(t=>t.tbl_name===table);
    await db.batch([
      ...old.map(t=>db.prepare(`DROP TRIGGER ${qident(t.name)}`)),
      db.prepare('UPDATE _governance_heads SET event_id=NULL WHERE tbl=?').bind(table),
      db.prepare(`INSERT INTO _governance_invalidations(tbl,row_id,version)
        SELECT ?,row_id,lower(hex(randomblob(16))) FROM (
          SELECT id AS row_id FROM ${qident(table)} UNION SELECT row_id FROM _governance_heads WHERE tbl=?
          UNION SELECT row_id FROM _governance_invalidations WHERE tbl=?) WHERE row_id IS NOT NULL
        ON CONFLICT(tbl,row_id) DO UPDATE SET version=excluded.version`).bind(table,table,table),
      ...expected.map(t=>db.prepare(t.sql)),
      db.prepare('INSERT INTO _governance_layouts(tbl,sql) VALUES (?,?) ON CONFLICT(tbl) DO UPDATE SET sql=excluded.sql').bind(table,sql),
    ]);
  }
}
export async function hasContinuityGuards(view,table){
  const layout=await view.prepare("SELECT l.sql FROM _governance_layouts l JOIN sqlite_master m ON m.name=l.tbl AND m.type='table' AND m.sql=l.sql WHERE l.tbl=?").bind(table).first();
  if(!layout)return false;
  const {results:columns}=await view.prepare('SELECT name FROM pragma_table_xinfo(?) ORDER BY cid').bind(table).all();
  const expected=continuityTriggers(table,columns.map(c=>c.name));
  const {results}=await view.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND name GLOB '_governance_rows_*' ORDER BY name").bind(table).all();
  return expected.length===3 && results.length===3 && results.every(t=>trustedContinuityTrigger(t,columns.map(c=>c.name)));
}
