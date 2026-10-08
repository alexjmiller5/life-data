// One policy-bound initialization. No caller selects edge fields or a writer.
import { checkedReads, prepareChecked, readGuards, enforcedRules, queryBudget } from './write.js';
import { qident, sha256hex, validEditTimestamp, validatePush } from './validate.js';
import { scopedTable, scopedOrigin, ScopeDenied } from './scopes.js';
import { markChanged } from './changes.js';

const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const keys=(v,names)=>object(v) && Object.keys(v).sort().join(',')===[...names].sort().join(',');
const identifier=v=>typeof v==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
const ordinary=v=>identifier(v) && !/^(?:_|sqlite_|catalog_)/i.test(v) && !/^(?:history|provenance|purges)$/i.test(v);
const bytes=v=>new TextEncoder().encode(v);
const text=v=>typeof v==='string' && v.length>0 && bytes(v).length<=1024 && new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes(v))===v;
const forbidden=new Set(['id','created_at','updated_at','hub_at','deleted_at']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const policyId=v=>typeof v==='string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v);
const reply=(error,status)=>Response.json({error},{status});
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export async function creationPolicies(env) {
  if(!env.ROW_CREATION_POLICIES)return [];
  let values;try{values=JSON.parse(env.ROW_CREATION_POLICIES);}catch{return [];}
  if(!object(values) || Object.keys(values).length>64)return [];
  const out=[];
  for(const [id,v] of Object.entries(values)) {
    const singleton=v?.occurrenceType==='none';
    const fields=['namespace','sourceKind','occurrenceType','table','columns','origin'];
    if(singleton)fields.push('identity');
    if(!policyId(id) || !keys(v,fields)
      || typeof v.namespace!=='string' || !uuid.test(v.namespace) || !text(v.sourceKind) || !['integer','string','none'].includes(v.occurrenceType)
      || (singleton && (!keys(v.identity,['encoding','prefix']) || v.identity.encoding!=='prefix-source-v1' || !text(v.identity.prefix)))
      || !ordinary(v.table) || !Array.isArray(v.columns) || !v.columns.length || v.columns.length>64
      || v.columns.some(c=>!identifier(c)||forbidden.has(c.toLowerCase())) || new Set(v.columns).size!==v.columns.length
      || !keys(v.origin,['kind','table','relation']) || !(typeof v.origin.kind==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v.origin.kind))
      || (v.origin.table!==null && !ordinary(v.origin.table)) || !text(v.origin.relation))return [];
    const config={namespace:v.namespace,sourceKind:v.sourceKind,occurrenceType:v.occurrenceType,table:v.table,
      columns:[...v.columns].sort(),origin:{kind:v.origin.kind,table:v.origin.table,relation:v.origin.relation}};
    if(singleton)config.identity={encoding:v.identity.encoding,prefix:v.identity.prefix};
    out.push({id,revision:await sha256hex(JSON.stringify(config)),config});
  }
  return out;
}
export function creationGrant(policy) { return `rows:create:${policy.id}:${policy.revision}`; }
export const hasCreationScope=scopes=>scopes.some(s=>s.startsWith('rows:create:'));
export async function creationCapability(env,scopes) {
  const policies=(await creationPolicies(env)).filter(p=>scopes.includes(creationGrant(p))).map(({id,revision})=>({id,revision}));
  return policies.length?{protocol:'atomic-origin-v1',policies}:null;
}
export async function creationId(policy,sourceId,occurrenceKey) {
  const namespace=Uint8Array.from(policy.namespace.replaceAll('-','').match(/../g).map(b=>parseInt(b,16)));
  const name=bytes(policy.occurrenceType==='none'
    ? policy.identity.prefix+sourceId
    : JSON.stringify(['v1',policy.sourceKind,sourceId,occurrenceKey]));
  const data=new Uint8Array(namespace.length+name.length);data.set(namespace);data.set(name,namespace.length);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-1',data)).slice(0,16);
  hash[6]=(hash[6]&15)|80;hash[8]=(hash[8]&63)|128;
  return [...hash].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function binaryIdentity(view,table) {
  const columns=await scopedTable(view,table);
  await requireBinaryIdentity(view,table,columns);
  return columns;
}
async function requireBinaryIdentity(view,table,columns) {
  const {results:key}=await view.prepare("SELECT x.name,x.coll FROM pragma_index_list(?) i JOIN pragma_index_xinfo(i.name) x WHERE i.origin='pk' AND x.key=1 ORDER BY x.seqno").bind(table).all();
  if(columns.find(c=>c.name==='id')?.type?.toUpperCase()!=='TEXT' || key.length!==1 || key[0].name!=='id' || key[0].coll!=='BINARY')throw new ScopeDenied('insufficient scope');
}
async function purged(view,table,id) {
  if(!await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purges'").first())return false;
  return !!await view.prepare('SELECT id FROM purges WHERE tbl=? AND row_id=? AND deleted_at IS NULL').bind(table,id).first();
}
function insert(db,table,row) {
  const entries=Object.entries(row).filter(([c])=>c!=='hub_at');
  return db.prepare(`INSERT INTO ${qident(table)} (${entries.map(([c])=>qident(c)).join(',')},hub_at)
    VALUES (${entries.map(()=>'?').join(',')},${now}) RETURNING id,updated_at,hub_at`)
    .bind(...entries.map(([,v])=>typeof v==='boolean'?Number(v):v));
}
async function plan(db,view,table,row,exact=false) {
  const validation=await validatePush(view,table,[row],db,true);
  if(validation.rejected.length || validation.accepted.length!==1 || validation.expected.length!==1)throw new Error('creation_rejected');
  const {accepted,expected,props,transitions}=validation;
  if(exact && Object.entries(row).some(([column,value])=>accepted[0][column]!==value))throw new Error('creation_rejected');
  const rules=await enforcedRules(view,table);
  const prepared=await prepareChecked(db,table,rules,[insert(db,table,accepted[0])],new Date().toISOString(),null,expected,props,transitions);
  // A trusted-looking trigger must not suppress creation without a receipt.
  const assertion=db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM ${qident(table)} WHERE id=? AND updated_at=?)
    THEN 1 ELSE abs(-9223372036854775808) END AS life_write_conflict`).bind(row.id,row.updated_at);
  return {...prepared,assertion};
}

export async function handleCreation(request,tenant,env) {
  if(request.method!=='POST')return reply('permission_denied',403);
  let raw,body;
  try {
    if(!request.body)return reply('invalid_creation',400);
    const reader=request.body.getReader(),chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>16384){await reader.cancel();return reply('invalid_creation',400);}chunks.push(value);}
    const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
    raw=new TextDecoder('utf-8',{fatal:true}).decode(all);body=JSON.parse(raw);
  }catch{return reply('invalid_creation',400);}
  if(!object(body) || !keys(body.policy,['id','revision']))return reply('invalid_creation',400);
  const policy=(await creationPolicies(env)).find(p=>p.id===body.policy.id && p.revision===body.policy.revision && tenant.scopes.includes(creationGrant(p)));
  if(!policy)return reply('permission_denied',403);
  const p=policy.config;
  const fields=['policy','sourceId','target','updatedAt','values'];
  if(p.occurrenceType!=='none')fields.push('occurrenceKey');
  if(!keys(body,fields))return reply('invalid_creation',400);
  if(!text(body.sourceId) || !keys(body.target,['kind','id']) || !['generated','adopted'].includes(body.target.kind)
    || !text(body.target.id) || !object(body.values) || Object.keys(body.values).some(c=>!p.columns.includes(c))
    || Object.values(body.values).some(v=>(v!==null && !['string','number','boolean'].includes(typeof v)) || (typeof v==='number' && !Number.isFinite(v)))
    || (p.occurrenceType!=='none' && (p.occurrenceType==='integer'?!Number.isSafeInteger(body.occurrenceKey):!text(body.occurrenceKey))))return reply('invalid_creation',400);
  if(body.target.kind==='generated' && body.target.id!==await creationId(p,body.sourceId,body.occurrenceKey))return reply('invalid_creation',400);
  const db=queryBudget(tenant.db,750),view=checkedReads(db),id=body.target.id;
  try {
    const columns=await binaryIdentity(view,p.table);
    if(await purged(view,p.table,id))return reply(body.target.kind==='adopted'?'adopted_missing':'creation_rejected',body.target.kind==='adopted'?409:422);
    const existing=await view.prepare(`SELECT id FROM ${qident(p.table)} WHERE id=?`).bind(id).first();
    if(existing) {
      if(existing.id!==id)return reply('creation_unavailable',503);
      await db.batch(readGuards(db,view.reads));
      return Response.json({kind:'existing',policy:body.policy,id});
    }
    if(body.target.kind==='adopted')return reply('adopted_missing',409);
    if(!validEditTimestamp(body.updatedAt))return reply('invalid_creation',400);
    if(!columns.some(c=>c.name==='hub_at') || !columns.some(c=>c.name==='deleted_at'))return reply('creation_unavailable',503);
    if(Object.keys(body.values).some(c=>!columns.some(column=>column.name===c)))return reply('creation_unavailable',503);
    await scopedTable(view,p.table,true,[id]);
    if(p.origin.table) {
      await binaryIdentity(view,p.origin.table);
      if(await purged(view,p.origin.table,body.sourceId))return reply('creation_rejected',422);
      const source=await view.prepare(`SELECT id FROM ${qident(p.origin.table)} WHERE id=? AND deleted_at IS NULL`).bind(body.sourceId).first();
      if(source?.id!==body.sourceId)return reply('creation_rejected',422);
    }
    const originId=`${p.origin.kind}:${body.sourceId}:${id}`;
    const originColumns=await scopedOrigin(view,[originId]);
    await requireBinaryIdentity(view,'provenance',originColumns);
    const originStrings=['id','from_kind','from_ref','to_kind','to_ref','rel','asserted_by','updated_at'];
    if(!originColumns.some(c=>c.name==='hub_at') || originStrings.some(name=>{
      const type=originColumns.find(c=>c.name===name)?.type ?? '';
      return /INT/i.test(type) || !/CHAR|CLOB|TEXT/i.test(type);
    }))return reply('creation_unavailable',503);
    if(await view.prepare('SELECT id FROM provenance WHERE id=?').bind(originId).first())return reply('creation_rejected',422);
    // Guard complete trigger/schema topology before any validation/default work.
    await view.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') AND name NOT LIKE '_cf_%' AND name NOT GLOB '_life_write_*' ORDER BY name").all();
    const stamp=new Date().toISOString();
    const target=await plan(db,view,p.table,{id,...body.values,updated_at:body.updatedAt,deleted_at:null});
    const origin=await plan(db,view,'provenance',{id:originId,from_kind:p.origin.kind,from_ref:body.sourceId,to_kind:p.table,to_ref:id,field:null,
      rel:p.origin.relation,asserted_by:p.namespace,updated_at:stamp,deleted_at:null},true);
    const guards=readGuards(db,view.reads),begin=[...guards,...target.begin,...origin.begin];
    const receipts=await db.batch([...begin,...target.statements,...origin.statements,target.assertion,origin.assertion,...origin.end,...target.end]);
    const created=receipts[begin.length]?.results?.[0];
    if(!created || created.id!==id)throw new Error('creation_unavailable');
    markChanged();
    return Response.json({kind:'created',policy:body.policy,id,revision:{updated_at:created.updated_at,hub_at:created.hub_at},originId});
  } catch(error) {
    const message=String(error);
    if(/life_write_conflict|integer overflow/.test(message))return reply('creation_conflict',409);
    if(/creation_rejected|life_invariant_|life_property_|life_outbox_event_size/.test(message))return reply('creation_rejected',422);
    return reply('creation_unavailable',503);
  }
}
