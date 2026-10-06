import type { CoreArgs, CoreHandlers, CoreResult, Filter, View } from '../src/contract.generated.ts';

// Compile-only negative examples: widening the generated API must fail tsc.
// @ts-expect-error table is required
const missingTable: View = {};
// @ts-expect-error sort direction is closed
const wrongSort: View = { table: 'items', sort: [{ column: 'id', direction: 'sideways' }] };
// @ts-expect-error arbitrary JSON objects are not filter scalar values
const wrongValue: Filter = { column: 'id', op: 'eq', value: {} };
// @ts-expect-error operation arguments are tied to the method
const wrongArgs: CoreArgs<'rows'> = { endpoint: 'https://hub.example.test' };
// @ts-expect-error complete notification feed has no continuation cursor
const wrongFeed: CoreResult<'serviceNotifications'> = { notifications: [], next_cursor: 7, latest_cursor: 7, unread_count: 0 };
// @ts-expect-error handlers must cover every current operation
const missingHandlers: CoreHandlers = { status: () => ({ lastSuccessfulSync: null, pendingUiEdits: 0, rejected: 0 }) };
// @ts-expect-error a search needs text, not an endpoint or SQL
const badSearch: CoreArgs<'search'> = { endpoint: 'https://hub.example.test' };
// @ts-expect-error search hits identify the table as well as the row
const incompleteHit: CoreResult<'search'> = [{ id: 'row', label: 'Label', excerpt: 'Excerpt' }];
// @ts-expect-error shared views have no persisted per-device selection
const privateView: CoreArgs<'saveView'> = { table: 'items', name: 'Example', definition: { version: 1, selected: true } };
// @ts-expect-error every deletion needs the selected revision
const unsafeDelete: CoreArgs<'deleteView'> = { id: 'view' };
void [privateView, unsafeDelete];
void [missingTable, wrongSort, wrongValue, wrongArgs, wrongFeed, missingHandlers, badSearch, incompleteHit];
// @ts-expect-error undo accepts a receipt handle, never client-supplied inverse data
const forgedUndo: CoreArgs<'undo'> = { receiptId: 'receipt', patch: { name: 'Forged' } };
// @ts-expect-error an empty undo slot must be explicit null
const absentUndo: CoreResult<'undoStatus'> = {};
void [forgedUndo, absentUndo];
// @ts-expect-error hosts supply numeric HTTP status, never exception text
const stringStatus: CoreArgs<'sessionRevocationResult'> = { status: 'HTTP 401', data: null };
// @ts-expect-error approval always binds the candidate fingerprint
const unboundApproval: CoreArgs<'enrollmentPollResult'> = { reply: { status: 200, data: {} } };
// @ts-expect-error a null pending session is required in the generated shape
const ambiguousPoll: CoreResult<'enrollmentPollResult'> = { state: 'pending', retryAfterSeconds: 5 };
void [stringStatus, unboundApproval, ambiguousPoll];
// @ts-expect-error pagination is numeric; IDs are returned unchanged, never supplied as SQL
const invalidRejections: CoreArgs<'rejections'> = { limit: '100' };
// @ts-expect-error callers must handle an explicit null terminal offset
const incompleteRejections: CoreResult<'rejections'> = { rejections: [] };
// @ts-expect-error stored sync errors are whole rejection objects, not flattened messages
const flattenedRejection: CoreResult<'rejections'> = { rejections: [{ table: 'items', rowID: 'a', submitted: { id: 'a' }, errors: ['Denied'] }], nextOffset: null };
void [invalidRejections, incompleteRejections, flattenedRejection];
// @ts-expect-error every row action needs the selected row revision
const unsafeAction: CoreArgs<'runRowAction'> = { viewId:'view',actionId:'close',rowId:'a' };
// @ts-expect-error layout entries cannot execute code
const scriptLayout: CoreArgs<'saveView'> = { table:'items',name:'Example',definition:{version:2,layout:[{kind:'script',id:'code'}]} };
void [unsafeAction, scriptLayout];
