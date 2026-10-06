import type { ApprovalResult, CellValue, PreviewResult, Proposal, SelectedInverseIntent,
  ApproveProposalArgs, CreateProposalArgs } from '../src/contract.generated.ts';

const integer: CellValue={type:'integer',value:'9223372036854775807'};
const empty: CellValue={type:'text',value:''};
const sqlNull: CellValue={type:'null'};
// @ts-expect-error integer cells cannot lose precision through a number
const lossy: CellValue={type:'integer',value:9223372036854775807};
// @ts-expect-error SQL NULL carries no invented value
const mixed: CellValue={type:'null',value:''};
const selection: SelectedInverseIntent={kind:'selected_inverse',eventIds:['event-a']};
const create: CreateProposalArgs={previewToken:'opaque',idempotencyKey:'request-a'};
const approve: ApproveProposalArgs={proposalId:'proposal-a',expectedVersion:'version-a',previewToken:'opaque',idempotencyKey:'request-b'};
// @ts-expect-error authority is derived by the service, not asserted in the request
const forged: ApproveProposalArgs={...approve,actor:{principalId:'principal-a',kind:'user'}};
const purged: ApprovalResult={kind:'purged'};
// @ts-expect-error redacted receipts cannot retain sensitive values
const leaked: ApprovalResult={kind:'purged',value:{target:{table:'items',rowId:'a'}}};
function result(value: ApprovalResult): string {
  if(value.kind==='success')return value.value.operationId;
  if(value.kind==='error')return value.code;
  if(value.kind==='transport_error')return value.code;
  return value.kind;
}
function preview(value: PreviewResult): string|null {
  return value.kind==='success'?value.value.previewToken:null;
}
function terminal(value: Proposal): boolean { return value.state!=='pending'; }
void [integer,empty,sqlNull,lossy,mixed,selection,create,forged,purged,leaked,result,preview,terminal];
