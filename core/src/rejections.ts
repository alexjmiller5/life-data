import type { RejectedEdit, RejectionsArgs, RejectionsPage, Row } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';

const invalid = () => new Error('Invalid stored rejection data. The inbox has been kept unchanged.');
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

function parse(value: unknown): unknown {
  if (typeof value !== 'string') throw invalid();
  return JSON.parse(value, (_key, item: unknown) => {
    // JSON.parse accepts overflowing numbers; do not silently turn them into
    // null at the next JSON bridge or fail only in a native decoder.
    if (typeof item === 'number' && !Number.isFinite(item)) throw invalid();
    return item;
  });
}

function decode(row: Row): RejectedEdit {
  try {
    const table = row.tbl, rowID = row.row_id;
    if (typeof table !== 'string' || !table.length || typeof rowID !== 'string' || !rowID.length) throw invalid();
    const submitted = parse(row.row), errors = parse(row.errors);
    if (!object(submitted) || submitted.id !== rowID || !Array.isArray(errors) || !errors.length
      || errors.some(error => !object(error) || error.id !== rowID)) throw invalid();
    return { table, rowID, submitted, errors };
  } catch {
    // Stored payloads can contain private data. Never surface JSON parser text.
    throw invalid();
  }
}

/** Read the durable inbox only. A saved correction is still rejected until sync
 * accepts it. Hosts re-read a full local row before editing its current revision. */
export async function readRejections(db: SqlDriver, args: RejectionsArgs = {}): Promise<RejectionsPage> {
  if (!object(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))
    || Object.keys(args).some(key => !['limit', 'offset'].includes(key))) throw new Error('Invalid rejection arguments');
  const limit = args.limit === undefined ? 100 : args.limit, offset = args.offset === undefined ? 0 : args.offset;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
    || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - limit - 1)
    throw new Error('Invalid rejection pagination');

  // Do not initialize bookkeeping on a read. Qualify main to avoid TEMP shadows.
  const stored = (await db.all("SELECT type FROM main.sqlite_master WHERE name='_core_rejected'"))[0];
  if (!stored) return { rejections: [], nextOffset: null };
  if (stored.type !== 'table') throw invalid();
  const rows = await db.all('SELECT tbl,row_id,row,errors FROM main._core_rejected ORDER BY tbl COLLATE BINARY,row_id COLLATE BINARY LIMIT ? OFFSET ?', [limit + 1, offset]);
  const decoded = rows.map(decode);
  return { rejections: decoded.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}
