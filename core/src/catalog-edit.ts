import type {SaveCatalogPropertyArgs,SaveCatalogRuleArgs} from './contract.generated.ts';
import type {SqlDriver,Value} from './driver.ts';
import {decodeProperty} from './catalog.ts';
import {initCore} from './sync.ts';
import {prepareWriteStorage,assertCatalogCoverage,ValidationError} from './write.ts';
import {qident,validEditTimestamp,type Row,type Property} from './validate.ts';
import {supportedRuleSql} from './rule-sql.ts';

const storage:Record<string,string>={text:'TEXT',markdown:'TEXT',number:'REAL',int:'INTEGER',bool:'INTEGER',date:'TEXT',datetime:'TEXT',date_or_datetime:'TEXT',json:'TEXT',select:'TEXT',multi_select:'TEXT',ref:'TEXT',multi_ref:'TEXT',url:'TEXT',email:'TEXT',phone:'TEXT'};
const propertyFields=new Set(['label','sort','type','required','default_value','options','options_sql','min_items','max_items','pattern','ref_table','derived_by','inputs','immutable','deprecated','description','source','source_ref']);
const ruleFields=new Set(['scope','col','kind','text','sql','cmd','enforce']);
/** Option chip colors: the Notion palette names, stored lowercase. */
export const OPTION_COLORS=['default','gray','brown','orange','yellow','green','blue','purple','pink','red'] as const;
function optionColors(options:unknown):unknown {
 if(!Array.isArray(options))return options;
 return options.map(option=>{
  if(!option||typeof option!=='object'||Array.isArray(option)||!Object.hasOwn(option,'color'))return option;
  const {color,...rest}=option as Record<string,unknown>;
  return color==null?rest:{...rest,color:typeof color==='string'?color.trim().toLowerCase():color};
 });
}
type Edit={table:string;expectedUpdatedAt:string|null;fields:Row};
type CatalogPropertyEdit=SaveCatalogPropertyArgs;
type CatalogRuleEdit=SaveCatalogRuleArgs;

function data(value:unknown,seen=new Set<object>(),depth=0):any {
 if(depth>16)throw Error('Catalog input is too deeply nested.');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string'){if(value.length>65536)throw Error('Catalog text is too long.');return value;}
 if(!value||typeof value!=='object'||seen.has(value))throw Error('Catalog input must contain acyclic plain data.');
 const array=Array.isArray(value);
 if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Catalog input must contain plain data.');
 if(array&&value.length>1000)throw Error('Catalog list is too long.');
 const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
 if(keys.length>1001)throw Error('Catalog input has too many fields.');
 const result:any=array?[]:Object.create(null);seen.add(value);
 try{
  for(const key of keys){
   if(array&&key==='length')continue;
   const descriptor=descriptors[key as string]!;
   if(typeof key!=='string'||!descriptor.enumerable||!('value'in descriptor)||key==='__proto__'||array&&!/^(0|[1-9][0-9]*)$/.test(key))throw Error('Catalog input must contain plain data.');
   result[key]=data(descriptor.value,seen,depth+1);
  }
  if(array&&keys.length!==value.length+1)throw Error('Catalog lists cannot have holes.');
  return result;
 }finally{seen.delete(value);}
}
function input<T extends Edit>(value:T,keys:string[]):T {
 const args=data(value) as T;
 if(JSON.stringify(args).length>262144)throw Error('Catalog edit is too large.');
 if(Object.keys(args).some(key=>!keys.includes(key))||typeof args.table!=='string'||!args.fields||Array.isArray(args.fields)||typeof args.fields!=='object')throw Error('Invalid catalog edit.');
 qident(args.table);
 if(!Object.hasOwn(args,'expectedUpdatedAt')||args.expectedUpdatedAt!==null&&!validEditTimestamp(args.expectedUpdatedAt))throw Error('Reopen the catalog to obtain its current revision.');
 return args;
}
function fields(value:Row,allowed:Set<string>):void {
 if(!Object.keys(value).length||Object.keys(value).some(key=>!allowed.has(key)))throw Error('Unknown or empty catalog fields.');
}
function property(value:Row):void {
 if(typeof value.type!=='string'||!Object.hasOwn(storage,value.type))throw Error('Choose a supported property type.');
 for(const key of ['required','immutable','deprecated'])if(value[key]!=null&&value[key]!==0&&value[key]!==1)throw Error(`${key} must be 0 or 1.`);
 for(const key of ['sort','min_items','max_items'])if(value[key]!=null&&(!Number.isSafeInteger(value[key])||key!=='sort'&&Number(value[key])<0))throw Error(`${key} must be an integer.`);
 if(value.min_items!=null&&value.max_items!=null&&Number(value.min_items)>Number(value.max_items))throw Error('Minimum items exceeds maximum items.');
 for(const key of propertyFields)if(!['sort','required','min_items','max_items','immutable','deprecated','options','inputs'].includes(key)&&value[key]!=null&&typeof value[key]!=='string')throw Error(`${key} must be text.`);
 if(value.derived_by&&(typeof value.derived_by!=='string'||!value.derived_by.startsWith('http:')||value.derived_by==='http:'))throw Error('Derivations must use a hub HTTP provider.');
 if(value.derived_by&&value.required)throw Error('A derived property cannot be required.');
 if(value.pattern)new RegExp(`^(?:${String(value.pattern)})$`);
 if(value.ref_table)qident(String(value.ref_table));
 if(value.options!=null){
  if(!Array.isArray(value.options)||value.options.length>1000)throw Error('Options must be a bounded list.');
  const names=new Set<string>();
  for(const option of value.options){
   if(!option||typeof option!=='object'||Array.isArray(option)||Object.keys(option).some(k=>!['v','d','sort','color'].includes(k))||typeof option.v!=='string'||!option.v||option.d!=null&&typeof option.d!=='string'||option.sort!=null&&(typeof option.sort!=='number'||!Number.isFinite(option.sort))||names.has(option.v))throw Error('Options need distinct values and optional text descriptions.');
   if(option.color!=null&&!OPTION_COLORS.includes(option.color))throw Error(`Option colors must be one of: ${OPTION_COLORS.join(', ')}.`);
   names.add(option.v);
  }
 }
 if(value.inputs!=null&&(!Array.isArray(value.inputs)||value.inputs.some(v=>typeof v!=='string')))throw Error('Inputs must be a list of columns.');
}
async function guard(db:SqlDriver,table:string):Promise<void>{
 const fail=(col:string,rule:string,message:string):never=>{throw new ValidationError([{tbl:table,row_id:null,col,rule,message}]);};
 await prepareWriteStorage(db,table,fail);
 await assertCatalogCoverage(db,fail);
 for(const name of ['catalog_properties','catalog_rules','catalog_log']){
  const cols=await db.all(`PRAGMA main.table_info(${qident(name)})`);
  if(['id','created_at','updated_at','deleted_at'].some(key=>!cols.some(c=>c.name===key)))throw Error(`Sync the complete ${name} schema before editing the catalog.`);
 }
}
function revision(before:Row|undefined,expected:string|null):void {
 if((before?.updated_at??null)!==expected)throw Error('The catalog entry changed. Reload it before saving.');
}
async function persist(db:SqlDriver,table:string,id:string,before:Row|undefined,values:Row,patch:Row):Promise<Row>{
 const columns=new Set((await db.all(`PRAGMA main.table_info(${qident(table)})`)).map(r=>r.name));
 if(Object.keys(values).some(k=>!columns.has(k)))throw Error('Catalog schema is incomplete. Sync before editing.');
 const stamp=new Date(Math.max(Date.now(),typeof before?.updated_at==='string'?Date.parse(before.updated_at)+1:0)).toISOString();
 const encoded=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,Array.isArray(v)||v!==null&&typeof v==='object'?JSON.stringify(v):v])) as Record<string,Value>;
 if(before){await db.run(`UPDATE main.${qident(table)} SET ${Object.keys(encoded).map(k=>qident(k)+'=?').join(',')},updated_at=?,deleted_at=NULL WHERE id=?`,[...Object.values(encoded),stamp,id]);}
 else{const row={id,...encoded,created_at:stamp,updated_at:stamp};await db.run(`INSERT INTO main.${qident(table)}(${Object.keys(row).map(qident)}) VALUES (${Object.keys(row).map(()=>'?')})`,Object.values(row));}
 const after=(await db.all(`SELECT * FROM main.${qident(table)} WHERE id=?`,[id]))[0];
 if(!after||after.updated_at!==stamp||after.deleted_at!=null)throw Error('Catalog write could not be verified.');
 await initCore(db);
 const logId=String((await db.all('SELECT lower(hex(randomblob(16))) AS id'))[0].id);
 await db.run("INSERT INTO main.catalog_log(id,tbl,row_id,action,payload,created_at,updated_at) VALUES (?,?,?,'set',?,?,?)",[logId,table,id,JSON.stringify(patch),stamp,stamp]);
 for(const [tbl,rowId]of [[table,id],['catalog_log',logId]])await db.run('INSERT OR REPLACE INTO _core_pending(tbl,row_id,updated_at) VALUES (?,?,?)',[tbl,rowId,stamp]);
 return after;
}
/** Catalog changes use their own logged transaction; ordinary record writers
 * remain unable to edit metadata. Existing records are not silently rewritten. */
export async function saveCatalogProperty(db:SqlDriver,value:CatalogPropertyEdit):Promise<Property>{
 const args=input(value,['table','column','fields','expectedUpdatedAt','addColumn']);
 if(typeof args.column!=='string'||['id','created_at','updated_at','hub_at','deleted_at'].includes(args.column))throw Error('Choose a user property.');
 qident(args.column);fields(args.fields,propertyFields);
 if(Object.hasOwn(args.fields,'options'))args.fields.options=optionColors(args.fields.options) as Row['options'];
 if(args.addColumn!==undefined&&typeof args.addColumn!=='boolean')throw Error('Invalid add-column request.');
 return db.transaction(async()=>{
  await guard(db,args.table);
  const matches=await db.all('SELECT * FROM main.catalog_properties WHERE tbl=? AND col=?',[args.table,args.column]);
  if(matches.length>1)throw Error('Property identity is ambiguous. Repair the catalog first.');
  const before=matches[0];revision(before,args.expectedUpdatedAt);
  const merged:Row=decodeProperty({...(!before?{type:'text'}:before),...args.fields,col:args.column});property(merged);
  const cols=await db.all(`PRAGMA main.table_info(${qident(args.table)})`);
  if(!cols.some(c=>c.name===args.column)){
   if(!args.addColumn||before)throw Error('The physical column is absent. Explicitly add it as a new property.');
   await initCore(db);
   const ddl=`ALTER TABLE ${qident(args.table)} ADD COLUMN ${qident(args.column)} ${storage[String(merged.type)]}`;
   await db.run(ddl);await db.run('INSERT INTO _schema_log(ddl) VALUES (?)',[ddl]);
  }
  if(merged.options_sql)await db.all(`SELECT * FROM (${String(merged.options_sql)}) LIMIT 0`);
  if(typeof merged.default_value==='string'&&merged.default_value.startsWith('sql:'))await db.all(`SELECT (${merged.default_value.slice(4)}) LIMIT 0`);
  const id=before?String(before.id):`${args.table}.${args.column}`;
  const values={tbl:args.table,col:args.column,...(!before?{type:'text'}:{}),...args.fields};
  return decodeProperty(await persist(db,'catalog_properties',id,before,values,values));
 });
}
export async function saveCatalogRule(db:SqlDriver,value:CatalogRuleEdit):Promise<Row>{
 const args=input(value,['table','id','fields','expectedUpdatedAt']);
 if(typeof args.id!=='string'||!args.id.trim()||args.id.length>200)throw Error('Choose a rule ID.');
 fields(args.fields,ruleFields);
 return db.transaction(async()=>{
  await guard(db,args.table);
  const before=(await db.all('SELECT * FROM main.catalog_rules WHERE id=?',[args.id]))[0];
  revision(before,args.expectedUpdatedAt);
  if(before&&before.tbl!==args.table)throw Error('The rule belongs to another table.');
  const merged:Row={scope:'table',enforce:0,...before,...args.fields};
  if(!['doctrine','audit','invariant'].includes(String(merged.kind))||!['table','estate'].includes(String(merged.scope)))throw Error('Choose a supported rule kind and scope.');
  if(merged.enforce!==0&&merged.enforce!==1)throw Error('Enforcement must be 0 or 1.');
  if(merged.scope==='estate'&&merged.enforce)throw Error('Estate rules cannot be enforced on record writes.');
  for(const key of ruleFields)if(key!=='enforce'&&merged[key]!=null&&typeof merged[key]!=='string')throw Error(`${key} must be text.`);
  if(merged.kind==='invariant'&&!merged.sql)throw Error('An invariant needs a SELECT query.');
  if(merged.col&&!(await db.all(`PRAGMA main.table_info(${qident(args.table)})`)).some(r=>r.name===merged.col))throw Error('Rule property is absent from the table.');
  if(merged.sql){
   if(merged.enforce&&!supportedRuleSql(merged.sql))throw Error('Enforced rules require portable deterministic SELECT SQL.');
   if(!/^\s*SELECT\b/i.test(String(merged.sql)))throw Error('Rule SQL must be a SELECT.');
   await db.all(`WITH changed AS (SELECT * FROM main.${qident(args.table)} WHERE 0), before AS (SELECT * FROM main.${qident(args.table)} WHERE 0), now AS (SELECT '2000-01-01T00:00:00.000Z' AS ts) SELECT * FROM (${String(merged.sql)}) LIMIT 0`);
  }
  const values={tbl:args.table,...(!before?{scope:'table',enforce:0}:{}),...args.fields};
  return persist(db,'catalog_rules',args.id,before,values,values);
 });
}
