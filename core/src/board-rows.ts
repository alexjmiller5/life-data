import type { BoardRowsArgs, BoardRowsResult } from './contract.generated.ts';

export function boardRows(args: BoardRowsArgs): BoardRowsResult {
  if (!args || typeof args.column!=='string' || !args.column || !Array.isArray(args.rows)
    || args.rows.length>10000 || !Array.isArray(args.options) || args.options.length>10000
    || args.options.some(o=>typeof o!=='string')) throw new Error('Invalid board rows');
  const columns=new Map<string|null,string[]>();
  for(const option of args.options)if(option&&!columns.has(option))columns.set(option,[]);
  const empty:string[]=[];
  const ids=new Set<string>();
  for(const row of args.rows){
    if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id))throw new Error('Invalid board row identity');
    ids.add(row.id);
    const value=row[args.column];
    if(value===null||value===undefined||value===''){empty.push(row.id);continue;}
    if(typeof value!=='string')throw new Error('Board requires a single select value');
    if(!columns.has(value))columns.set(value,[]);
    columns.get(value)!.push(row.id);
  }
  columns.set(null,empty);
  return {columns:[...columns].map(([value,rowIds])=>({value,rowIds}))};
}
