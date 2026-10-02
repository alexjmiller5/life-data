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
void [missingTable, wrongSort, wrongValue, wrongArgs, wrongFeed, missingHandlers, badSearch, incompleteHit];
