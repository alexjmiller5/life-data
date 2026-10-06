import {checkedReads,readGuards} from './write.js';
import {preparePatch,commitPreparedPatch} from './patch.js';
import {scopedTable,authorizeTable,broadTableAccess,ScopeDenied} from './scopes.js';
import {inverseEvidence,typedCells} from './governance-evidence.js';
import {planSelectedInverse} from '../../core/src/governance.ts';
import {qident,sha256hex,validEditTimestamp} from './validate.js';
import {hasContinuityGuards} from './governance-continuity.js';
import {canonical} from './governance-store.js';
import {assertGenericState} from './governance-isolation.js';

export const limits=Object.freeze({maxSelectedEvents:100,maxChangedColumns:64,maxRequestBytes:65536,maxPageSize:100,previewTtlSeconds:300});
export {object,nonempty,exact,isTarget as validTarget} from '../../core/src/governance-wire.ts';
export {isCellValue as cell} from '../../core/src/governance.ts';
import {object,nonempty,exact,isTarget as validTarget,isIntent} from '../../core/src/governance-wire.ts';
import {isCellValue as cell} from '../../core/src/governance.ts';
export const same=(a,b)=>canonical(a)===canonical(b);
export const validIntent=intent=>isIntent(intent,limits);
const from64=text=>Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const to64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export function configuration(env){
  if(!nonempty(env.GOVERNANCE_DEPLOYMENT_ID) || !/^[A-Za-z0-9_-]{43}$/.test(env.GOVERNANCE_PREVIEW_KEY ?? ''))return null;
  const bytes=from64(env.GOVERNANCE_PREVIEW_KEY);
  return bytes.length===32 && to64(bytes)===env.GOVERNANCE_PREVIEW_KEY ? {deployment:env.GOVERNANCE_DEPLOYMENT_ID,bytes} : null;
}
export async function seal(config,payload){
  const key=await crypto.subtle.importKey('raw',config.bytes,'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('life-governance-v1:'+config.deployment)},key,new TextEncoder().encode(JSON.stringify(payload))));
  const out=new Uint8Array(iv.length+encrypted.length);out.set(iv);out.set(encrypted,iv.length);
  return to64(out);
}
export async function unseal(config,token){
  try{
    if(typeof token!=='string' || token.length>limits.maxRequestBytes || !/^[A-Za-z0-9_-]+$/.test(token))return null;
    const data=from64(token);if(data.length<29 || to64(data)!==token)return null;
    const key=await crypto.subtle.importKey('raw',config.bytes,'AES-GCM',false,['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:data.slice(0,12),additionalData:new TextEncoder().encode('life-governance-v1:'+config.deployment)},key,data.slice(12))));
  }catch{return null;}
}
export function permits(tenant,target,write=false){
  return validTarget(target) && (broadTableAccess(tenant.scopes,'read') || authorizeTable(tenant.scopes,'read',target.table))
    && (!write || broadTableAccess(tenant.scopes,'write') || authorizeTable(tenant.scopes,'write',target.table));
}
export const conflict=(code,column=null,eventIds=[])=>({code,column,eventIds,message:({validation_failed:'The changes do not satisfy current validation.',history_unavailable:'Complete typed history is unavailable.',revision_changed:'The record or its validation dependencies changed.',proposal_changed:'The proposal version is no longer pending.',unavailable:'This operation is unavailable.'})[code]});
const managed=new Set(['id','created_at','updated_at','hub_at','deleted_at']);
const physical=(type,value)=>value.type==='null' || (/INT/i.test(type)?value.type==='integer':/CHAR|CLOB|TEXT/i.test(type)?value.type==='text':/REAL|FLOA|DOUB/i.test(type)?value.type==='real':false);
export const stored=value=>value.type==='null'?null:value.type==='integer' && Number.isSafeInteger(Number(value.value))?Number(value.value):value.value;

export async function planPreview(db,tenant,args,{actor=null,operationId=null}={}){
  if(!permits(tenant,args.target))throw new ScopeDenied();
  const view=checkedReads(db),{target,intent}=args;
  await assertGenericState(view);
  await view.prepare('SELECT version FROM _governance_invalidations WHERE tbl=? AND row_id=?').bind(target.table,target.rowId).all();
  // Check every declared reference grant before following a reference table.
  const propsExist=await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_properties'").first();
  if(!propsExist)throw new ScopeDenied();
  const {results:props}=await view.prepare('SELECT * FROM catalog_properties WHERE tbl=? AND deleted_at IS NULL ORDER BY id').bind(target.table).all();
  for(const p of props)if(p.ref_table && !permits(tenant,{table:p.ref_table,rowId:target.rowId}))throw new ScopeDenied();
  const schema=await scopedTable(view,target.table,true,[target.rowId]);
  if(!await hasContinuityGuards(view,target.table))throw new ScopeDenied();
  // Supported static refs and same-table unique rules have bounded, explicit
  // dependencies. Do not infer a dependency from SQL text or a current value.
  const dependencies=new Set(props.filter(p=>p.ref_table).map(p=>p.ref_table));
  if(await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_rules'").first()){
    const {results:rules}=await view.prepare("SELECT * FROM catalog_rules WHERE tbl=? AND kind='invariant' AND enforce=1 AND deleted_at IS NULL ORDER BY id").bind(target.table).all();
    if(rules.length)dependencies.add(target.table);
  }
  for(const table of [...dependencies].sort()){
    const {results}=await view.prepare(`SELECT * FROM ${qident(table)} ORDER BY id LIMIT 2001`).all();
    if(results.length>2000)throw new ScopeDenied();
  }
  const row=await view.prepare(`SELECT id,updated_at,${schema.some(c=>c.name==='hub_at')?'hub_at':'NULL AS hub_at'},deleted_at FROM ${qident(target.table)} WHERE id=?`).bind(target.rowId).first();
  if(!row || row.id!==target.rowId || row.deleted_at!==null || !validEditTimestamp(row.updated_at) || (row.hub_at!==null && !validEditTimestamp(row.hub_at)))return null;
  const revision={updated_at:row.updated_at,hub_at:row.hub_at};
  let result;
  if(intent.kind==='selected_inverse')result=planSelectedInverse({target,eventIds:intent.eventIds},await inverseEvidence(view,target,revision,intent.eventIds));
  else{
    const columns=intent.changes.map(c=>c.column);
    if(columns.some(c=>managed.has(c)||!schema.some(s=>s.name===c)))result={changes:[],selectedEventIds:[],conflicts:[conflict('validation_failed')]};
    else{
      const current=await typedCells(view,target,columns);
      result={changes:[],selectedEventIds:[],conflicts:[]};
      for(const {column,after} of intent.changes){
        if(!cell(current[column]) || !physical(schema.find(s=>s.name===column).type,after)){result.conflicts.push(conflict('validation_failed',column));continue;}
        if(!same(current[column],after))result.changes.push({column,before:current[column],after});
      }
    }
  }
  const preview={target,revision,...result,previewToken:null,expiresAt:null};
  if(preview.conflicts.length){preview.changes=[];await db.batch(readGuards(db,view.reads));return {preview,view};}
  if(!preview.changes.length || preview.changes.length>limits.maxChangedColumns){preview.changes=[];preview.conflicts=[conflict('validation_failed')];await db.batch(readGuards(db,view.reads));return {preview,view};}
  const values=Object.fromEntries(preview.changes.map(c=>[c.column,stored(c.after)]));
  const plan=await preparePatch(db,{table:target.table,id:target.rowId,values,expected_revision:revision},null,{view,actor,operationId});
  if(plan instanceof Response){preview.changes=[];preview.conflicts=[conflict(plan.status===409?'revision_changed':'validation_failed')];await db.batch(readGuards(db,view.reads));return {preview,view};}
  const probe=await commitPreparedPatch(plan,{probe:true});
  if(probe){preview.changes=[];preview.conflicts=[conflict(probe.status===409?'revision_changed':probe.status===422?'validation_failed':'unavailable')];return {preview,view};}
  const dependenciesHash=await sha256hex(JSON.stringify([...view.reads.values()]));
  return {preview,view,plan,dependenciesHash};
}
export async function issuePreview(db,tenant,config,args,proposal=null){
  const planned=await planPreview(db,tenant,args);
  if(!planned)return null;
  if(planned.plan){
    const expiresAt=new Date(Date.now()+limits.previewTtlSeconds*1000).toISOString();
    const payload={type:'preview',principal:tenant.governance.actor.principalId,target:args.target,intent:args.intent,revision:planned.preview.revision,changes:planned.preview.changes,selectedEventIds:planned.preview.selectedEventIds,dependencies:planned.dependenciesHash,proposal,expiresAt};
    // Reserve room for the largest mutation envelope and authenticated framing.
    // Never offer a token that its own request size bound cannot accept.
    if(new TextEncoder().encode(JSON.stringify(payload)).length>Math.floor(limits.maxRequestBytes*0.6)){
      planned.preview.changes=[];planned.preview.conflicts=[conflict('unavailable')];
    }else{planned.preview.expiresAt=expiresAt;planned.preview.previewToken=await seal(config,payload);}
  }
  return planned;
}
