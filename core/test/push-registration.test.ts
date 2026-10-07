import {expect,test} from 'bun:test';
import {validateDeviceSession} from '../src/enrollment.ts';

const capability={protocol:'apns-registration-v1',deploymentIdentity:'deployment',sessionBinding:'opaque-session',profiles:[{id:'desktop',platform:'macos'}]};
const session=(push=capability)=>({name:'device:synthetic',scopes:['full'],capabilities:{row_api:'v1',schema:'full-ddl-v1',replica_sync:true,subscriptions:null,files:'opaque-key-v1',push_registration:push}});
test('validated session retains a detached push capability with opaque identity',()=>{
  const input=session();const result=validateDeviceSession(input) as any;
  expect(result.pushRegistration).toEqual(capability);
  input.capabilities.push_registration.sessionBinding='changed';
  expect(result.pushRegistration.sessionBinding).toBe('opaque-session');
});
test('malformed push capabilities never authorize registration',()=>{
  for(const invalid of [null,{}, {...capability,protocol:'future'},{...capability,sessionBinding:''},
    {...capability,profiles:[{id:'desktop',platform:'web'}]}, {...capability,profiles:[]}]){
    expect((validateDeviceSession(session(invalid as any)) as any).pushRegistration).toBeUndefined();
  }
});
test('public enrollment profiles are discoverable but never imply an authenticated push binding',()=>{
  const input={name:'device:synthetic',scopes:['full'],capabilities:{push_profiles:[{id:'desktop',platform:'macos'}]}};
  const result=validateDeviceSession(input) as any;
  expect(result.pushProfiles).toEqual([{id:'desktop',platform:'macos'}]);
  expect(result.pushRegistration).toBeUndefined();
  for(const profiles of [[],[{id:'desktop',platform:'web'}],[{id:'desktop',platform:'macos'},{id:'desktop',platform:'ios'}]]){
    expect((validateDeviceSession({...input,capabilities:{push_profiles:profiles}}) as any).pushProfiles).toBeUndefined();
  }
});
