import type { SqlDriver, Hub } from './driver.ts';
import { qident, validEditTimestamp, type Row } from './validate.ts';
export type SyncOptions = { maxRows?: number; tables?: Record<string, boolean>; now?: () => Date; maxClockSkewMs?: number };
export type SyncResult = { pulled: number; pushed: number; skipped: string[]; rejected: Row[] };

export async function initCore(db: SqlDriver): Promise<void> {
  await db.run("CREATE TABLE IF NOT EXISTS _schema_log (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ddl TEXT NOT NULL)");
  await db.run('CREATE TABLE IF NOT EXISTS _sync_state (key TEXT PRIMARY KEY, value TEXT)');
  await db.run('CREATE TABLE IF NOT EXISTS _core_state (key TEXT PRIMARY KEY, value TEXT)');
  await db.run("CREATE TABLE IF NOT EXISTS _core_sync (tbl TEXT PRIMARY KEY, pull TEXT NOT NULL DEFAULT '', push TEXT NOT NULL DEFAULT '')");
  await db.run('CREATE TABLE IF NOT EXISTS _core_rejected (tbl TEXT, row_id TEXT, row TEXT NOT NULL, errors TEXT NOT NULL, PRIMARY KEY(tbl,row_id))');
}

const active = new WeakSet<SqlDriver>();
export async function sync(db: SqlDriver, hub: Hub, options: SyncOptions = {}): Promise<SyncResult> {
  if(active.has(db)) throw new Error('sync already in progress');
  active.add(db);
  try { return await syncLocked(db,hub,options); } finally { active.delete(db); }
}

async function syncLocked(db: SqlDriver, hub: Hub, options: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, skipped: [], rejected: [] };
  await initCore(db);
  const endpoint=(await db.all("SELECT value FROM _core_state WHERE key='hub'"))[0]?.value;
  const cliState=(await db.all("SELECT value FROM _sync_state WHERE key='hub_url'"))[0]?.value;
  if ([endpoint,cliState].some(value=>value && value!==hub.endpoint)) throw new Error('hub changed; use a fresh replica');
  const now=options.now ?? (()=>new Date());
  // Observe rollback even when the first network request fails. Check again
  // under the snapshot transaction in case the clock changes during I/O.
  await db.run("UPDATE _core_sync SET push='' WHERE push > ?",[now().toISOString()]);
  let clockSkew: number | null=null;
  const post = async (route: string, body: Row = {}) => {
    if(route.endsWith('/push') && (clockSkew===null || clockSkew > (options.maxClockSkewMs ?? 300_000))) throw new Error('device clock cannot be verified against hub; check date and time');
    const started=now().getTime();
    const reply=await hub.post(route,body);
    const ended=now().getTime(), server=Date.parse(reply.date??'');
    // HTTP dates have one-second precision; request duration bounds transit delay.
    if(Number.isFinite(server)) clockSkew=Math.max(0,server-ended,started-server-1000);
    return reply.data as any;
  };
  const local = await db.all('SELECT applied_at,ddl FROM _schema_log ORDER BY applied_at,id');
  const known = new Set(local.map(r=>r.ddl));
  const {entries} = await post('/v1/schema/pull');
  if (!Array.isArray(entries)) throw new Error('invalid schema response');
  // Pin both clients before importing any data, including on a partial round.
  // Binding an unbound CLI must not legitimize its unknown global cursors.
  await db.transaction(async()=>{
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('hub',?)",[hub.endpoint]);
    if(!cliState) {
      await db.run("INSERT OR REPLACE INTO _sync_state(key,value) VALUES ('hub_url',?),('checkpoint_version','')",[hub.endpoint]);
    }
  });
  const remoteKnown = new Set(entries.map(e=>e.ddl));
  const unsent = local.filter(e=>!remoteKnown.has(e.ddl));
  if (unsent.length) await post('/v1/schema/push',{entries:unsent});
  for (const entry of entries) {
    if (known.has(entry.ddl)) continue;
    await db.transaction(async () => {
      try { await db.run(entry.ddl); }
      catch (error) {
        const message=String(error).toLowerCase();
        if (!['already exists','duplicate column','no such column'].some(s=>message.includes(s)) && !(message.includes('no such table')&&/^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i.test(entry.ddl))) throw error;
      }
      await db.run('INSERT INTO _schema_log(applied_at,ddl) VALUES (?,?)',[entry.applied_at,entry.ddl]);
    });
    known.add(entry.ddl);
  }
  const allTables=(await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(r=>String(r.name)).filter(t=>!t.startsWith('_')&&!t.startsWith('sqlite_')).sort((a,b)=>Number(!a.startsWith('catalog_'))-Number(!b.startsWith('catalog_'))||a.localeCompare(b));
  const {tables:counts} = await post('/v1/stats');
  const tables=allTables.filter(t=>t.startsWith('catalog_') || (options.tables?.[t] ?? (Number.isFinite(counts?.[t]) && counts[t] <= (options.maxRows ?? 50_000))));
  tables.sort((a,b)=>Number(a==='history')-Number(b==='history'));
  result.skipped=allTables.filter(t=>!tables.includes(t));
  const marks=await post('/v1/cursor',{tables}); // BEFORE pull; remote writes after this land next round.
  const validMark=(value:unknown)=>value===''||validEditTimestamp(value);
  if(!marks || !validMark(marks.max_hub_at) || !marks.tables || tables.some(t=>!validMark(marks.tables[t]))) throw new Error('invalid cursor response');
  const states=new Map((await db.all('SELECT * FROM _core_sync')).map(r=>[String(r.tbl),r]));
  const columns=new Map<string,string[]>(), candidates=new Map<string,Row[]>();
  let checkpoint='';
  const pendingHistory:Row[]=[];
  await db.transaction(async()=>{
    checkpoint=(options.now?.() ?? new Date()).toISOString();
    // Persist recovery even if this round fails, rejects, or skips a table.
    await db.run("UPDATE _core_sync SET push='' WHERE push > ?",[checkpoint]);
    for(const state of states.values()) if(String(state.push)>checkpoint) state.push='';
    for(const table of tables) {
      columns.set(table,(await db.all(`PRAGMA table_info(${qident(table)})`)).map(r=>String(r.name)));
      const push=String(states.get(table)?.push??'');
      const since=endpoint && push<=checkpoint ? push : '';
      const mine=await db.all(`SELECT * FROM ${qident(table)} WHERE updated_at >= ?`,[since]);
      candidates.set(table,mine);
      if(allTables.includes('history') && table!=='history' && mine.length) pendingHistory.push(...await db.all('SELECT * FROM history WHERE tbl=? AND updated_at>=? AND row_id IN (SELECT value FROM json_each(?))',[table,since,JSON.stringify(mine.map(r=>r.id))]));
    }
  });
  const withheld=new Set<unknown>();
  for (const table of tables) {
    const cols=columns.get(table)!;
    const since=endpoint ? String(states.get(table)?.pull??'') : '';
    let after: string | undefined;
    do {
      const page=await post('/v1/rows/pull',{table,columns:cols,since,limit:200,...(after ? {after} : {})});
      if (!Array.isArray(page.rows)) throw new Error('invalid pull response');
      if(page.next_cursor!=null && (typeof page.next_cursor!=='string' || page.next_cursor<=(after??'') || !page.rows.length)) throw new Error('invalid pull cursor');
      if(page.rows.some((r:Row)=>!r||typeof r!=='object'||Array.isArray(r)
        ||Object.keys(r).length!==cols.length
        ||cols.some(c=>!Object.hasOwn(r,c)||(r[c]!==null&&typeof r[c]!=='string'&&!(typeof r[c]==='number'&&Number.isFinite(r[c]))))
        ||typeof r.id!=='string'||!validEditTimestamp(r.updated_at))) throw new Error('invalid pulled row');
      if (page.rows.length) result.pulled+=await db.run(upsertSql(table,cols),[JSON.stringify(page.rows)]);
      after=page.next_cursor;
    } while (after);
    if(table==='history') {
      const held=new Set((await db.all('SELECT tbl,row_id FROM _core_rejected')).map(r=>JSON.stringify([r.tbl,r.row_id])));
      for(const event of candidates.get(table)!) if(held.has(JSON.stringify([event.tbl,event.row_id]))) withheld.add(event.id);
    }
    const mine=candidates.get(table)!.filter(r=>table!=='history'||!withheld.has(r.id));
    const bad: Row[]=[];
    for(let i=0;i<mine.length;i+=200) {
      const rows=mine.slice(i,i+200);
      const ids=new Set(rows.map(r=>r.id));
      const history=pendingHistory.filter(e=>e.tbl===table&&ids.has(e.row_id));
      const out=await post('/v1/rows/push',{table,columns:cols,rows,...(history.length ? {history} : {})});
      if(!out||!Number.isInteger(out.upserted)||out.upserted<0||out.upserted>rows.length||!Array.isArray(out.rejected)||out.rejected.some((r:Row)=>!r||!ids.has(r.id))) throw new Error('invalid push response');
      const rejectedIds=new Set(out.rejected.map((r:Row)=>r.id));
      if(out.upserted+rejectedIds.size!==rows.length) throw new Error('invalid push response');
      result.pushed+=out.upserted;
      bad.push(...out.rejected);
      for(const event of history) if(rejectedIds.has(event.row_id)) withheld.add(event.id);
      // Persist each receipt before another request can fail. History fallback
      // consults this inbox even when its owning table is excluded next round.
      await db.transaction(async()=>{
        for(const row of rows) {
          const errors=out.rejected.filter((e:Row)=>e.id===row.id);
          if(errors.length) await db.run('INSERT OR REPLACE INTO _core_rejected(tbl,row_id,row,errors) VALUES (?,?,?,?)',[table,String(row.id),JSON.stringify(row),JSON.stringify(errors)]);
          else await db.run('DELETE FROM _core_rejected WHERE tbl=? AND row_id=?',[table,String(row.id)]);
        }
      });
    }
    result.rejected.push(...bad.map(r=>({...r,table})));
  }
  // Cursor advancement commits only after every request succeeds.
  await db.transaction(async()=>{
    await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('hub',?)",[hub.endpoint]);
    for(const table of tables) {
      const rejected=result.rejected.some(r=>r.table===table)||(table==='history'&&withheld.size>0);
      await db.run('INSERT OR REPLACE INTO _core_sync(tbl,pull,push) VALUES (?,?,?)',[table,marks.tables?.[table]??marks.max_hub_at??'',rejected ? String(states.get(table)?.push??'') : checkpoint]);
    }
    if(!result.rejected.length) await db.run("INSERT OR REPLACE INTO _core_state(key,value) VALUES ('last_sync',?)",[checkpoint]);
  });
  return result;
}

export function upsertSql(table: string, columns: string[]): string {
  const t=qident(table);
  return `INSERT INTO ${t} (${columns.map(qident).join(',')}) SELECT ${columns.map(c=>`json_extract(value,'$.${qident(c).slice(1,-1)}')`).join(',')} FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET ${columns.filter(c=>c!=='id').map(c=>`${qident(c)}=excluded.${qident(c)}`).join(',')} WHERE excluded.updated_at > ${t}.updated_at`;
}
