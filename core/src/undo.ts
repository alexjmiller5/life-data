import type { CoreHandlers, UndoAction, UndoArgs, WriteArgs } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { commitWrite, ValidationError, type WriteCapture } from './write.ts';
import type { Row } from './validate.ts';

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
    // offer to restore an old timestamp or reach behind this successful write.
    if (Object.keys(inverse).length === 1) return null;
  }
  return { action: { receiptId: capture.receiptId, table, rowId: String(after.id), kind }, inverse, capture };
}

/** Private to createCoreHandlers. A new instance owns an empty volatile slot.
 * Hosts still serialize all database use; this queue additionally orders direct
 * session mutations and status reads through COMMIT and receipt publication. */
export function createWriteSession(db: SqlDriver, origin: string) {
  let current: Receipt | null = null;
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
      current = receipt(args.table, result.capture!);
      return result.row;
    });
  };
  const undo: CoreHandlers['undo'] = async (input: UndoArgs) => {
    const args = snapshot(input);
    if (!args || typeof args.receiptId !== 'string' || !/^[a-f0-9]{32}$/.test(args.receiptId)
      || Object.keys(args).length !== 1) throw invalid();
    return queued(async () => {
      if (!current || current.action.receiptId !== args.receiptId) {
        throw new ValidationError([{ tbl: '', row_id: null, col: '', rule: 'conflict', message: 'This saved change is no longer available to undo.' }]);
      }
      const result = await commitWrite(db, current.action.table, current.inverse,
        { origin, expectedUpdatedAt: String(current.capture.after.updated_at) }, false, current.capture);
      current = null;
      return result.row;
    });
  };
  const undoStatus: CoreHandlers['undoStatus'] = () => queued(async () => ({ action: current ? { ...current.action } : null }));
  async function otherMutation<A, T>(input: A, operation: (args: A) => Promise<T>): Promise<T> {
    const args = snapshot(input);
    return queued(async () => {
      const result = await operation(args);
      current = null;
      return result;
    });
  }
  return { write, undo, undoStatus, otherMutation };
}
