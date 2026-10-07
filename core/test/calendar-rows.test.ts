import {expect,test} from 'bun:test';
import * as core from '../src/index.ts';
const days=[
  {today:'2026-03-07',start:'2026-03-07T05:00:00.000Z',end:'2026-03-08T05:00:00.000Z'},
  {today:'2026-03-08',start:'2026-03-08T05:00:00.000Z',end:'2026-03-09T04:00:00.000Z'},
  {today:'2026-03-09',start:'2026-03-09T04:00:00.000Z',end:'2026-03-10T04:00:00.000Z'},
];
test('calendar covers each date in an inclusive all-day range without rewriting values',()=>{
  const rows=[{id:'trip',start:'2026-03-07',end:'2026-03-09'},{id:'point',start:'2026-03-08'},{id:'empty',start:null}];
  const before=JSON.stringify(rows);
  expect(core.calendarRows({rows,dateColumn:'start',endDateColumn:'end',days})).toEqual({days:[
    {date:'2026-03-07',rowIds:['trip']},{date:'2026-03-08',rowIds:['trip','point']},{date:'2026-03-09',rowIds:['trip']}
  ],undated:['empty']});
  expect(JSON.stringify(rows)).toBe(before);
});
test('timed ranges overlap real DST day intervals; midnight end is exclusive',()=>{
  const rows=[{id:'event',start:'2026-03-08T04:00:00.000Z',end:'2026-03-09T04:00:00.000Z'},
    {id:'instant',start:'2026-03-09T04:00:00.000Z',end:'2026-03-09T04:00:00.000Z'}];
  expect(core.calendarRows({rows,dateColumn:'start',endDateColumn:'end',days}).days.map(d=>d.rowIds)).toEqual([['event'],['event'],['instant']]);
});
test('invalid and reversed ranges remain visible in undated, not silently normalized',()=>{
 const rows=[{id:'bad',start:'2026-02-30'},{id:'reverse',start:'2026-03-09',end:'2026-03-07'},
  {id:'bad-end',start:'2026-03-08',end:'nonsense'},{id:'outside',start:'2026-04-01'}];
 expect(core.calendarRows({rows,dateColumn:'start',endDateColumn:'end',days})).toEqual({days:days.map(d=>({date:d.today,rowIds:[]})),undated:['bad','reverse','bad-end']});
});
test('fall fold and configured 3am day use supplied calendar bounds',()=>{
 const fold=[{today:'2026-10-31',start:'2026-10-31T07:00:00.000Z',end:'2026-11-01T08:00:00.000Z'},
  {today:'2026-11-01',start:'2026-11-01T08:00:00.000Z',end:'2026-11-02T08:00:00.000Z'}];
 const rows=[{id:'before',start:'2026-11-01T07:59:00.000Z'},{id:'boundary',start:'2026-11-01T08:00:00.000Z'}];
 expect(core.calendarRows({rows,dateColumn:'start',days:fold}).days.map(d=>d.rowIds)).toEqual([['before'],['boundary']]);
});
test('rejects ambiguous IDs and malformed day contexts',()=>{
 expect(()=>core.calendarRows({rows:[{id:'same'},{id:'same'}],dateColumn:'start',days})).toThrow();
 expect(()=>core.calendarRows({rows:[],dateColumn:'start',days:[days[0],days[0]]})).toThrow();
 expect(()=>core.calendarRows({rows:[],dateColumn:'start',days:[{...days[0],end:days[0].start}]})).toThrow();
});
