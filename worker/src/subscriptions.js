import { checkedReads, readGuards } from './write.js';
import { scopedTable } from './scopes.js';
import { subscriptionTriggers } from './subscription-triggers.js';

const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const schema = [
  `CREATE TABLE IF NOT EXISTS _change_subscriptions (
    id TEXT PRIMARY KEY,label TEXT NOT NULL,sources_json TEXT NOT NULL,trigger_sources_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused','retired')),created_at TEXT NOT NULL DEFAULT (${now}),
    last_seq INTEGER NOT NULL DEFAULT 0,acked_seq INTEGER NOT NULL DEFAULT 0,
    pending_delivery_id TEXT,pending_through_seq INTEGER,last_acked_delivery_id TEXT,
    pending_event_count INTEGER NOT NULL DEFAULT 0,pending_byte_count INTEGER NOT NULL DEFAULT 0,
    max_pending_events INTEGER NOT NULL,max_pending_bytes INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS _change_events (
    subscription_id TEXT NOT NULL,seq INTEGER NOT NULL,event_id TEXT NOT NULL,recorded_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,accounted_bytes INTEGER NOT NULL,
    PRIMARY KEY(subscription_id,seq),UNIQUE(subscription_id,event_id)
  )`,
];
const ready=new WeakMap();
export async function ensureSubscriptions(db) {
  if (!ready.has(db)) ready.set(db,db.batch(schema.map(sql=>db.prepare(sql))).catch(error=>{ready.delete(db);throw error;}));
  await ready.get(db);
}

export async function createSubscription(db,input) {
  if (!input || input.start!=='now' || typeof input.label!=='string' || !input.label.trim()
    || input.label.length>100 || /[\x00-\x1f\x7f]/.test(input.label)
    || !Array.isArray(input.sources) || !input.sources.length || input.sources.length>32) throw new Error('invalid subscription');
  const maxEvents=input.max_pending_events ?? 100_000,maxBytes=input.max_pending_bytes ?? 268_435_456;
  if (!Number.isSafeInteger(maxEvents) || maxEvents<1 || maxEvents>1_000_000
    || !Number.isSafeInteger(maxBytes) || maxBytes<4096 || maxBytes>1_073_741_824) throw new Error('invalid subscription capacity');
  await ensureSubscriptions(db);
  const view=checkedReads(db),sources=[],triggerSources=[],seen=new Set();
  for(const source of input.sources) {
    if (!source || seen.has(source.table) || !Array.isArray(source.columns) || !source.columns.length
      || source.columns.length>16 || new Set(source.columns).size!==source.columns.length) throw new Error('invalid subscription source');
    const columns=await scopedTable(view,source.table);
    if (!columns.some(c=>c.name==='deleted_at')) throw new Error('invalid subscription source');
    for(const column of source.columns) {
      const info=columns.find(c=>c.name===column);
      if (!info || ['id','created_at','updated_at','deleted_at','hub_at'].includes(column)
        || !/CHAR|CLOB|TEXT/i.test(info.type)) throw new Error('invalid subscription column');
    }
    seen.add(source.table);
    sources.push({table:source.table,columns:[...source.columns]});
    triggerSources.push({...sources.at(-1),hasHubAt:columns.some(c=>c.name==='hub_at')});
  }
  const id=crypto.randomUUID();
  await db.batch([
    ...readGuards(db,view.reads),
    db.prepare("INSERT INTO _change_subscriptions(id,label,sources_json,trigger_sources_json,state,max_pending_events,max_pending_bytes) VALUES (?,?,?,?,'active',?,?)")
      .bind(id,input.label.trim(),JSON.stringify(sources),JSON.stringify(triggerSources),maxEvents,maxBytes),
    ...subscriptionTriggers(id,triggerSources).map(t=>db.prepare(t.sql)),
  ]);
  const {created_at}=await db.prepare('SELECT created_at FROM _change_subscriptions WHERE id=?').bind(id).first();
  return {id,protocol:'durable-pull-v1',state:'active',created_at,sources,acked_seq:'0',max_pending_events:maxEvents,max_pending_bytes:maxBytes};
}

export async function applySubscriptionSchema(db,ddl) {
  const view=checkedReads(db);
  const exists=await view.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_change_subscriptions'").first();
  const active=exists ? (await view.prepare("SELECT id,trigger_sources_json FROM _change_subscriptions WHERE state IN ('active','paused') ORDER BY id").all()).results : [];
  const names=new Set(),expectedTriggers=[];
  if(exists) {names.add('_change_subscriptions');names.add('_change_events');}
  for(const sub of active) {
    const sources=JSON.parse(sub.trigger_sources_json);
    for(const source of sources) names.add(source.table);
    for(const trigger of subscriptionTriggers(sub.id,sources)) {names.add(trigger.name);expectedTriggers.push(trigger);}
  }
  const stable=checkedReads(db);
  if(names.size) {
    const {results:objects}=await stable.prepare('SELECT name,type,sql FROM sqlite_master WHERE name IN (SELECT value FROM json_each(?)) ORDER BY name')
      .bind(JSON.stringify([...names].sort())).all();
    if(objects.length!==names.size || expectedTriggers.some(t=>!objects.some(o=>o.name===t.name && o.type==='trigger' && o.sql===t.sql))) {
      throw Object.assign(new Error('subscription schema conflict'),{code:'subscription-schema-conflict'});
    }
  }
  try {
    await db.batch([...readGuards(db,view.reads),...readGuards(db,stable.reads),db.prepare(ddl),...readGuards(db,stable.reads)]);
  } catch(error) {
    if(String(error).includes('integer overflow')) throw Object.assign(new Error('subscription schema conflict'),{code:'subscription-schema-conflict'});
    throw error;
  }
}
