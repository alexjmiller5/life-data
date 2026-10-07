import {normalizeRowsQuery} from '../../core/src/query.ts';
import {checkedReads,readGuards,queryBudget} from './write.js';
import {scopedTable,ScopeDenied,broadTableAccess,authorizeTable} from './scopes.js';
import {qident} from './validate.js';
import {hashToken} from './auth.js';
import {enrollmentProfile} from './enrollment-profile.js';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const wire=v=>typeof v==='boolean'?Number(v):v;
const encode=v=>{
 const bytes=new TextEncoder().encode(JSON.stringify(v));
 if(bytes.length>24576)throw Error('cursor too large');
 return btoa(String.fromCharCode(...bytes));
};
function decode(text){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(text),c=>c.charCodeAt(0))));}

export async function rowsQuery(request,tenant,env){
 if(request.method!=='POST')return reply({error:'method not allowed'},405);
 let query;
 try{
  const reader=request.body?.getReader();if(!reader)throw Error();
  const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();return reply({error:'request too large'},413);}chunks.push(value);}
  const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  query=normalizeRowsQuery(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
 }catch{return reply({error:'invalid row query'},400);}
 const referenced=new Set([...query.columns,'id',...query.order.map(o=>o.column)]);
 function columns(node){if(!node)return;if(node.and||node.or)(node.and??node.or).forEach(columns);else referenced.add(node.column);}
 columns(query.filter);
 if(!broadTableAccess(tenant.scopes,'read')&&!authorizeTable(tenant.scopes,'read',query.table)
   && [...referenced].some(c=>!tenant.scopes.includes(`tables:read:${query.table}:${c}`)))return reply({error:'insufficient scope'},403);
 if(tenant.enrollmentProfile){
  const profile=await enrollmentProfile(env,tenant.enrollmentProfile.id);
  if(!profile||profile.revision!==tenant.enrollmentProfile.revision)return reply({error:'profile_changed'},409);
 }
 try{
  const db=queryBudget(tenant.db,100),view=checkedReads(db),schema=await scopedTable(view,query.table);
  if([...referenced].some(c=>!schema.some(s=>s.name===c)))return reply({error:'invalid query column'},400);
  const id=schema.find(c=>c.name==='id');
  if(id.type.toUpperCase()!=='TEXT')return reply({error:'unsupported query identity'},409);
  // Bind both identity collation and all inspected catalog/table shape to the cursor.
  const {cursor,...shape}=query;
  const binding=await hashToken(JSON.stringify([shape,[...view.reads.values()],tenant.enrollmentProfile??null]));
  let after;
  if(cursor){
   try{
    const decoded=decode(cursor);
    if(decoded.binding!==binding||!Array.isArray(decoded.values)||decoded.values.length!==query.order.length
      ||decoded.values.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))throw Error();
    after=decoded.values;
   }catch{return reply({error:'query_changed'},409);}
  }
  const args=[];
  const parameter=value=>{args.push(wire(value));return '?';};
  function compile(node){
   if(node.and||node.or)return '('+(node.and??node.or).map(compile).join(node.and?' AND ':' OR ')+')';
   const c=qident(node.column),v=node.value;
   switch(node.op){
    case 'is_null':return `${c} IS ${v?'':'NOT '}NULL`;
    case 'eq':return `${c} IS ${parameter(v)}`;
    case 'in':return `(${c} IN (SELECT value FROM json_each(${parameter(JSON.stringify(v.map(wire)))}))${v.includes(null)?` OR ${c} IS NULL`:''})`;
    case 'gte':return `${c} >= ${parameter(v)}`;
    case 'lte':return `${c} <= ${parameter(v)}`;
    case 'contains':return `instr(lower(${c}),lower(${parameter(v)})) > 0`;
   }
  }
  const conditions=query.filter?[compile(query.filter)]:[];
  if(after){
   const alternatives=[];
   query.order.forEach((sort,i)=>{
    if(after[i]===null)return;
    const equal=query.order.slice(0,i).map((prior,j)=>`${qident(prior.column)} IS ${parameter(after[j])}`);
    equal.push(`(${qident(sort.column)} IS NULL OR ${qident(sort.column)} ${sort.direction==='asc'?'>':'<'} ${parameter(after[i])})`);
    alternatives.push('('+equal.join(' AND ')+')');
   });
   conditions.push('('+(alternatives.join(' OR ')||'0')+')');
  }
  const selected=[...new Set([...query.columns,...query.order.map(o=>o.column)])];
  const ordering=query.order.flatMap(o=>[`${qident(o.column)} IS NULL`,`${qident(o.column)} ${o.direction.toUpperCase()}`]).join(',');
  const sql=`SELECT ${selected.map(qident).join(',')} FROM ${qident(query.table)}${conditions.length?' WHERE '+conditions.join(' AND '):''} ORDER BY ${ordering} LIMIT ?`;
  const result=await db.batch([...readGuards(db,view.reads),db.prepare(sql).bind(...args,query.limit+1)]);
  const rows=result.at(-1).results??[];
  if(rows.some(row=>typeof row.id!=='string'||query.order.some(o=>row[o.column]!==null&&(!['string','number'].includes(typeof row[o.column])||(typeof row[o.column]==='number'&&(!Number.isFinite(row[o.column])||(Number.isInteger(row[o.column])&&!Number.isSafeInteger(row[o.column]))))))))return reply({error:'unsupported query value'},409);
  const more=rows.length>query.limit;if(more)rows.pop();
  const next_cursor=more?encode({binding,values:query.order.map(o=>rows.at(-1)[o.column])}):null;
  return reply({rows:rows.map(row=>Object.fromEntries(query.columns.map(c=>[c,row[c]]))),next_cursor});
 }catch(error){
  return reply({error:error instanceof ScopeDenied?'insufficient scope':'query unavailable'},error instanceof ScopeDenied?403:409);
 }
}
