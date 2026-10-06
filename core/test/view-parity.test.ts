import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { compileView, type View } from '../src/view.ts';
import type { Property } from '../src/validate.ts';

const properties: Property[] = [
  {col:'status',type:'select',options:[{v:'Queued'},{v:'Working'},{v:'Finished'}]},
  {col:'priority',type:'select',options:[{v:'Urgent'},{v:'Later'}]},
  {col:'tags',type:'multi_select',options:[{v:'Zed'},{v:'Alpha'},{v:'Beta'}]},
  {col:'due',type:'date'}, {col:'projects',type:'multi_ref'},
];
const spring={today:'2026-03-08',start:'2026-03-08T05:00:00.000Z',end:'2026-03-09T04:00:00.000Z'};
const fall={today:'2026-11-01',start:'2026-11-01T04:00:00.000Z',end:'2026-11-02T05:00:00.000Z'};
const dbs:Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture() {
  const db=new Database(':memory:');dbs.push(db);
  db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,status TEXT,priority TEXT,tags TEXT,due TEXT,projects TEXT,deleted_at TEXT)');
  return {
    insert(id:string,due:string|null,extra:{status?:string;priority?:string;tags?:string[];projects?:string[];deleted?:string}={}) {
      db.query('INSERT INTO items VALUES (?,?,?,?,?,?,?)').run(id,extra.status??'Queued',extra.priority??'Urgent',JSON.stringify(extra.tags??[]),due,JSON.stringify(extra.projects??[]),extra.deleted??null);
    },
    ids(view:Record<string,unknown>={}) {
      const q=compileView({table:'items',...view} as View,properties);
      return (db.query(q.sql).all(...q.params) as {id:string}[]).map(r=>r.id);
    },
  };
}
const daily={
  filters:[{column:'priority',op:'eq',value:'Urgent'},{column:'due',op:'lte',relative:'today'}],
  groups:[
    {match:'any',filters:[{column:'status',op:'eq',value:'Queued'},{column:'status',op:'eq',value:'Working'}]},
    {match:'any',filters:[{column:'projects',op:'empty'},{column:'projects',op:'not_empty'}]},
  ],
  sort:[{column:'status',direction:'desc',mode:'options'},{column:'tags',direction:'asc',mode:'options'}],
  calendar:spring,
};

test('daily grouped query includes all projects and only open urgent items due by local today',()=>{
  const f=fixture();
  f.insert('a','2026-03-07',{tags:['Alpha']});
  f.insert('b','2026-03-08',{status:'Working',tags:['Beta'],projects:['project-1','project-2']});
  f.insert('c','2026-03-08',{status:'Working',tags:['Zed']});
  f.insert('future','2026-03-09');f.insert('undated',null);
  f.insert('low','2026-03-08',{priority:'Later'});
  f.insert('done','2026-03-08',{status:'Finished'});
  f.insert('deleted','2026-03-08',{deleted:'deleted'});
  expect(f.ids(daily)).toEqual(['c','b','a']);
});

test.each([spring,fall])('rolling Today uses local date values and exact offset-bearing instants %#',calendar=>{
  const f=fixture();const start=Date.parse(calendar.start),end=Date.parse(calendar.end);
  f.insert('before',new Date(start-1).toISOString());
  f.insert('start',calendar.start);f.insert('last',new Date(end-1).toISOString());
  f.insert('next',calendar.end);f.insert('date',calendar.today);f.insert('null',null);
  const ids=(op:string)=>f.ids({calendar,filters:[{column:'due',op,relative:'today'}]});
  expect(ids('eq')).toEqual(['date','last','start']);
  expect(ids('lte')).toEqual(['before','date','last','start']);
  expect(ids('lt')).toEqual(['before']);expect(ids('gt')).toEqual(['next']);
  expect(ids('gte')).toEqual(['date','last','next','start']);expect(ids('ne')).toEqual(['before','next']);
});

test('an offset date is classified by its instant and an updated context rolls the queue',()=>{
  const f=fixture();f.insert('local','2026-03-09T01:00:00+02:00');
  f.insert('next','2026-03-09');f.insert('invalid','not-a-date');
  f.insert('naive','2026-03-08T12:00:00');f.insert('impossible','2026-02-30');
  expect(f.ids({calendar:spring,filters:[{column:'due',op:'eq',relative:'today'}]})).toEqual(['local']);
  const calendar={today:'2026-03-09',start:spring.end,end:'2026-03-10T04:00:00.000Z'};
  expect(f.ids({calendar,filters:[{column:'due',op:'lte',relative:'today'}]})).toEqual(['local','next']);
});

test('option sorts use first selected rank, secondary clauses, stable ties and trailing unknowns',()=>{
  const f=fixture();
  for(const [id,tags] of [['d',['Beta','Zed']],['c',['Alpha','Zed']],['b',['Zed','Beta']],['a',['Zed']],['unknown',['Future']],['empty',[]]] as const)f.insert(id,null,{tags:[...tags]});
  const sort=(direction:string)=>[{column:'tags',direction,mode:'options'}];
  expect(f.ids({sort:sort('asc')})).toEqual(['a','b','c','d','unknown','empty']);
  expect(f.ids({sort:sort('desc')})).toEqual(['d','c','a','b','unknown','empty']);
  expect(f.ids({sort:[...sort('asc'),{column:'id',direction:'desc'}]})).toEqual(['b','a','c','d','unknown','empty']);
});

test.each([
  {filters:[{column:'due',op:'lte',relative:'today'}]},
  {calendar:{...spring,today:'2026-02-30'}},
  {calendar:{...spring,end:spring.start}},
  {calendar:{...spring,start:'yesterday'}},
  {calendar:spring,filters:[{column:'due',op:'lte',relative:'today',value:'2026-03-08'}]},
  {calendar:spring,filters:[{column:'due',op:'empty',relative:'today'}]},
  {calendar:spring,filters:[{column:'status',op:'eq',relative:'today'}]},
  {groups:[{match:'any',filters:[]}]},
  {groups:[{match:'none',filters:[{column:'due',op:'empty'}]}]},
  {groups:[{match:'all',filters:[{match:'any',filters:[]}]}]},
  {sort:[{column:'due',direction:'asc',mode:'options'}]},
  {sort:[{column:'status',direction:'asc',mode:'unknown'}]},
])('invalid relative/group/sort input is rejected without broadening the query %#',view=>{
  expect(()=>fixture().ids(view)).toThrow();
});

test.each(['created_at','updated_at','deleted_at','hub_at'])('Today works on the uncataloged system timestamp %s',column=>{
 const db=new Database(':memory:');dbs.push(db);
 db.exec('CREATE TABLE records(id TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT,hub_at TEXT)');
 for(const [id,stamp] of [['before',spring.start],['after',spring.end]]) {
  db.query('INSERT INTO records VALUES (?,?,?,?,?)').run(id,stamp,stamp,column==='deleted_at'?stamp:null,stamp);
 }
 const view:View={table:'records',trash:column==='deleted_at',calendar:spring,filters:[{column,op:'lte',relative:'today'}],sort:[{column:'id',direction:'asc'}]};
 const q=compileView(view,[]);
 expect(db.query(q.sql).all(...q.params).map((r:any)=>r.id)).toEqual(['before']);
});
