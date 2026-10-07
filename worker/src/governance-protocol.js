// The exact protocol boundary is shared by routing, authentication and usage.
import {governanceOperations} from '../../core/src/governance-wire.ts';
import {changesetOperations} from './changeset-governance.js';
const operations={...Object.fromEntries(Object.entries(governanceOperations).map(([name,op])=>[op.route,{name,...op}])),...changesetOperations};

export function governanceOperation(request) {
  return request.method==='POST' ? operations[new URL(request.url).pathname] ?? null : null;
}

export function governanceFailure(operation,status,code='unavailable',headers={}) {
  const result=operation.read ? {kind:'unavailable'} : {kind:'error',code,resolution:'unresolved',conflicts:[]};
  return Response.json(result,{status,headers:{'Cache-Control':'no-store',...headers}});
}
