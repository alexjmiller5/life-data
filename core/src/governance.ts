import type { CellValue, Change, Conflict, HistoryEvent, Revision, Target } from './contract.generated.ts';
import { validEditTimestamp } from './validate.ts';

/** Trusted service-loader input, not a wire request. Events must be the complete
 * canonical commit-ordered suffix covering every selected event through the
 * current row revision. A paginated history result cannot establish completeness.
 * This planner does not authorize, validate catalog rules, issue tokens or write. */
export interface InverseEvidence {
  target: Target;
  revision: Revision;
  current: Readonly<Record<string, CellValue>>;
  events: readonly HistoryEvent[];
  complete: boolean;
}
export interface InverseSelection { target: Target; eventIds: readonly string[] }
export interface InversePlan { changes: Change[]; selectedEventIds: string[]; conflicts: Conflict[] }

const managed=new Set(['id','created_at','updated_at','hub_at','deleted_at']);
const object=(value:unknown):value is Record<string,unknown>=>value!==null && typeof value==='object' && !Array.isArray(value);
const nonempty=(value:unknown):value is string=>typeof value==='string' && value.trim().length>0;
const targetIs=(value:unknown):value is Target=>object(value) && nonempty(value.table) && nonempty(value.rowId);
const sameTarget=(a:Target,b:Target)=>a.table===b.table && a.rowId===b.rowId;

function cell(value:unknown):value is CellValue {
  if(!object(value))return false;
  if(value.type==='null')return Object.keys(value).length===1;
  if(Object.keys(value).sort().join(',')!=='type,value')return false;
  if(value.type==='text')return typeof value.value==='string';
  if(value.type==='real')return typeof value.value==='number' && Number.isFinite(value.value);
  if(value.type!=='integer' || typeof value.value!=='string' || value.value.length>20 || !/^(0|-?[1-9][0-9]*)$/.test(value.value))return false;
  const integer=BigInt(value.value);
  return integer>=-9223372036854775808n && integer<=9223372036854775807n;
}
const equal=(a:CellValue,b:CellValue)=>a.type===b.type && (a.type==='null' || (b.type!=='null' && Object.is(a.value,b.value)));
const copy=(value:CellValue):CellValue=>({...value});

/** Produce only selected-column inverse differences. The future writer must
 * reacquire and guard this evidence in its transaction; a plan is not approval. */
export function planSelectedInverse(selection:InverseSelection,evidence:InverseEvidence):InversePlan {
  const conflicts:Conflict[]=[], changes:Change[]=[];
  let selectedEventIds:string[]=[];
  const fail=(code:Conflict['code'],column:string|null,eventIds:string[],message:string)=>{
    conflicts.push({code,column,eventIds:[...eventIds],message});
  };
  const result=():InversePlan=>({changes:conflicts.length?[]:changes,selectedEventIds,conflicts});
  if(!object(selection) || !targetIs(selection.target) || !Array.isArray(selection.eventIds)
    || !selection.eventIds.length || !selection.eventIds.every(nonempty)
    || new Set(selection.eventIds).size!==selection.eventIds.length){
    fail('validation_failed',null,[],'Select distinct historical changes for one record.');return result();
  }
  selectedEventIds=[...selection.eventIds];
  if(!object(evidence) || evidence.complete!==true || !targetIs(evidence.target)
    || !sameTarget(selection.target,evidence.target) || !Array.isArray(evidence.events) || !object(evidence.current)
    || !object(evidence.revision) || !validEditTimestamp(evidence.revision.updated_at)
    || (evidence.revision.hub_at!==null && !validEditTimestamp(evidence.revision.hub_at))){
    fail('history_unavailable',null,selectedEventIds,'Complete history at the current revision is required.');return result();
  }
  const selected=new Set(selection.eventIds),ids=new Set<string>();
  const columns=new Map<string,{first:number;current:CellValue;events:HistoryEvent[]}>();
  for(const [index,event] of evidence.events.entries()){
    if(!object(event) || !nonempty(event.id) || ids.has(event.id) || !targetIs(event.target)
      || !sameTarget(event.target,selection.target) || !nonempty(event.column)){
      fail('history_unavailable',null,selectedEventIds,'Historical identity or ordering evidence is unavailable.');return result();
    }
    ids.add(event.id);
    if(selected.has(event.id) && !columns.has(event.column)){
      const current=Object.hasOwn(evidence.current,event.column)?evidence.current[event.column]:null;
      if(managed.has(event.column) || !cell(current)){
        fail('history_unavailable',event.column,[event.id],'This historical field cannot be reversed.');return result();
      }
      columns.set(event.column,{first:index,current,events:[]});
    }
  }
  if(selection.eventIds.some(id=>!ids.has(id))){
    fail('history_unavailable',null,selectedEventIds,'A selected historical change is unavailable.');return result();
  }
  selectedEventIds=evidence.events.filter(event=>selected.has(event.id)).map(event=>event.id);
  for(const [index,event] of evidence.events.entries()){
    const column=columns.get(event.column);
    if(column && index>=column.first)column.events.push(event);
  }
  for(const [column,state] of columns){
    const later=state.events.filter(event=>!selected.has(event.id));
    if(later.length){
      fail('later_column_change',column,later.map(event=>event.id),'Unselected later changes affect this field.');continue;
    }
    let prior=state.current,valid=true;
    for(let i=state.events.length-1;i>=0;i--){
      const event=state.events[i];
      if(event.reversible!==true || !cell(event.before) || !cell(event.after) || !equal(prior,event.after)){
        fail('history_unavailable',column,[event.id],'Typed continuous history does not match the current field.');valid=false;break;
      }
      prior=event.before;
    }
    if(valid && !equal(prior,state.current))changes.push({column,before:copy(state.current),after:copy(prior)});
  }
  return result();
}
