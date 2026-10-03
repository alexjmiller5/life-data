import type { Catalog } from './contract.generated.ts';
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

export async function readCatalog(db: SqlDriver): Promise<Catalog> {
  const existing=new Set((await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>r.name));
  const read=(table:string)=>existing.has(table) ? db.all(`SELECT * FROM ${qident(table)} WHERE deleted_at IS NULL ORDER BY id`) : Promise.resolve([]);
  return {tables:await read('catalog_tables'), properties:(await read('catalog_properties')).map(decodeProperty), rules:await read('catalog_rules')};
}
