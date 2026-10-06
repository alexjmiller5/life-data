// The exact protocol boundary is shared by routing, authentication and usage.
const operations = {
  '/v1/governance/history/events': {name:'historyEvents',read:true},
  '/v1/governance/preview': {name:'previewChanges',read:true,preview:true},
  '/v1/governance/proposals/create': {name:'createProposal'},
  '/v1/governance/proposals/list': {name:'listProposals',read:true},
  '/v1/governance/proposals/get': {name:'getProposal',read:true},
  '/v1/governance/proposals/edit': {name:'editProposal'},
  '/v1/governance/proposals/preview': {name:'previewProposal',read:true,preview:true},
  '/v1/governance/proposals/approve': {name:'approveProposal'},
  '/v1/governance/proposals/reject': {name:'rejectProposal'},
};

export function governanceOperation(request) {
  return request.method==='POST' ? operations[new URL(request.url).pathname] ?? null : null;
}

export function governanceFailure(operation,status,code='unavailable',headers={}) {
  const result=operation.read ? {kind:'unavailable'} : {kind:'error',code,resolution:'unresolved',conflicts:[]};
  return Response.json(result,{status,headers:{'Cache-Control':'no-store',...headers}});
}
