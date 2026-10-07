import type { EmptyArgs, MoveTablePinArgs, PinTableArgs, SidebarPin, SidebarPinList, UnpinTableArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { qident, validEditTimestamp, type Row } from './validate.ts';
import { ValidationError, writeRow } from './write.ts';
import storage from '../schema/sidebar-pins.json';

const normalizeDDL = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim();
const invalid = () => new Error('Invalid sidebar pin arguments.');
const conflict = () => new ValidationError([{tbl:storage.table.id,row_id:null,col:'updated_at',rule:'conflict',message:'Pins changed since they were selected; reload before retrying.'}]);

/** Copy flat arguments without invoking getters or retaining caller-owned objects. */
function fields(value: unknown, keys: string[]): Row {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) throw invalid();
  const result: Row = Object.create(null);
  for (const key of keys) {
    const field = descriptors[key];
    if (!field || !field.enumerable || !('value' in field)) throw invalid();
    result[key] = field.value;
  }
  return result;
}

/** Catalog keys use the core's ASCII identifier grammar; no host TextEncoder required. */
export function sidebarPinID(table: string): string {
  if (typeof table !== 'string') throw invalid();
  qident(table);
  return 'pin:v1:' + [...table].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !validEditTimestamp(value)) throw invalid();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^pin:v1:(?:[a-f0-9]{2})+$/.test(value)) throw invalid();
}

async function read(db: SqlDriver): Promise<SidebarPinList> {
  const schema = await db.all("SELECT name,sql FROM main.sqlite_master WHERE (type='table' AND name='sidebar_pins') OR (type='trigger' AND name='sidebar_pins_updated_at') ORDER BY type");
  if (!schema.length) return {pins:[],unavailable:'Sidebar pins need provisioning; sync their schema and catalog first.'};
  const catalog = await readCatalog(db);
  const table = catalog.tables.find(t => t.id === storage.table.id);
  const properties = catalog.properties.filter(p => p.tbl === storage.table.id);
  const matches = (actual: Row | undefined, expected: object) => !!actual && Object.entries(expected).every(([key,value]) => actual[key] === value);
  if (schema.length !== storage.ddl.length || schema.some((s,i) => normalizeDDL(s.sql) !== normalizeDDL(storage.ddl[i]))
    || !matches(table,storage.table) || properties.length !== storage.properties.length
    || storage.properties.some(({sort:_sort,...expected}) => !matches(properties.find(p => p.id === expected.id),expected))) {
    return {pins:[],unavailable:'Sidebar pin schema or catalog does not match sidebar-pins/v1; setup review is required.'};
  }
  const rows = await db.all('SELECT id,tbl,position,updated_at,deleted_at FROM main.sidebar_pins ORDER BY position,tbl COLLATE BINARY,id COLLATE BINARY');
  const pins: SidebarPin[] = [];
  for (const row of rows) {
    if (typeof row.tbl !== 'string' || row.id !== sidebarPinID(row.tbl)
      || !Number.isSafeInteger(row.position) || (row.position as number) < 0
      || typeof row.updated_at !== 'string' || !validEditTimestamp(row.updated_at)
      || (row.deleted_at !== null && (typeof row.deleted_at !== 'string' || !validEditTimestamp(row.deleted_at)))) {
      throw new Error('Stored sidebar pins are invalid; no pins were changed.');
    }
    const target = catalog.tables.find(t => t.id === row.tbl);
    pins.push({id:row.id as string,tbl:row.tbl,position:row.position as number,updated_at:row.updated_at,
      deleted_at:row.deleted_at as string|null,unavailable:target ? null : 'This table is unavailable in the current catalog.'});
  }
  return {pins,unavailable:null};
}

async function ready(db: SqlDriver): Promise<SidebarPinList> {
  const state = await read(db);
  if (state.unavailable) throw new Error(state.unavailable);
  return state;
}

function transactionDriver(db: SqlDriver): SqlDriver {
  return {all:db.all.bind(db),run:db.run.bind(db),transaction:body => body(),
    ...(db.readDependencies ? {readDependencies:db.readDependencies.bind(db)} : {})};
}

export async function listSidebarPins(db: SqlDriver, args: EmptyArgs): Promise<SidebarPinList> {
  fields(args,[]);
  return db.transaction(() => read(db));
}

export async function pinTable(db: SqlDriver, input: PinTableArgs, options: {origin?: string} = {}): Promise<SidebarPinList> {
  const args = fields(input,['table','expectedUpdatedAt']);
  const table = args.table;
  if (typeof table !== 'string') throw invalid();
  const pinID = sidebarPinID(table);
  const expected = args.expectedUpdatedAt;
  if (expected !== null) revision(expected);
  const origin = options.origin;
  return db.transaction(async () => {
    const state = await ready(db);
    const current = state.pins.find(p => p.id === pinID);
    if ((current?.updated_at ?? null) !== expected) throw conflict();
    const catalog = await readCatalog(db);
    if (!catalog.tables.some(t => t.id === table)) throw new Error('This table is unavailable in the current catalog.');
    if (current && !current.deleted_at) return state;
    const active = state.pins.filter(p => !p.deleted_at);
    const position = active.length ? Math.max(...active.map(p => p.position)) + 1 : 0;
    if (!Number.isSafeInteger(position)) throw new Error('Pin ordering is outside the supported range.');
    const tx = transactionDriver(db);
    if (current) await writeRow(tx,storage.table.id,{id:pinID,position,deleted_at:null},{origin,expectedUpdatedAt:current.updated_at});
    else await writeRow(tx,storage.table.id,{tbl:table,position},{origin,id:() => pinID});
    return read(db);
  });
}

export async function unpinTable(db: SqlDriver, input: UnpinTableArgs, options: {origin?: string} = {}): Promise<SidebarPinList> {
  const args=fields(input,['id','expectedUpdatedAt']); id(args.id); revision(args.expectedUpdatedAt);
  const pinID=args.id, expected=args.expectedUpdatedAt, origin=options.origin;
  return db.transaction(async()=>{
    const state=await ready(db);
    const current=state.pins.find(p=>p.id===pinID);
    if (!current || current.updated_at!==expected) throw conflict();
    if (current.deleted_at) return state;
    await writeRow(transactionDriver(db),storage.table.id,{id:pinID,deleted_at:true},{origin,expectedUpdatedAt:expected});
    return read(db);
  });
}

export async function moveTablePin(db: SqlDriver, input: MoveTablePinArgs, options: {origin?: string} = {}): Promise<SidebarPinList> {
  const args=fields(input,['id','direction','expected']); id(args.id);
  if (!['up','down'].includes(args.direction as string) || !Array.isArray(args.expected)) throw invalid();
  const expected=args.expected.map(value=>{
    const pair=fields(value,['id','updated_at']); id(pair.id); revision(pair.updated_at);
    return {id:pair.id,updated_at:pair.updated_at};
  });
  if (new Set(expected.map(p=>p.id)).size!==expected.length) throw invalid();
  const pinID=args.id, direction=args.direction, origin=options.origin;
  return db.transaction(async()=>{
    const state=await ready(db), active=state.pins.filter(p=>!p.deleted_at);
    if (expected.length!==active.length || active.some(p=>expected.find(e=>e.id===p.id)?.updated_at!==p.updated_at)) throw conflict();
    const index=active.findIndex(p=>p.id===pinID);
    if (index<0) throw conflict();
    const neighbor=index+(direction==='up'?-1:1);
    if (neighbor<0 || neighbor>=active.length) return state;
    const distinct=new Set(active.map(p=>p.position)).size===active.length;
    const ordered=[...active]; [ordered[index],ordered[neighbor]]=[ordered[neighbor],ordered[index]];
    const tx=transactionDriver(db);
    for (let i=0;i<ordered.length;i++) {
      const pin=ordered[i],position=distinct?active[i].position:i;
      if (pin.position!==position) await writeRow(tx,storage.table.id,{id:pin.id,position},{origin,expectedUpdatedAt:pin.updated_at});
    }
    return read(db);
  });
}
