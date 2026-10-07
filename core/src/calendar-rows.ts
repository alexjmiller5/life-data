import type { CalendarRowsArgs, CalendarRowsResult } from './contract.generated.ts';
import { validEditTimestamp } from './validate.ts';
import { validateCalendarContext } from './view.ts';

type DateValue = { day: string | null; instant: number };
function dateValue(value: unknown): DateValue | null {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && validEditTimestamp(value+'T00:00:00.000Z'))
    return {day:value,instant:Date.parse(value+'T00:00:00.000Z')};
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !validEditTimestamp(value.slice(0,10)+'T00:00:00.000Z')) return null;
  const instant=Date.parse(value);
  return Number.isFinite(instant) ? {day:null,instant} : null;
}

/** Rendering only. Hosts supply timezone-aware bounds and keep ordinary query
 * pagination visible. This never rewrites source dates or compiles SQL. */
export function calendarRows(args: CalendarRowsArgs): CalendarRowsResult {
  if (!args || typeof args.dateColumn !== 'string' || !args.dateColumn
    || (args.endDateColumn !== undefined && (typeof args.endDateColumn !== 'string' || !args.endDateColumn))
    || !Array.isArray(args.rows) || args.rows.length>10000 || !Array.isArray(args.days) || args.days.length>62)
    throw new Error('Invalid calendar rows');
  const dates=new Set<string>();
  let previousEnd=-Infinity;
  const bounds=args.days.map(day=>{
    if (!validateCalendarContext(day) || dates.has(day.today) || Date.parse(day.start)<previousEnd)
      throw new Error('Invalid calendar days');
    dates.add(day.today);previousEnd=Date.parse(day.end);
    return {date:day.today,start:Date.parse(day.start),end:previousEnd};
  });
  const result:CalendarRowsResult={days:bounds.map(d=>({date:d.date,rowIds:[]})),undated:[]};
  const ids=new Set<string>();
  for (const row of args.rows) {
    if (!row || typeof row.id!=='string' || !row.id || ids.has(row.id)) throw new Error('Invalid calendar row identity');
    ids.add(row.id);
    const start=dateValue(row[args.dateColumn]);
    const rawEnd=args.endDateColumn ? row[args.endDateColumn] : null;
    const hasEnd=rawEnd!==undefined && rawEnd!==null && rawEnd!=='';
    const end=hasEnd ? dateValue(rawEnd) : start;
    if (!start || !end || ((start.day===null)===(end.day===null) && end.instant<start.instant)) {
      result.undated.push(row.id);continue;
    }
    const point=!hasEnd || (start.day===null && end.day===null && start.instant===end.instant);
    bounds.forEach((day,index)=>{
      const included=point
        ? start.day!==null ? start.day===day.date : start.instant>=day.start && start.instant<day.end
        : (start.day!==null ? start.day<=day.date : start.instant<day.end)
          && (end.day!==null ? end.day>=day.date : end.instant>day.start);
      if (included) result.days[index].rowIds.push(row.id as string);
    });
  }
  return result;
}
