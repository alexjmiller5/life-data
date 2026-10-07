import type {ConsumerConfig} from './contract.generated.ts';

/** Canonical profile configuration. Installation-owned bindings are opaque to core. */
export function canonicalConsumerConfig(value: unknown): ConsumerConfig {
  const object=(v:unknown): v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
  if (!object(value) || value.version!==1 || typeof value.namespace!=='string'
    || !/^[a-z][a-z0-9.-]{0,127}$/.test(value.namespace) || !object(value.bindings)
    || Object.keys(value).some(k=>!['version','namespace','bindings'].includes(k))) throw Error('invalid consumer config');
  // Explicit depth and byte limits also bound canonicalization work for untrusted replies.
  function canonical(v:unknown,depth=0):unknown {
    if (depth>16) throw Error('invalid consumer config');
    if (v===null || typeof v==='string' || typeof v==='boolean') return v;
    if (typeof v==='number' && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(x=>canonical(x,depth+1));
    if (object(v)) return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k],depth+1)]));
    throw Error('invalid consumer config');
  }
  const result=canonical(value) as ConsumerConfig;
  const bytes=[...JSON.stringify(result)].reduce((n,c)=>n+(c.codePointAt(0)!>0xffff?4:c.charCodeAt(0)>0x7ff?3:c.charCodeAt(0)>0x7f?2:1),0);
  if (bytes>16384) throw Error('invalid consumer config');
  return result;
}
