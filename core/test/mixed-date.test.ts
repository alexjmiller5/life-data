import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { compileView } from '../src/view.ts';

for (const calendar of [
  {today:'2032-06-01',start:'2032-06-01T07:00:00.000Z',end:'2032-06-02T07:00:00.000Z'},
  {today:'2026-03-07',start:'2026-03-07T08:00:00.000Z',end:'2026-03-08T07:00:00.000Z'},
  {today:'2026-10-31',start:'2026-10-31T07:00:00.000Z',end:'2026-11-01T08:00:00.000Z'},
]) test(`mixed calendar keeps date precision and policy boundaries: ${calendar.today}`, () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE items(id TEXT PRIMARY KEY,due TEXT,deleted_at TEXT)');
    for (const [id,value] of [['date',calendar.today],['start',calendar.start],
      ['last',new Date(Date.parse(calendar.end)-1).toISOString()],['next',calendar.end],['null',null]])
      db.query('INSERT INTO items VALUES (?,?,NULL)').run(id,value);
    const query = compileView({table:'items',calendar,filters:[{column:'due',op:'lte',relative:'today'}]},
      [{col:'due',type:'date_or_datetime'}]);
    expect(db.query(query.sql).all(...query.params).map((row:any)=>row.id)).toEqual(['date','last','start']);
  } finally { db.close(); }
});
