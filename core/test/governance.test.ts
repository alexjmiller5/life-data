import { expect, test } from 'bun:test';
import * as core from '../src/index.ts';
import type { CellValue, HistoryEvent, Target } from '../src/contract.generated.ts';

const target:Target={table:'items',rowId:'a'};
const revision={updated_at:'2026-01-03T00:00:00.000Z',hub_at:null};
const text=(value:string):CellValue=>({type:'text',value});
const int=(value:string):CellValue=>({type:'integer',value});
const event=(id:string,column:string,before:CellValue|null,after:CellValue|null):HistoryEvent=>({
  id,operationId:null,target:{...target},column,before,after,
  occurredAt:'2026-01-01T00:00:00.000Z',actor:null,claimedOrigin:null,reversible:true,unavailableReason:null,
});
function fixture(){return {
  target:{...target},revision:{...revision},complete:true,
  current:{name:text('New'),qty:int('9')},
  events:[event('name-1','name',text('Old'),text('New')),event('qty-1','qty',int('3'),int('9'))],
};}
function plan(eventIds:readonly string[],evidence:ReturnType<typeof fixture>){
  expect(core.planSelectedInverse).toBeFunction();
  return core.planSelectedInverse({target,eventIds},evidence);
}
function frozen<T>(value:T):T {
  if(value && typeof value==='object'){for(const part of Object.values(value))frozen(part);Object.freeze(value);}
  return value;
}

test('selected name inverse preserves later quantity changes and frozen inputs',()=>{
  const evidence=frozen(fixture());
  const result=plan(['name-1'],evidence);
  expect(result).toEqual({changes:[{column:'name',before:text('New'),after:text('Old')}],selectedEventIds:['name-1'],conflicts:[]});
  expect(evidence.current).toEqual({name:text('New'),qty:int('9')});
});

test('contiguous selected changes reverse by trusted history order, not selection order or timestamps',()=>{
  const evidence=fixture();
  evidence.events=[event('first','name',text('Old'),text('Middle')),event('second','name',text('Middle'),text('New'))];
  evidence.events[0].occurredAt='2026-02-01T00:00:00.000Z';
  expect(plan(['second','first'],evidence)).toEqual({changes:[{column:'name',before:text('New'),after:text('Old')}],selectedEventIds:['first','second'],conflicts:[]});
});

test.each([false,true])('a later unselected same-column change conflicts, including a value cycle=%s',cycle=>{
  const evidence=fixture();
  evidence.events.push(event('later','name',text('New'),text('Later')));
  evidence.current.name=text('Later');
  if(cycle){evidence.events.push(event('cycle','name',text('Later'),text('New')));evidence.current.name=text('New');}
  const result=plan(['name-1'],evidence);
  expect(result.changes).toEqual([]);
  expect(result.conflicts).toEqual([expect.objectContaining({code:'later_column_change',column:'name',eventIds:cycle?['later','cycle']:['later']})]);
});

test('an unselected event between selected same-column changes is not overwritten',()=>{
  const evidence=fixture();
  evidence.events=[event('first','name',text('Old'),text('One')),event('middle','name',text('One'),text('Two')),event('last','name',text('Two'),text('New'))];
  expect(plan(['first','last'],evidence).conflicts).toEqual([expect.objectContaining({code:'later_column_change',eventIds:['middle']})]);
});

test('older unselected events before the selected suffix do not prevent its inverse',()=>{
  const evidence=fixture();
  evidence.events.unshift(event('old','name',text('Before'),text('Old')));
  expect(plan(['name-1'],evidence).changes).toEqual([{column:'name',before:text('New'),after:text('Old')}]);
});

test.each(['incomplete','missing','untyped','unreversible','chain','current','duplicate','wrong_target'])('unproven history fails closed: %s',kind=>{
  const evidence=fixture();
  if(kind==='incomplete')evidence.complete=false;
  if(kind==='missing')evidence.events.shift();
  if(kind==='untyped')evidence.events[0].before=null;
  if(kind==='unreversible')evidence.events[0].reversible=false;
  if(kind==='chain')evidence.events.push(event('broken','name',text('Disconnected'),text('New')));
  if(kind==='current')evidence.current.name=text('Unrecorded');
  if(kind==='duplicate')evidence.events.push({...evidence.events[0]});
  if(kind==='wrong_target')evidence.events[0].target.rowId='b';
  const result=plan(kind==='chain'?['name-1','broken']:['name-1'],evidence);
  expect(result.changes).toEqual([]);
  expect(result.conflicts[0].code).toBe('history_unavailable');
});

test.each([{ids:[]},{ids:['name-1','name-1']}])('invalid selections fail without partial work: %j',({ids})=>{
  expect(plan(ids,fixture())).toMatchObject({changes:[],conflicts:[{code:'validation_failed'}]});
});

test('one conflicting selected column prevents a partial multi-field inverse',()=>{
  const evidence=fixture();evidence.events.push(event('later','name',text('New'),text('Newest')));evidence.current.name=text('Newest');
  const result=plan(['qty-1','name-1'],evidence);
  expect(result.changes).toEqual([]);expect(result.conflicts).toHaveLength(1);
  expect(evidence.current.qty).toEqual(int('9'));
});

test('multiple nonconflicting selected columns return one complete set of field differences',()=>{
  expect(plan(['qty-1','name-1'],fixture())).toEqual({changes:[
    {column:'name',before:text('New'),after:text('Old')},{column:'qty',before:int('9'),after:int('3')},
  ],selectedEventIds:['name-1','qty-1'],conflicts:[]});
});

test.each([
  [{type:'null'},text('')],
  [text(''),{type:'null'}],
  [int('9223372036854775807'),int('-9223372036854775808')],
] as [CellValue,CellValue][])('typed inverse preserves exact old and current cells', (before,after)=>{
  const evidence=fixture();evidence.events=[event('typed','name',before,after)];evidence.current.name=after;
  expect(plan(['typed'],evidence).changes).toEqual([{column:'name',before:after,after:before}]);
});

test('matching textual renderings do not equate integer and text evidence',()=>{
  const evidence=fixture();evidence.events=[event('typed','name',text('Old'),int('1'))];evidence.current.name=text('1');
  expect(plan(['typed'],evidence).conflicts[0].code).toBe('history_unavailable');
});

test.each([int('9223372036854775808'),int('01'),{type:'real',value:Infinity},{type:'text',value:1},{type:'null',value:'hidden'}])('invalid typed history never becomes a patch: %j',value=>{
  const evidence=fixture();evidence.events[0].before=value as CellValue;
  expect(plan(['name-1'],evidence)).toMatchObject({changes:[],conflicts:[{code:'history_unavailable'}]});
});

test.each(['id','created_at','updated_at','hub_at','deleted_at'])('structural column %s cannot be reversed as an ordinary field',column=>{
  const evidence=fixture();evidence.events[0].column=column;
  expect(plan(['name-1'],evidence)).toMatchObject({changes:[],conflicts:[{code:'history_unavailable'}]});
});

test('selected cycles produce no difference and do not manufacture a timestamp write',()=>{
  const evidence=fixture();evidence.current.name=text('Old');
  evidence.events.push(event('return','name',text('New'),text('Old')));
  expect(plan(['name-1','return'],evidence)).toEqual({changes:[],selectedEventIds:['name-1','return'],conflicts:[]});
});
