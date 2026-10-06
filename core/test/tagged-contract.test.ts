import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateContract } from '../../scripts/generate-core-contract.ts';

const fixture = () => ({ $defs: {
  Empty: { type: 'object', properties: { kind: { type: 'string', enum: ['empty'] } }, required: ['kind'] },
  Text: { type: 'object', properties: { kind: { type: 'string', enum: ['text'] }, value: { type: 'string' } }, required: ['kind', 'value'] },
  Cell: { oneOf: [{ $ref: '#/$defs/Empty' }, { $ref: '#/$defs/Text' }] },
}, operations: {} });

test('named tagged unions preserve discriminant narrowing and reject mixed payloads in TypeScript', async () => {
  const output=generateContract(fixture());
  const dir=await mkdtemp(join(tmpdir(),'life-contract-union-'));
  try {
    await writeFile(join(dir,'types.ts'),output.typescript+`
const valid: Cell = {kind:'text',value:''};
const empty: Cell = {kind:'empty'};
// @ts-expect-error a text payload is required
const missing: Cell = {kind:'text'};
// @ts-expect-error an empty variant cannot carry text
const mixed: Cell = {kind:'empty',value:'hidden'};
function read(value: Cell): string { return value.kind==='text'?value.value:'empty'; }
`);
    const child=Bun.spawn([resolve(import.meta.dir,'../node_modules/.bin/tsc'),'--noEmit','--strict','--skipLibCheck',join(dir,'types.ts')],{stdout:'pipe',stderr:'pipe'});
    const result=await child.exited;
    expect({code:result,stdout:await new Response(child.stdout).text(),stderr:await new Response(child.stderr).text()}).toEqual({code:0,stdout:'',stderr:''});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test.each(['repeated','optional','missing','inline','nonobject'])('ambiguous tagged union %s fails generation',kind=>{
  const contract:any=fixture();
  if(kind==='repeated')contract.$defs.Text.properties.kind.enum=['empty'];
  if(kind==='optional')contract.$defs.Text.required=['value'];
  if(kind==='missing')delete contract.$defs.Text.properties.kind;
  if(kind==='inline')contract.$defs.Cell.oneOf[0]=contract.$defs.Empty;
  if(kind==='nonobject')contract.$defs.Text.type='string';
  expect(()=>generateContract(contract)).toThrow(/unsupported schema/);
});

test.skipIf(!Bun.which('swiftc'))('Swift tagged codecs reject absent/unknown tags and mismatched encoded variants',async()=>{
  const output=generateContract(fixture());
  const dir=await mkdtemp(join(tmpdir(),'life-contract-swift-'));
  try {
    await writeFile(join(dir,'Contract.swift'),output.swift);
    await writeFile(join(dir,'main.swift'),`
import Foundation
let decoder=JSONDecoder(), encoder=JSONEncoder()
for json in [#"{"kind":"empty"}"#, #"{"kind":"text","value":""}"#] {
  let data=Data(json.utf8)
  let value=try decoder.decode(CoreCell.self,from:data)
  let roundtrip=try encoder.encode(value)
  let decoded=try decoder.decode(CoreCell.self,from:roundtrip)
  precondition(decoded==value)
}
for json in [#"{}"#, #"{"kind":"unknown"}"#, #"{"kind":"text"}"#, #"{"kind":false}"#] {
  precondition((try? decoder.decode(CoreCell.self,from:Data(json.utf8))) == nil)
}
precondition((try? encoder.encode(CoreCell.text(CoreText(kind:"empty",value:"hidden")))) == nil)
print("tagged codecs pass")
`);
    const compile=Bun.spawn(['swiftc','-module-cache-path',join(dir,'cache'),join(dir,'Contract.swift'),join(dir,'main.swift'),'-o',join(dir,'check')],{stdout:'pipe',stderr:'pipe'});
    const code=await compile.exited,err=await new Response(compile.stderr).text();
    expect({code,err}).toEqual({code:0,err:''});
    const run=Bun.spawn([join(dir,'check')],{stdout:'pipe',stderr:'pipe'});
    expect(await run.exited).toBe(0);expect((await new Response(run.stdout).text()).trim()).toBe('tagged codecs pass');
  } finally { await rm(dir,{recursive:true,force:true}); }
},60_000);
