// Generic data credentials may edit rows/schema, but cannot manufacture user
// approval or erase original-operation exclusion keys through another route.
import {continuitySchemas,trustedContinuityTrigger} from './governance-continuity.js';
import {ScopeDenied} from './scopes.js';
import {trustedEvidenceTrigger,EVIDENCE_DDL} from './governance-evidence.js';
import {PROPOSAL_DDL} from './governance-proposals.js';
import {RECEIPTS_DDL} from './governance-store.js';
const reserved=value=>typeof value==='string' && /_governance_/i.test(value);
const deny=()=>{throw new ScopeDenied('insufficient scope');};
const normalized=sql=>sql.replace(/IF NOT EXISTS /g,'').replace(/\s+/g,' ').trim();
export function assertPublicSql(value){if(reserved(value))deny();}
export function assertGenericBody(body){
  if(reserved(body?.table) || /^sqlite_/i.test(body?.table ?? ''))deny();
  if(typeof body?.table==='string' && body.table.toLowerCase()==='purges' && ((body.rows ?? []).some(row=>reserved(row.tbl)) || reserved(body.values?.tbl)))deny();
  if(/^catalog_/i.test(body?.table ?? '')){
    for(const row of body.rows ?? [])
      for(const key of ['sql','options_sql','default_value','ref_table','derived_by'])if(reserved(row[key]))deny();
    for(const key of ['sql','options_sql','default_value','ref_table','derived_by'])if(reserved(body.values?.[key]))deny();
  }
}
export function assertGenericDDL(ddl){
  // Schema replay accepts DDL only. Checking the entire statement also covers
  // quoted identifiers, trigger bodies, virtual-table content and later SQL.
  // Reject reserved text conservatively, including inside SQL string literals.
  if(typeof ddl!=='string' || reserved(ddl) || /\bsqlite_(?:master|schema|temp_master|temp_schema)\b/i.test(ddl))deny();
  const stripped=ddl.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\r\n]*/g,' ').trim();
  if(!/^(?:CREATE\s+(?:(?:UNIQUE|VIRTUAL)\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\b|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b)/i.test(stripped))deny();
}
export async function assertGenericState(view){
  const {results:objects}=await view.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const schemas=await continuitySchemas(view);
  for(const object of objects){
    if(!reserved(object.sql))continue;
    if([...EVIDENCE_DDL,...PROPOSAL_DDL,RECEIPTS_DDL].some(sql=>normalized(sql)===normalized(object.sql)))continue;
    if(trustedEvidenceTrigger(object) || trustedContinuityTrigger(object,schemas.get(object.tbl_name) ?? []))continue;
    deny();
  }
  for(const [table,columns] of [['catalog_properties',['options_sql','default_value','ref_table','derived_by']],['catalog_rules',['sql']]]){
    if(!objects.some(o=>o.type==='table' && o.name===table))continue;
    const {results:schema}=await view.prepare('SELECT name FROM pragma_table_info(?)').bind(table).all();
    const selected=columns.filter(c=>schema.some(s=>s.name===c));
    if(!selected.length)continue;
    const {results}=await view.prepare(`SELECT ${selected.join(',')} FROM ${table}`).all();
    if(results.some(row=>Object.values(row).some(reserved)))deny();
  }
}
