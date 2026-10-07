import {expect,test} from 'bun:test';
import vm from 'node:vm';
import {canonicalConsumerConfig} from '../src/consumer-config.ts';

test('canonical config is pure in native JavaScriptCore-shaped realm and enforces UTF-8 bounds',async()=>{
 // Evaluate the exported pure function with no TextEncoder/browser globals.
 const source=canonicalConsumerConfig.toString();
 const check=vm.runInNewContext(`(${source})`,{});
 expect(check({version:1,namespace:'example',bindings:{b:1,a:2}})).toEqual({version:1,namespace:'example',bindings:{a:2,b:1}});
 expect(()=>check({version:1,namespace:'example',bindings:{text:'é'.repeat(8192)}})).toThrow();
 expect(()=>canonicalConsumerConfig({version:1,namespace:'example',bindings:{text:Infinity}})).toThrow();
});
