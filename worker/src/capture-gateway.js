import {validateCaptureReceipt} from '../../core/src/capture.ts';
import {hashToken} from './auth.js';
import {enrollmentProfile} from './enrollment-profile.js';

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function boundedJSON(stream){
 const reader=stream?.getReader();if(!reader)throw Error('invalid body');
 const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw Error('body too large');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function adapterConfig(env,name){
 if(typeof env.CAPTURE_ADAPTERS!=='string'||env.CAPTURE_ADAPTERS.length>65536)return null;
 try{
  const configs=JSON.parse(env.CAPTURE_ADAPTERS),config=Object.hasOwn(configs,name)&&configs[name];
  if(!object(config)||typeof config.credential!=='string'||!config.credential||!object(config.fields))return null;
  const url=new URL(config.url);
  if(url.protocol!=='https:'||url.username||url.password||url.hash)return null;
  if(Object.values(config.fields).some(scopes=>!Array.isArray(scopes)||!scopes.length||scopes.some(scope=>typeof scope!=='string'||!/^tables:patch:[A-Za-z][A-Za-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$/.test(scope))))return null;
  return config;
 }catch{return null;}
}

/** Advertise configured transport only; capabilities never expand authority. */
export function captureCapability(env,scopes){
 const names=[...new Set(scopes.flatMap(scope=>{
  const match=/^captures:(?:read|submit):([a-z][a-z0-9-]{0,63})$/.exec(scope);
  return match?[match[1]]:[];
 }))].sort();
 const adapters=names.flatMap(id=>{
  const config=adapterConfig(env,id);if(!config)return [];
  const read=scopes.includes(`captures:read:${id}`);
  const submit=scopes.includes(`captures:submit:${id}`)&&Object.values(config.fields).flat().every(scope=>scopes.includes(scope));
  return read||submit?[{id,read,submit}]:[];
 });
 return adapters.length?{protocol:'receipt-v1',adapters}:undefined;
}

// Acceptance waits for the adapter's serialized writer (a cold start or a capture
// already in progress); receipt reads do not, so they keep the tighter bound.
export const UPSTREAM_TIMEOUTS={read:15000,submit:60000};

/** Stateless adapter. Synapse owns the durable receipt and serialized writer. */
export async function captureGateway(request,tenant,env,fetcher=fetch,timeouts=UPSTREAM_TIMEOUTS){
 const url=new URL(request.url),match=/^\/v1\/captures\/([a-z][a-z0-9-]{0,63})(?:\/([0-9a-f-]+))?$/.exec(url.pathname);
 if(!match||url.search)return reply({error:'invalid capture route'},400);
 const read=request.method==='GET'&&uuid(match[2]);
 const submit=request.method==='POST'&&!match[2];
 if(!read&&!submit)return reply({error:'method not allowed'},405);
 const name=match[1];
 if(!tenant.hash||!tenant.scopes.includes(`captures:${read?'read':'submit'}:${name}`))return reply({error:'insufficient scope'},403);
 if(tenant.enrollmentProfile){
  const current=await enrollmentProfile(env,tenant.enrollmentProfile.id);
  if(!current||current.revision!==tenant.enrollmentProfile.revision
   ||current.scopes.length!==tenant.scopes.length||current.scopes.some(scope=>!tenant.scopes.includes(scope)))return reply({error:'profile_changed'},409);
 }
 const config=adapterConfig(env,name);if(!config)return reply({error:'capture unavailable'},503);
 let payload;
 if(submit){
  try{payload=await boundedJSON(request.body);}catch{return reply({error:'invalid capture'},400);}
  if(!object(payload)||Object.keys(payload).some(k=>!['request_id','input','intent','fields'].includes(k))||!uuid(payload.request_id)
    ||!['save','record_consumption'].includes(payload.intent)||!object(payload.input)||Object.keys(payload.input).length!==1
    ||!Object.keys(payload.input).every(k=>['text','url'].includes(k))||!Object.values(payload.input).every(v=>typeof v==='string'&&v.trim().length>0)
    ||(payload.fields!==undefined&&!object(payload.fields)))return reply({error:'invalid capture'},400);
  if(payload.input.url){try{const inputURL=new URL(payload.input.url);if(!['https:','http:'].includes(inputURL.protocol)||inputURL.username||inputURL.password)throw Error();}catch{return reply({error:'invalid capture'},400);}}
  // Resolution may infer edits from text. Require every configured writable
  // field, not only explicit keys, before delegating that bounded authority.
  const fields=[...Object.keys(config.fields),...Object.keys(payload.fields??{}),...(payload.intent==='save'?['saved']:[])];
  if(fields.some(field=>!Object.hasOwn(config.fields,field)||config.fields[field].some(scope=>!tenant.scopes.includes(scope))))return reply({error:'insufficient scope'},403);
 }
 const requestId=read?match[2]:payload.request_id;
 const delegated={action:read?'get':'submit',allowed_fields:Object.keys(config.fields),subject:await hashToken(`capture-subject:${tenant.hash}`),...(read?{request_id:requestId}:{request:payload})};
 try{
  const upstream=await fetcher(config.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(read?timeouts.read:timeouts.submit),headers:{Authorization:`Bearer ${config.credential}`,'Content-Type':'application/json'},body:JSON.stringify(delegated)});
  if(upstream.status===404)return reply({error:'capture not found'},404);
  if(upstream.status===409)return reply({error:'request conflict'},409);
  if(!upstream.ok)return reply({error:'capture unavailable'},503);
  let result;try{result=await boundedJSON(upstream.body);}catch{return reply({error:'invalid capture receipt'},502);}
  let receipt;try{receipt=validateCaptureReceipt(result,requestId);}catch{return reply({error:'invalid capture receipt'},502);}
  return reply(receipt,['received','processing'].includes(receipt.state)?202:200);
 }catch{return reply({error:'capture unavailable'},503);}
}
