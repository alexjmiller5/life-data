import type {GetViewDefaultArgs,SetViewDefaultArgs,ViewDefault,Catalog} from './contract.generated.ts';
import type {SqlDriver} from './driver.ts';
import {readCatalog} from './catalog.ts';
import {listViews} from './saved-views.ts';
import {qident,validEditTimestamp,type Row} from './validate.ts';
import {commitWrite,ValidationError,type WriteCapture} from './write.ts';
import defaults from '../schema/view-defaults.json';
import related from '../schema/related-view-defaults.json';
const normalize=(sql:unknown)=>String(sql).replace(/\s+/g,' ').trim();
const idFor=(table:string,storage=defaults)=>(storage===defaults?'default:v1:':'related:v1:')+Array.from(table,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
function argumentsOf(value:unknown,keys:string[]):Row {
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Invalid view default arguments.');
 const descriptors=Object.getOwnPropertyDescriptors(value),copy:Row=Object.create(null);
 if(Reflect.ownKeys(descriptors).some(key=>typeof key!=='string'||!keys.includes(key)))throw Error('Invalid view default arguments.');
 for(const key of keys){const d=descriptors[key];if(!d||!d.enumerable||!('value' in d))throw Error('Invalid view default arguments.');copy[key]=d.value;}
 if(typeof copy.table!=='string')throw Error('Invalid default table.');qident(copy.table);
 return copy;
}
function transactionDriver(db:SqlDriver):SqlDriver {
 return {all:db.all.bind(db),run:db.run.bind(db),transaction:body=>body(),...(db.readDependencies?{readDependencies:db.readDependencies.bind(db)}:{})};
}
async function storageProblem(db:SqlDriver,catalog:Catalog,storage=defaults):Promise<string|null>{
 const schema=await db.all("SELECT name,sql FROM main.sqlite_master WHERE (type='table' AND name=?) OR (type='trigger' AND name=?) ORDER BY type",[storage.table.id,storage.table.id+'_updated_at']);
 if(!schema.length)return 'Default views need provisioning; sync their schema and catalog first.';
 const matches=(actual:Row|undefined,expected:object)=>!!actual&&Object.entries(expected).every(([key,value])=>actual[key]===value);
 const properties=catalog.properties.filter(p=>p.tbl===storage.table.id);
 if(schema.length!==storage.ddl.length||schema.some((row,i)=>normalize(row.sql)!==normalize(storage.ddl[i]))
   ||!matches(catalog.tables.find(t=>t.id===storage.table.id),storage.table)
   ||properties.length!==storage.properties.length
   ||storage.properties.some(({sort:_sort,...p})=>!matches(properties.find(v=>v.id===p.id),p)))
  return `Default-view schema or catalog does not match ${storage.table.id}; setup review is required.`;
 return null;
}
async function read(db:SqlDriver,table:string,storage=defaults):Promise<ViewDefault>{
 const catalog=await readCatalog(db),unavailable=await storageProblem(db,catalog,storage);
 const result:ViewDefault={table,viewId:null,updated_at:null,view:null,unavailable};
 if(unavailable)return result;
 if(!catalog.tables.some(t=>t.id===table))throw Error('Default table is unavailable.');
 const rows=await db.all(`SELECT id,tbl,view_id,updated_at,deleted_at FROM main.${qident(storage.table.id)} WHERE id=? OR tbl=?`,[idFor(table,storage),table]);
 if(!rows.length)return result;
 const row=rows[0];
 if(rows.length!==1||row.id!==idFor(table,storage)||row.tbl!==table||!validEditTimestamp(row.updated_at)
   ||(row.view_id!==null&&(typeof row.view_id!=='string'||!row.view_id)))throw Error('Stored view default is invalid; no settings were changed.');
 result.updated_at=row.updated_at as string;result.viewId=row.deleted_at===null ? row.view_id as string|null : null;
 if(result.viewId===null)return result;
 const views=await listViews(db,{table});
 const target=views.views.find(v=>v.id===result.viewId);
 if(views.unavailable||!target||target.unavailable||!target.definition||!target.view)
  result.unavailable=storage===defaults?'The preferred view is unavailable for this table. Showing the catalog default.':'The related-record view is unavailable for this table. Showing all live linked records.';
 else result.view=target;
 return result;
}
export async function getViewDefault(db:SqlDriver,input:GetViewDefaultArgs,storage=defaults):Promise<ViewDefault>{
 const args=argumentsOf(input,['table']),table=args.table as string;
 return db.transaction(()=>read(transactionDriver(db),table,storage));
}
export async function setViewDefault(db:SqlDriver,input:SetViewDefaultArgs,options:{origin?:string}={},capture?: (value:WriteCapture)=>void,storage=defaults):Promise<ViewDefault>{
 const args=argumentsOf(input,['table','viewId','expectedUpdatedAt']);
 const table=args.table as string,viewId=args.viewId,expected=args.expectedUpdatedAt,origin=options.origin;
 if(viewId!==null&&(typeof viewId!=='string'||!viewId)||expected!==null&&!validEditTimestamp(expected))throw Error('Invalid view default selection or revision.');
 return db.transaction(async()=>{
  const tx=transactionDriver(db),state=await read(tx,table,storage);
  const problem=await storageProblem(tx,await readCatalog(tx),storage);if(problem)throw Error(problem);
  if(state.updated_at!==expected)throw new ValidationError([{tbl:storage.table.id,row_id:null,col:'updated_at',rule:'conflict',message:'The default view changed; reload before retrying.'}]);
  if(viewId!==null){const list=await listViews(tx,{table});const target=list.views.find(v=>v.id===viewId);if(list.unavailable||!target||target.unavailable||!target.view||!target.definition)throw Error('Selected view is unavailable for this table.');}
  const committed = state.updated_at===null
    ? await commitWrite(tx,storage.table.id,{tbl:table,view_id:viewId},{origin,id:()=>idFor(table,storage)},!!capture)
    : await commitWrite(tx,storage.table.id,{id:idFor(table,storage),view_id:viewId,deleted_at:null},{origin,expectedUpdatedAt:state.updated_at},!!capture);
  if(committed.capture)capture?.(committed.capture);
  return read(tx,table,storage);
 });
}

export const getRelatedViewDefault=(db:SqlDriver,input:GetViewDefaultArgs)=>getViewDefault(db,input,related);
export const setRelatedViewDefault=(db:SqlDriver,input:SetViewDefaultArgs,options:{origin?:string}={},capture?: (value:WriteCapture)=>void)=>setViewDefault(db,input,options,capture,related);
