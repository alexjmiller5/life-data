import type {CaptureReceipt} from './contract.generated.ts';
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Hosts own HTTP and credentials. Acceptance is never a committed save. */
export function validateCaptureReceipt(value:unknown,requestId:string):CaptureReceipt {
 if(!object(value)||value.request_id!==requestId||!['received','processing','saved','needs_review','failed','uncertain'].includes(value.state as string))throw Error('invalid capture receipt');
 const item=value.item;
 if(value.state==='saved'){
  if(!object(item)||typeof item.kind!=='string'||!/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(item.kind)
   ||typeof item.id!=='string'||!item.id.length||item.id.length>4096)throw Error('invalid saved identity');
  return {request_id:requestId,state:'saved',item:{kind:item.kind,id:item.id}};
 }
 return {request_id:requestId,state:value.state as CaptureReceipt['state']};
}

export function supportsCapture(capabilities:unknown,adapter:string,operation:'read'|'submit'):boolean {
 if(!object(capabilities)||!object(capabilities.captures))return false;
 const capture=capabilities.captures;
 return capture.protocol==='receipt-v1'&&Array.isArray(capture.adapters)
  &&capture.adapters.some(entry=>object(entry)&&entry.id===adapter&&entry[operation]===true);
}
