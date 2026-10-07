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

This is an internal service primitive, not a new route, advertised capability or
approval mechanism. Existing single-row governance stays unchanged. A public
changeset requires its own canonical DTO, current authenticated actor/scope,
principal-bound preview, exact proposal version, user approval, durable idempotency
and negative-receipt exclusion, purge handling and host acceptance. An operator
credential or an array of existing approvals does not supply those semantics.

## Verification

Synthetic records exercise both cross-table mutation orders, final-entry removal,
new referenced rows, invalid final states, exact revisions, tombstone collision,
immutable properties, complete membership races, native before/after aggregates,
full rollback and typed actor/history linkage. Tests use no personal schema or data.
