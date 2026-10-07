import type {PushRegistrationCapability,PushAppProfile} from './contract.generated.ts';

const text=(v:unknown):v is string=>typeof v==='string' && v.length>0 && v.length<=128 && !/[\u0000-\u001f\u007f]/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v);
export function pushRegistrationCapability(value:unknown):PushRegistrationCapability|undefined {
  if(!object(value) || value.protocol!=='apns-registration-v1' || !text(value.deploymentIdentity)
    || !text(value.sessionBinding) || !Array.isArray(value.profiles) || value.profiles.length!==1
    || value.profiles.some(p=>!object(p)||!text(p.id)||!['ios','macos'].includes(p.platform as string)))return undefined;
  return {protocol:'apns-registration-v1',deploymentIdentity:value.deploymentIdentity,sessionBinding:value.sessionBinding,
    profiles:value.profiles.map(p=>({id:p.id,platform:p.platform}))};
}

export function pushEnrollmentProfiles(value:unknown):PushAppProfile[]|undefined {
  if(!Array.isArray(value)||value.length<1||value.length>16
    || value.some(p=>!object(p)||!text(p.id)||!['ios','macos'].includes(p.platform as string))
    || new Set(value.map(p=>p.id)).size!==value.length)return undefined;
  return value.map(p=>({id:p.id,platform:p.platform}));
}
