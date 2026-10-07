# Bounded final-state changesets

The trusted writer prepares one bounded set of creates, revision-guarded patches
and explicit soft-deletes. All read guards run before setup; all mutations run
before catalog invariants and touched reference/option checks; history, service
receipts and cleanup commit in the same D1 batch. The caller supplies authenticated
authorization, displayed dependency membership reads, actor and operation identity.
No domain schema, classification or personal policy belongs in this implementation.

## Writer contract

- At most 64 operations, 8 tables and 65,536 request bytes. Over-limit sets fail
  wholly and are never implicitly chunked. D1's existing query/SQL bounds also apply.
- Each operation names kind, table, id and expected_revision. Creates require
  expected_revision null and absence including tombstones. Patch and soft_delete
  require exact updated_at plus hub_at and a live row. Duplicate table/id targets
  fail, including case aliases of a table. IDs require a single BINARY TEXT key.
- Creates and patches include sparse values; soft_delete carries none. Managed
  identity, clock and lifecycle columns cannot be supplied as values. Provenance
  is insert-only. Catalog, history, purge and private engine state are not targets.
- Existing catalog immutability, types, required fields and derivation proof remain
  enforced. A soft-delete changes only lifecycle/revision fields. Tombstones cannot
  be restored through this primitive.
- Each table's invariant receives the complete changed final row set and original
  before set, preserving native SQLite types. The supplied now timestamp is stable.
  All participating table mutations precede these checks, regardless of input order.
- Reads captured by checkedReads, including empty membership queries, guard the
  transaction against concurrent edits, insertions and membership changes. The
  caller must capture the complete dependencies of its displayed decision; a
  row revision alone cannot prove a sibling set is unchanged.
- Row receipts are read inside the committing transaction. A suppressed mutation,
  validation failure, history failure or service receipt failure rolls back all
  effects. Preview probes deliberately roll back and return no committed receipt.

## Authorization boundary

The HTTP protocol is separate from single-row governance. `/v1/session` advertises
`bounded-changeset-proposals-v1` only for configured eligible principals. Broad
read is required for proposal access; approval additionally requires authenticated
USER authority and broad write. Operator credentials cannot approve, and narrowed
row/table grants are not expanded.

The fixed routes under `/v1/governance/changesets` are `preview`,
`proposals/create`, `proposals/get`, `proposals/preview`, `proposals/approve` and
`proposals/reject`. The canonical generated DTO defines typed operations and
read sets with equality predicates plus expected complete ID/revision membership.
The service captures full queried rows, complete mutated-table revision and
continuity sets, schema/catalog dependencies and reference/option reads. Evidence
creation guards exact edge absence without loading unrelated retained evidence.

Preview is authenticated and revocation-checked, but remains inert for domain,
proposal, evidence/history, auth usage and outbound effects. Provider/security
access logs are outside this promise. An encrypted five-minute preview binds the
principal, immutable proposal/version, exact input, displayed before/after and
all captured dependencies. Proposal creation and approval reject drift rather than
rebasing. Native random ID defaults are safe only because the ID is explicit;
unresolved dynamic defaults and unsupported schema mechanics fail closed.

Approval commits all writes, history, proposal state and one original-key receipt
in the same transaction. Terminal negative receipts exclude delayed execution.
Retries resolve that key before mutable proposal validation, after current auth
and scope checks. Same-key changed requests conflict. Purges redact dependent
payloads and receipts while preserving exclusion keys. Client receipt parsing
requires every expected member, actor, proposal and version; partial/mismatched or
uncertain outcomes remain unresolved in the host's durable journal.

Bounds include 64 operations, 8 mutated tables, 64 explicit read sets, 2,000 total
explicit read rows, 20,000 continuity/membership rows per mutated table, the
existing SQL/query budgets, and a 38,000-byte preview binding (within the 65,536-byte
HTTP envelope after encryption). Exceeding any bound rejects the complete set.
Complete-table membership is deliberately conservative and may invalidate a review
when another member changes. A host must supply its whole displayed dependency
sets, including source parents and allocation siblings, and still provide an
actual USER session and recoverable captured-scope journal before activation.

## Verification

Synthetic records exercise both cross-table mutation orders, final-entry removal,
new referenced rows, invalid final states, exact revisions, tombstone collision,
immutable properties, complete membership races, native before/after aggregates,
full rollback and typed actor/history linkage. Tests use no personal schema or data.

HTTP tests cover inertness across both stores, actual user/agent/operator authority,
first-preview membership drift, unversioned sibling edits, late-original exclusion,
lost receipt replay, revocation, purge, final-receipt failure and real SQLite/D1
limits. Generated TypeScript and Swift contracts share the canonical hash.
