import type { Hub, SqlDriver } from './driver.ts';
import type { ResolveDerivedArgs, ResolveDerivedResult } from './contract.generated.ts';
import { readCatalog } from './catalog.ts';
import { readRemoteRow } from './remote.ts';
import { qident, validEditTimestamp } from './validate.ts';

type Args = Omit<ResolveDerivedArgs, 'endpoint'>;
const changed = () => new Error('Record or derivation changed; sync and reopen it before resolving.');

/** No replica writes and no transaction held across HTTP. The existing remote
 * read validates main-schema hub binding and full row shape before authorization.
 * The distinct server route enforces the displayed revision inside its guarded
 * derivation snapshot, including provider-time races. Hosts sync for readback. */
export async function resolveDerived(db: SqlDriver, hub: Hub, args: Args): Promise<ResolveDerivedResult> {
  if (!args || Object.keys(args).some(key => !['table','id','column','expectedUpdatedAt'].includes(key))
    || !['table','id','column'].every(key => typeof args[key as keyof Args] === 'string' && args[key as keyof Args].length > 0)
    || !validEditTimestamp(args.expectedUpdatedAt)) throw new Error('Invalid Resolve request');
  const { table, id, column, expectedUpdatedAt } = args;
  const endpoint = hub.endpoint;
  const snapshot = () => db.transaction(async () => {
    const catalog = await readCatalog(db);
    const property = catalog.properties.find(p => p.tbl === table && p.col === column);
    if (!property?.derived_by?.startsWith('http:') || property.deprecated) throw new Error('Property has no available hub derivation');
    const rows = await db.all(`SELECT id,updated_at,deleted_at FROM main.${qident(table)} WHERE id=?`, [id]);
    if (rows.length !== 1 || rows[0].id !== id || rows[0].updated_at !== expectedUpdatedAt || rows[0].deleted_at !== null) throw changed();
    const bindings: unknown[] = [];
    const tables = await db.all("SELECT name FROM main.sqlite_master WHERE type='table'");
    for (const [name,key] of [['_core_state','hub'],['_sync_state','hub_url']]) {
      if (tables.some(t => t.name === name)) bindings.push(...(await db.all(`SELECT value FROM main.${qident(name)} WHERE key=?`,[key])).map(r=>r.value));
    }
    if (hub.endpoint !== endpoint || !bindings.length || bindings.some(value=>value !== endpoint)) throw new Error('Replica is not bound to this hub');
    return JSON.stringify(property);
  });
  const before = await snapshot();
  const remote = await readRemoteRow(db,hub,{table,id});
  if (!remote.row || remote.row.deleted || remote.row.record.id !== id || remote.row.record.updated_at !== expectedUpdatedAt) throw changed();
  if (await snapshot() !== before) throw changed();
  const {data} = await hub.post('/v1/derive/resolve',{table,ids:[id],col:column,expectedUpdatedAt});
  if (await snapshot() !== before) throw changed();
  const result = data as ResolveDerivedResult;
  if (!result || !Number.isInteger(result.derived) || result.derived < 0 || result.derived > 1
    || !Array.isArray(result.failed) || result.failed.length > 1024
    || result.failed.some(f => !f || f.id !== id || typeof f.col !== 'string' || !f.col
      || typeof f.error !== 'string' || f.error.length > 4096
      || (f.status !== undefined && (!Number.isInteger(f.status) || f.status < 100 || f.status > 599))
      || (f.retry_after !== undefined && (!Number.isInteger(f.retry_after) || f.retry_after < 0)))) {
    throw new Error('Invalid derivation response; sync before retrying');
  }
  return result;
}
