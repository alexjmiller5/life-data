import {hashToken,validLabel} from './auth.js';
import {validEnrollmentScopes} from '../../core/src/enrollment-scopes.ts';

export const validProfileId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id);

// Installation-owned column profiles. No user schema or application grants ship
// in source. An unavailable or invalid profile cannot select legacy enrollment.
export async function enrollmentProfile(env,id) {
  if (!validProfileId(id) || typeof env.ENROLLMENT_PROFILES !== 'string'
    || env.ENROLLMENT_PROFILES.length > 65536) return null;
  let profiles;
  try {profiles=JSON.parse(env.ENROLLMENT_PROFILES);} catch {return null;}
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)
    || !Object.hasOwn(profiles,id)) return null;
  const p=profiles[id];
  if (!p || !validLabel(p.label) || !validEnrollmentScopes(p.scopes)
    || Object.keys(p).some(k=>!['label','scopes'].includes(k))) return null;
  const label=p.label.trim(),scopes=[...p.scopes].sort();
  return {id,label,scopes,revision:await hashToken(JSON.stringify([id,label,scopes]))};
}
