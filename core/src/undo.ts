import type { CoreHandlers, UndoAction, UndoArgs, WriteArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { commitWrite, ValidationError, type WriteCapture } from './write.ts';
import type { Row } from './validate.ts';
import { resolveRowAction } from './row-actions.ts';
import { validateViewUndo } from './saved-views.ts';

const managed = new Set(['id', 'created_at', 'updated_at', 'hub_at', 'deleted_at']);
type Receipt = { action: UndoAction; inverse: Row; capture: WriteCapture };
const invalid = () => new ValidationError([{ tbl: '', row_id: null, col: '', rule: 'input', message: 'Invalid undo or write arguments.' }]);

// Snapshot queued arguments synchronously, without getters, host globals or
// caller-owned nested objects surviving the wait. Writer validation stays intact.
function snapshot<T>(value: T): T {
  const seen = new Set<object>();
  function copy(v: unknown): unknown {
    if (v === null || v === undefined || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    if (!v || typeof v !== 'object' || seen.has(v)
      || (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw invalid();
    seen.add(v);
    const out: Row | unknown[] = Array.isArray(v) ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue;
      const field = Object.getOwnPropertyDescriptor(v, key)!;
      if (typeof key !== 'string' || !field.enumerable || !('value' in field)) throw invalid();
      (out as Row)[key] = copy(field.value);
    }
    seen.delete(v);
    return out;
  }
  return copy(value) as T;
}

function receipt(table: string, capture: WriteCapture): Receipt | null {
  const { before, after } = capture;
  const inverse: Row = Object.assign(Object.create(null), { id: after.id });
  let kind: UndoAction['kind'] = 'edit';
  if (!before) { inverse.deleted_at = true; kind = 'create'; }
  else {
    for (const col of capture.columns) if (!managed.has(col) && before[col] !== after[col]) inverse[col] = before[col];
    if ((before.deleted_at == null) !== (after.deleted_at == null)) {
      inverse.deleted_at = before.deleted_at == null ? null : true;
      kind = before.deleted_at == null ? 'trash' : 'restore';
    }
    // Repeated trash and same-value writes change timestamps only. Do not
    // offer a timestamp-only action; the stack advances its matching baseline.
    if (Object.keys(inverse).length === 1) return null;
  }
  return { action: { receiptId: capture.receiptId, table, rowId: String(after.id), kind }, inverse, capture };
}

/** Private to createCoreHandlers. A new instance owns an empty volatile undo stack.
 * Hosts still serialize all database use; this queue additionally orders direct
 * session mutations and status reads through COMMIT and receipt publication. */
export function createWriteSession(db: SqlDriver, origin: string) {
  const history: Receipt[] = [];
  // A local inverse creates a new revision. Advance only the nearest earlier
  // receipt for this row when its complete expected state is the state just
  // restored. Never adopt an intervening external edit or a value cycle.
  function advance(table: string, before: Row | null, after: Row) {
    if (!before) return;
    const previous = [...history].reverse().find(r => r.action.table === table && r.action.rowId === after.id);
    if (!previous) return;
    const expected = previous.capture.after;
    if (Object.keys(expected).length === Object.keys(before).length
      && Object.keys(expected).every(c => c === 'hub_at' || expected[c] === before[c])) {
      previous.capture.after = { ...after };
    }
  }
  function publish(table: string, capture: WriteCapture) {
    const next = receipt(table, capture);
    if (next) {
      history.push(next);
      if (history.length > 100) history.shift();
    } else advance(table, capture.before, capture.after);
  }
  let tail = Promise.resolve();
  function queued<T>(body: () => Promise<T>): Promise<T> {
    const result = tail.then(body);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  const write: CoreHandlers['write'] = async (input: WriteArgs) => {
    const args = snapshot(input);
    return queued(async () => {
      const result = await commitWrite(db, args.table, args.patch, { origin, expectedUpdatedAt: args.expectedUpdatedAt }, true);
      publish(args.table, result.capture!);
      return result.row;
    });
  };
  const undo: CoreHandlers['undo'] = async (input: UndoArgs) => {
    const args = snapshot(input);
    if (!args || typeof args.receiptId !== 'string' || !/^[a-f0-9]{32}$/.test(args.receiptId)
      || Object.keys(args).length !== 1) throw invalid();
    return queued(async () => {
      const current = history.at(-1);
      if (!current || current.action.receiptId !== args.receiptId) {
        throw new ValidationError([{ tbl: '', row_id: null, col: '', rule: 'conflict', message: 'This saved change is no longer available to undo.' }]);
      }
      const perform = async (tx: SqlDriver) => commitWrite(tx, current.action.table, current.inverse,
        { origin, expectedUpdatedAt: String(current.capture.after.updated_at) }, false, current.capture);
      const result = current.action.table !== 'views' ? await perform(db) : await db.transaction(async () => {
        await validateViewUndo(db, current.capture.after, current.inverse);
        const tx: SqlDriver = {all:db.all.bind(db),run:db.run.bind(db),transaction:body=>body(),
          ...(db.readDependencies ? {readDependencies:db.readDependencies.bind(db)} : {})};
        return perform(tx);
      });
      history.pop();
      advance(current.action.table, current.capture.before, result.row);
      return result.row;
    });
  };
  const runRowAction: CoreHandlers['runRowAction'] = async input => {
    const args=snapshot(input);
    return queued(async()=>{
      const committed=await db.transaction(async()=>{
        const tx:SqlDriver={all:db.all.bind(db),run:db.run.bind(db),transaction:body=>body(),
          ...(db.readDependencies?{readDependencies:db.readDependencies.bind(db)}:{})};
        const write=await resolveRowAction(tx,args);
        const result=await commitWrite(tx,write.table,write.patch,{origin,expectedUpdatedAt:write.expectedUpdatedAt},true);
        return {table:write.table,result};
      });
      publish(committed.table,committed.result.capture!);
      return committed.result.row;
    });
  };
  const undoStatus: CoreHandlers['undoStatus'] = () => queued(async () => ({ action: history.length ? { ...history.at(-1)!.action } : null }));
  async function capturedMutation<A, T>(table: string, input: A, operation: (args: A, capture: (value: WriteCapture) => void) => Promise<T>): Promise<T> {
    const args = snapshot(input);
    return queued(async () => {
      let capture: WriteCapture | undefined;
      const result = await operation(args, value => { capture = value; });
      if (capture) publish(table, capture);
      return result;
    });
  }
  // Sidebar reorders touch multiple rows and default-view setup is automatic;
  // neither may replace human Undo with a receipt.
  async function uncapturedMutation<A,T>(input:A,operation:(args:A)=>Promise<T>):Promise<T> {
    const args=snapshot(input);
    return queued(()=>operation(args));
  }
  return { write, runRowAction, undo, undoStatus, capturedMutation, uncapturedMutation };
}
