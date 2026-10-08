import {hashToken,validLabel} from './auth.js';
import {canonicalConsumerConfig} from '../../core/src/consumer-config.ts';
import {validEnrollmentScopes} from '../../core/src/enrollment-scopes.ts';
import {creationPolicies,creationGrant} from './creation.js';

export const validProfileId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);

const MAX_PROFILES_TEXT=65536;
// Cloudflare caps one secret at 5.1 kB, so a large profile set is stored as
// `gzip:<base64>`. Decompression stops at the same bound as plain JSON.
async function profilesText(value) {
  if (typeof value !== 'string' || !value.startsWith('gzip:')) return value;
  const bytes=Uint8Array.from(atob(value.slice(5)),c=>c.charCodeAt(0));
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const decoder=new TextDecoder('utf-8',{fatal:true});let text='';
  for (;;) {
    const {done,value:chunk}=await reader.read();if(done)break;
    text+=decoder.decode(chunk,{stream:true});
    if (text.length>MAX_PROFILES_TEXT) {await reader.cancel();return null;}
  }
  return text+decoder.decode();
}

// Installation-owned column profiles. No user schema or application grants ship
// in source. An unavailable or invalid profile cannot select legacy enrollment.
export async function enrollmentProfile(env,id) {
  if (!validProfileId(id)) return null;
  let text,profiles;
  try {text=await profilesText(env.ENROLLMENT_PROFILES);} catch {return null;}
  if (typeof text !== 'string' || text.length > MAX_PROFILES_TEXT) return null;
  try {profiles=JSON.parse(text);} catch {return null;}
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || !Object.hasOwn(profiles,id)) return null;
  const p=profiles[id];
  if (!p || !validLabel(p.label) || !validEnrollmentScopes(p.scopes)
    || Object.keys(p).some(k=>!['label','scopes','config'].includes(k))) return null;
  const label=p.label.trim(),scopes=[...p.scopes].sort();
  // A creation grant must name a current policy revision, as token creation requires.
  if (scopes.some(s=>s.startsWith('rows:create:'))) {
    const current=new Set((await creationPolicies(env)).map(creationGrant));
    if (scopes.some(s=>s.startsWith('rows:create:') && !current.has(s))) return null;
  }
  let config;
  if (Object.hasOwn(p,'config')) {
    try {config=canonicalConsumerConfig(p.config);} catch {return null;}
  }
  return {id,label,scopes,...(config === undefined ? {} : {config}),
    revision:await hashToken(JSON.stringify(config === undefined ? [id,label,scopes] : [id,label,scopes,config]))};
}
