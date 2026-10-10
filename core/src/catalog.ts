import type { Catalog, CatalogRevision } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { qident, type Property, type Row } from './validate.ts';

export function decodeProperty(row: Row): Property {
  if(typeof row.col!=='string') throw new Error('catalog property has no column');
  const decoded={...row} as Property;
  for(const key of ['options','inputs'] as const) {
    const value=row[key];
    const parsed=typeof value==='string' ? JSON.parse(value) : value;
    if(parsed!=null&&!Array.isArray(parsed)) throw new Error(`invalid catalog ${key}`);
    Object.assign(decoded,{[key]:parsed??null});
  }
  return decoded;
}

/** tables limits the read to those tables' entries, properties and rules, for operations
 * that involve only them; the whole catalog is about a megabyte on a large estate. */
export async function readCatalog(db: SqlDriver, tables?: readonly string[]): Promise<Catalog> {
  const existing=new Set((await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>r.name));
  const scope=tables===undefined ? [] : [JSON.stringify([...new Set(tables)])];
  const read=(table:string,key:string)=>existing.has(table) ? db.all(`SELECT * FROM ${qident(table)} WHERE deleted_at IS NULL${scope.length?` AND ${key} IN (SELECT value FROM json_each(?))`:''} ORDER BY id`,scope) : Promise.resolve([]);
  return {tables:await read('catalog_tables','id'), properties:(await read('catalog_properties','tbl')).map(decodeProperty), rules:await read('catalog_rules','tbl')};
}

/** Changes whenever a catalog row is added, edited, retired, pulled or removed. Every soma
 * write moves updated_at (its timestamp trigger stamps raw edits too); the length of the whole
 * row also separates edits that keep it, such as two in one millisecond. Hosts compare it
 * before re-reading the whole catalog. */
export async function catalogRevision(db: SqlDriver): Promise<CatalogRevision> {
  const names=['catalog_tables','catalog_properties','catalog_rules'];
  const columns=new Map<string,string[]>();
  for(const r of await db.all(`SELECT m.name AS tbl,p.name AS col FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p
    WHERE m.type='table' AND m.name IN ('${names.join("','")}')`)) columns.set(String(r.tbl),[...columns.get(String(r.tbl))??[],String(r.col)]);
  const parts=names.map(table=>{
    const all=columns.get(table);
    if(!all)return "'-'";
    const row=`json_array(id,${all.includes('updated_at')?'updated_at':'NULL'},length(json_array(${all.map(qident).join(',')})))`;
    return `(SELECT ifnull(group_concat(r,''),'') FROM (SELECT ${row} AS r FROM ${qident(table)} ORDER BY id))`;
  });
  const [row]=await db.all(`SELECT ${parts.join("||'|'||")} AS rows`);
  return {revision:fingerprint(String(row!.rows))};
}

/** 64-bit FNV-1a style digest for cache keys; never a security boundary. */
export function fingerprint(text: string): string {
  let a=0x811c9dc5,b=0x01000193;
  for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,0x01000193)>>>0;b=Math.imul(b^c,0x5bd1e995)>>>0;}
  return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
}
