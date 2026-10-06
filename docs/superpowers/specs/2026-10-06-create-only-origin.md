# Create-only rows with an atomic origin

Status: implemented source contract. A deployment advertises it only for an
exact configured policy grant; source availability alone is not consumer readiness.

## Required behavior

A separately authorized service may initialize one deterministic row and its
whole-row origin in one checked transaction. Any existing target, including a
tombstone, is acknowledged without changing it, history or provenance. An
adopted target that is absent is never created. This is not an update, generic
provenance writer, import, or multi-row financial changeset.

The existing row insert route remains unchanged. Its table-write grants are not
sufficiently narrow for this consumer, and it does not promise atomic origins.

## Service policy and authorization

The service owns `ROW_CREATION_POLICIES`, a JSON object keyed by opaque policy
ID. No application names, personal table definitions, namespaces or source kinds
are compiled into Core. Each value has exactly:

- `namespace`: canonical lowercase hyphenated UUID, owned permanently by the app.
- `sourceKind`: nonempty well-formed UTF-8 string used in deterministic identity.
- `occurrenceType`: `integer` or `string`. Integers must be safe JSON integers;
  strings retain their exact bytes. No coercion or normalization.
- `table`: catalogued ordinary target table.
- `columns`: explicit editable initializer column allowlist. System identity,
  creation/revision/tombstone fields are not client initializer columns.
- `origin`: `{kind, table, relation}`. `kind` is the catalogued provenance source
  kind; `table` is an ordinary source table or null for an external source;
  `relation` is a catalogued whole-row creation relation. The service verifies
  an internal source exists and is active before creating a target.

The revision is SHA-256 over a canonical, fixed-key-order JSON encoding of the
validated policy, with the columns sorted by byte order. Policy IDs are opaque
ASCII identifiers. The exact grant is `rows:create:<policy-id>:<revision>`.
Changing policy requires a new grant; an old grant cannot silently gain a new
source, destination or initializer column. Existing operator token creation and
revocation remain the provisioning interface. Minting and authentication must
exclude governance authority for any creation-policy credential, including one
with separate explicit read grants. This does not change browser reader enrollment.

Even full/operator scope alone does not select an application identity for this
route. An exact current policy grant is required. It permits no pull, push,
patch, old insert, catalog, provenance, schema, file, stream or derive route.
Independent explicit read grants can be combined for the service's input data.

`GET /v1/session` advertises `rowCreation: {protocol: "atomic-origin-v1",
policies: [{id, revision}]}` only for valid configured policies whose exact
grants the current credential holds. Absence is unsupported. Advertised policy
is protocol authorization, not a guarantee that current catalog/data validation
will accept a particular creation.

## Request and result

`POST /v1/rows/create` accepts exactly:

```
{
  policy: {id: string, revision: string},
  sourceId: string,
  occurrenceKey: string | number,
  target: {kind: "generated" | "adopted", id: string},
  updatedAt: string,
  values: {[column: string]: string | number | boolean | null}
}
```

One target per request, at most 64 initializer fields, at most 16 KiB encoded
request, source ID and string occurrence at most 1024 UTF-8 bytes each. JSON
objects/arrays must use their ordinary catalog serialization in a string; no
client history or origin payload is accepted. Unknown fields fail closed.
`updatedAt` is the ordinary valid UTC-millisecond edit timestamp and is stored
unchanged. The hub stamps arrival time separately.

For generated intent, target ID must equal lowercase 32-hex UUIDv5(namespace,
UTF-8(JSON.stringify(["v1", sourceKind, sourceId, occurrenceKey]))). Strings must
be valid Unicode scalar sequences. Preserve case, spaces and normalization;
integer and string occurrences are distinct. Credential IDs, device identity,
installation state and display names never enter the identity.

For adopted intent, the supplied target ID is authoritative. No computed ID is
substituted. Absence, including a purged target, returns `adopted_missing`.
Any existing target is unchanged, even if the proposed initial values differ.

A 200 receipt has exactly one outcome:

```
{kind: "created", policy: {id, revision}, id,
 revision: {updated_at, hub_at}, originId}
{kind: "existing", policy: {id, revision}, id}
```

`existing` discloses no row content/revision/lineage and never claims the caller
created that row. A lost successful response followed by an existing receipt
settles existence only; it does not reconstruct creation attribution.

Errors use `{error: code}`: 400 `invalid_creation`, 403 `permission_denied`,
409 `adopted_missing` or `creation_conflict`, 422 `creation_rejected`, and 503
`creation_unavailable`. Usage-cap/auth middleware may return its existing error
shapes. Any error, unknown/malformed envelope or transport loss is not a success
receipt. Retry only the same source, occurrence and target intent, never switch
to upsert/patch or a computed ID after an adopted failure. A new request may see
newer catalog or data; errors do not prove that a prior ambiguous attempt failed.

## Checked transaction

Authorize policy before data access. Verify the target is a catalogued base
table with binary TEXT primary key and trusted trigger/dependency topology.
Guard active purge markers before acknowledging an adopted target, including a
stale physical row coexisting with a purge marker. Require binary TEXT identity
on internal source tables too; verify the returned source ID equals the requested
bytes. Check target presence under a read guard. Existing returns without evaluating
initial values or origin; generated and adopted identity envelopes still have
to be valid and authorized. Adopted absence never enters a writer.

For a generated absence, check all current narrow-write eligibility, purge
markers, target values/defaults, source existence, origin metadata and catalog
rules. The origin has server-owned ID `<kind>:<sourceId>:<targetId>`, target
kind/ref from the selected policy and actual target, `field=null`, configured
relation, `asserted_by=namespace`, and no source attributes in detail. It is a
fresh origin: a colliding existing or tombstoned edge rejects the operation;
it is never rewritten or silently adopted.

The existing checked writer separates preparation from execution so the
target and origin validation/trigger plans can share exactly one D1 batch.
All captured schema, policy, row, catalog and source reads are checked before
mutations. Both rows' property/ref/options and invariant triggers remain active
through the whole transaction. Post-write assertions verify both exact approved
rows exist; trigger suppression or alteration rolls everything back. Origins
use the same catalog validator, not unchecked internal SQL. The service keeps
policy-scoped validation errors content-free.

The provenance table has dynamic catalog options and row rules by design. This
internal origin writer must independently validate its complete trigger/default
and dependency topology; it cannot grant arbitrary provenance access or bypass
its enforced rules. Broader generic scoped-rule support is a separate feature.
If a rule/dependency cannot be safely supported, the policy is unavailable rather
than relaxing it. Source and origin purge markers must be checked too.

No external derivation calls, subscription consumer switch or personal catalog
writes are introduced. Existing trusted mutation/subscription/history behavior
must remain transactional. Existing rows produce no new row/history/origin event.

## Acceptance and implementation sequence

1. Real HTTP tests: exact grant only, denied alternate methods/routes/tables,
   stale policy revision, absent capability, legacy full reader regressions.
2. Portable identity and strict receipt tests: integer/string distinction,
   Unicode/escaping, no normalization, rotation-independent IDs, exhaustive
   result validation; app-specific vectors remain in consumer-owned fixtures.
3. Transaction tests: new row + origin, every existing/tombstoned state untouched,
   adopted absent/purged, source absence/delete race, purge insertion race,
   origin collision, invalid target/origin/catalog, suppressed insert, and late
   origin failure all leave zero partial effects.
4. Competing target creation and lost acknowledgment: preserve winner; retry can
   return existing but cannot add lineage or attribute the winner to the retry.
5. Focused mutants, all Worker/core/Python checks, independent source/security
   review. No credential/config activation until a separately verified consumer
   handoff with source, deployed capability and exact grant receipts.

The internal `scopedOrigin` boundary admits only the two complete catalog option
queries pinned in `scopes.js`: active derivation names and ordinary table names.
It additionally recognizes one fully anchored invariant shape: an active base
row with a literal field value must have a matching active provenance edge with
a literal relation. The base table and columns must independently pass narrow
read eligibility. The invariant still runs against the complete transaction;
preexisting and concurrent missing evidence both reject the new creation.
Unknown SQL, views, missing columns, physical foreign keys, arbitrary triggers
and unsafe defaults remain unavailable. Ordinary table grants still cannot
write provenance. All service-owned origin string columns require SQLite TEXT
affinity, and validated values must equal the constructed values exactly.

`life-core/creation` exports the generated request/receipt types and pure
`validateCreationSession` / `validateCreationReceipt` checks. Hosts own HTTP,
credential storage and retry state. The session check requires the one exact
configured creation grant plus explicitly expected column-read grants, rejects
governance authority and broader grants, and matches the policy revision.
Receipt validation rejects mismatched targets, revisions, malformed origin IDs
and incompatible result variants. A null result is not proof of non-commit.
