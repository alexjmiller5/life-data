import {hashToken,validLabel} from './auth.js';

export const validProfileId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);

// Installation-owned read profiles. No user schema or application grants ship
// in source. An unavailable or invalid profile cannot select legacy enrollment.
export async function enrollmentProfile(env,id) {
  if (!validProfileId(id) || typeof env.ENROLLMENT_PROFILES !== 'string'
    || env.ENROLLMENT_PROFILES.length > 65536) return null;
  let profiles;
  try {profiles=JSON.parse(env.ENROLLMENT_PROFILES);} catch {return null;}
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || !Object.hasOwn(profiles,id)) return null;
  const p=profiles[id];
  if (!p || !validLabel(p.label) || !Array.isArray(p.scopes) || !p.scopes.length || p.scopes.length > 64
    || Object.keys(p).some(k=>!['label','scopes'].includes(k)) || new Set(p.scopes).size !== p.scopes.length) return null;
  const tables=new Set();
  for (const scope of p.scopes) {
    if (typeof scope !== 'string') return null;
    const parts=/^tables:read:([A-Za-z][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)$/.exec(scope);
    if (!parts || /^(?:sqlite_|catalog_)/i.test(parts[1]) || /^(?:history|provenance|purges)$/i.test(parts[1])) return null;
    tables.add(parts[1]);
  }
  if ([...tables].some(table=>!p.scopes.includes(`tables:read:${table}:id`))) return null;
  const label=p.label.trim(),scopes=[...p.scopes].sort();
  return {id,label,scopes,revision:await hashToken(JSON.stringify([id,label,scopes]))};
}
