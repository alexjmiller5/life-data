import {expect,test} from 'bun:test';
import {validateCaptureReceipt} from '../src/capture.ts';
const id='11111111-1111-4111-8111-111111111111';
test('capture policy cannot equate acceptance or malformed saved receipts with committed media',()=>{
 expect(validateCaptureReceipt({request_id:id,state:'received'},id)).toEqual({request_id:id,state:'received'});
 expect(validateCaptureReceipt({request_id:id,state:'saved',item:{kind:'article',id:'item-1'}},id)).toEqual({request_id:id,state:'saved',item:{kind:'article',id:'item-1'}});
 for(const value of [{request_id:id,state:'saved'},{request_id:'other',state:'saved',item:{kind:'article',id:'item-1'}},{request_id:id,state:'accepted'},{request_id:id,state:'saved',item:{kind:'article',id:''}}])expect(()=>validateCaptureReceipt(value,id)).toThrow();
});

test('capture capability requires the deployed protocol and explicit adapter operation',async()=>{
 const {supportsCapture}=await import('../src/capture.ts');
 expect(supportsCapture({captures:{protocol:'receipt-v1',adapters:[{id:'media',read:true,submit:false}]}},'media','read')).toBe(true);
 for(const caps of [undefined,{}, {captures:{protocol:'receipt-v2',adapters:[{id:'media',read:true}]}},{captures:{protocol:'receipt-v1',adapters:[{id:'other',read:true}]}}])expect(supportsCapture(caps,'media','read')).toBe(false);
 expect(supportsCapture({captures:{protocol:'receipt-v1',adapters:[{id:'media',read:true,submit:false}]}},'media','submit')).toBe(false);
});
