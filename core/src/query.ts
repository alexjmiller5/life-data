export type QueryScalar=string|number|boolean|null;
export type QueryFilter={and:QueryFilter[]}|{or:QueryFilter[]}|{column:string;op:'eq'|'in'|'gte'|'lte'|'contains'|'is_null';value:QueryScalar|QueryScalar[]};
export type NormalizedRowsQuery={table:string;columns:string[];filter?:QueryFilter;order:{column:string;direction:'asc'|'desc'}[];limit:number;cursor?:string};
const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v);
const identifier=(v:unknown):v is string=>typeof v==='string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v);
const scalar=(v:unknown):v is QueryScalar=>v===null || typeof v==='boolean' || (typeof v==='string' && v.length<=4096)
  || (typeof v==='number' && Number.isFinite(v) && (!Number.isInteger(v)||Number.isSafeInteger(v)));
const bad=():never=>{throw Error('invalid row query');};
export function supportsRowsQuery(capabilities:unknown):boolean{return object(capabilities)&&capabilities.row_query==='bounded-v1';}

/** Pure bounded request policy. Hosts own transport and credentials; no fallback. */
export function normalizeRowsQuery(body:unknown):NormalizedRowsQuery {
 if(!object(body) || Object.keys(body).some(k=>!['table','columns','filter','order','limit','cursor'].includes(k))
  || !identifier(body.table) || !Array.isArray(body.columns) || !body.columns.length || body.columns.length>256
  || !body.columns.every(identifier) || new Set(body.columns).size!==body.columns.length) return bad();
 const limit=body.limit??50;
 if(typeof limit!=='number'||!Number.isInteger(limit)||limit<1||limit>200) return bad();
 let leaves=0;
 function filter(node:unknown,depth=0):QueryFilter {
  if(depth>4||!object(node)) return bad();
  if(Object.hasOwn(node,'and')||Object.hasOwn(node,'or')){
   const key=Object.hasOwn(node,'and')?'and':'or',children=node[key];
   if(Object.keys(node).length!==1||!Array.isArray(children)||!children.length||children.length>64)return bad();
   return {[key]:children.map(child=>filter(child,depth+1))} as QueryFilter;
  }
  if(++leaves>64||Object.keys(node).length!==3||!identifier(node.column)||!Object.hasOwn(node,'value'))return bad();
  const {column,op,value}=node;
  if(op==='is_null') {if(typeof value!=='boolean')return bad();}
  else if(op==='contains') {if(typeof value!=='string'||value.length>4096)return bad();}
  else if(op==='in'){if(!Array.isArray(value)||!value.length||value.length>200||!value.every(scalar))return bad();}
  else if(!['eq','gte','lte'].includes(op as string)||!scalar(value)||(value===null&&op!=='eq'))return bad();
  return {column,op,value} as QueryFilter;
 }
 const order=body.order??[];
 if(!Array.isArray(order)||order.length>3||order.some(o=>!object(o)||Object.keys(o).length!==2
   ||!identifier(o.column)||!['asc','desc'].includes(o.direction as string))||new Set(order.map(o=>o.column)).size!==order.length)return bad();
 if(order.some((o,i)=>o.column==='id'&&i!==order.length-1))return bad();
 const sorted=order.map(o=>({column:o.column as string,direction:o.direction as 'asc'|'desc'}));
 if(!sorted.some(o=>o.column==='id'))sorted.push({column:'id',direction:'asc'});
 if(body.cursor!==undefined&&(typeof body.cursor!=='string'||!body.cursor.length||body.cursor.length>32768))return bad();
 return {table:body.table,columns:[...body.columns].sort(),...(body.filter===undefined?{}:{filter:filter(body.filter)}),order:sorted,limit,...(body.cursor===undefined?{}:{cursor:body.cursor as string})};
}
