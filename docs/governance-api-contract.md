# Governance API contract draft

This is the canonical service boundary with generated TypeScript and Swift
DTOs. Configured Workers implement and advertise the complete protocol for
eligible credentials; the canonical core adapter validates transport results.
Hosts keep their injected API null until that capability and raw transport exist.
Clients never derive inverse patches or substitute the direct writer.

Selected behavior: reverse selected historical changes while preserving
unrelated later edits. Agents propose; an authenticated user approves online.
The first atomic unit is one existing live row with one or more field changes.
Creation, deletion, restoration, schema changes, cross-row transactions, and
offline approval are unavailable in this slice.

## Existing prerequisites and implementation ownership

- Conditional HTTP patch uses `expected_revision: {updated_at, hub_at}` and
  returns the revision from the committing batch. It does not implement preview,
  historical inverse, proposals, user approval, or durable idempotency.
- History remains canonical. Existing event IDs are stable, but legacy `old`
  and `new` are TEXT projections. Typed values, total ordering/continuity,
  operation linkage, and authenticated actor attribution need evidence before
  a historical event can be offered as reversible. Do not infer missing types
  or an uninterrupted history from matching current values.
- Current authentication identifies a token and scopes. It does not establish
  user approval authority. A token name, `origin`, `full`, or table write access
  must not confer that authority. Service-issued user approval authority must
  be distinct from agent proposal authority before approval is enabled.
- Life Data owns validation, inverse derivation, scope enforcement, proposal
  storage, approval, history linkage, and receipts. Clients own selection,
  review presentation, explicit confirmation, and stale-response invalidation.

## Shared data shapes

The following TypeScript notation specifies JSON data, not client implementations.
Opaque strings are compared exactly and never interpreted by a client.

```ts
type Target = { table: string; rowId: string };
type Revision = { updated_at: string; hub_at: string | null };
type CellValue =
  | { type: "null" }
  | { type: "text"; value: string }
  | { type: "integer"; value: string } // signed decimal, preserves 64-bit values
  | { type: "real"; value: number };   // finite only
type Actor = { principalId: string; kind: "user" | "agent" | "service" };
type Change = { column: string; before: CellValue; after: CellValue };
type Conflict = {
  code: "later_column_change" | "history_unavailable" | "revision_changed"
    | "validation_failed" | "proposal_changed" | "unavailable";
  column: string | null;
  eventIds: string[];
  message: string;
};
type Intent =
  | { kind: "selected_inverse"; eventIds: string[] }
  | { kind: "patch"; changes: { column: string; after: CellValue }[] };
type PreviewRequest = { target: Target; intent: Intent };
type Preview = {
  target: Target;
  revision: Revision;
  changes: Change[];
  selectedEventIds: string[];
  conflicts: Conflict[];
  // Null unless valid, authorized, supported, and safe to submit.
  previewToken: string | null;
  expiresAt: string | null;
};
type HistoryEvent = {
  id: string;
  operationId: string | null;
  target: Target;
  column: string;
  before: CellValue | null; // outer null means unknown, not SQL NULL
  after: CellValue | null;
  occurredAt: string;
  actor: Actor | null;     // null for unverified legacy attribution
  claimedOrigin: string | null;
  reversible: boolean;
  unavailableReason: string | null;
};
type Proposal = {
  id: string;
  version: string;
  target: Target;
  intent: Intent;
  changes: Change[];
  baseRevision: Revision;
  state: "pending" | "approved" | "rejected";
  proposedBy: Actor;
  claimedOrigin: string | null;
  createdAt: string;
  updatedAt: string;
};
type ApprovalReceipt = {
  operationId: string;
  proposalId: string;
  proposalVersion: string;
  target: Target;
  revision: Revision;
  historyEventIds: string[];
  approvedBy: Actor;
  committedAt: string;
};
type MutationErrorCode =
  | "proposal_changed" | "revision_changed" | "history_unavailable"
  | "validation_failed" | "permission_denied" | "unavailable"
  | "expired_preview" | "idempotency_conflict";
type MutationResolution = "unresolved" | "not_committed";
type MutationResult<T> =
  | { kind: "success"; value: T }
  | { kind: "purged" }
  | { kind: "error"; code: MutationErrorCode;
      resolution: MutationResolution; conflicts: Conflict[] }
  // Adapter outcomes, never JSON fabricated by the service:
  | { kind: "transport_error"; code: "offline" | "indeterminate" };
type ApprovalResult = MutationResult<ApprovalReceipt>;
type ReadResult<T> =
  | { kind: "success"; value: T }
  | { kind: "unavailable" }
  | { kind: "transport_error"; code: "offline" | "indeterminate" };
```

Stored proposal versions are immutable. `version` is an opaque compare-and-swap
token, not a client counter. `changes` are server-derived authorized differences,
not an entire row. No client-supplied actor field is accepted. An optional
`claimedOrigin` on proposal creation/editing is untrusted display metadata and
never changes authorization or overwrites authenticated attribution.

## Operation slice

These operations use the exact transport and capability boundary in
`governance-transport-contract.md`. See `governance-service.md` for supported
tables, deployment configuration and the explicit host adapter injection seam.

| Operation | Request | Response |
| --- | --- | --- |
| `historyEvents` | `{target, cursor?: string, limit?: number}` | `ReadResult<{events: HistoryEvent[], nextCursor: string|null}>` |
| `previewChanges` | `PreviewRequest` | `ReadResult<Preview>` |
| `createProposal` | `{previewToken, idempotencyKey, claimedOrigin?: string}` | `MutationResult<Proposal>` |
| `listProposals` | `{target?: Target, state?: "pending"|"approved"|"rejected", cursor?: string, limit?: number}` | `ReadResult<{proposals: Proposal[], nextCursor: string|null}>` |
| `getProposal` | `{proposalId, version?: string}` | `ReadResult<Proposal>` |
| `editProposal` | `{proposalId, expectedVersion, previewToken, idempotencyKey, claimedOrigin?: string}` | `MutationResult<Proposal>` with a new version on success |
| `previewProposal` | `{proposalId, expectedVersion}` | `ReadResult<Preview>` whose token also binds that proposal/version |
| `approveProposal` | `{proposalId, expectedVersion, previewToken, idempotencyKey}` | `ApprovalResult` |
| `rejectProposal` | `{proposalId, expectedVersion, idempotencyKey}` | `MutationResult<Proposal>` in rejected state on success |

Identifiers and revisions are mandatory nonempty strings; event selections and
patch columns must be nonempty and unique. Limits, token lifetime, and size caps
will be specified by service capabilities, not hardcoded in presentation. Missing
capabilities disable the operation. Cursor pages do not prove history continuity
or table completeness. Denied records and fields are never returned as conflicts.

Lists omit purged and inaccessible proposals, without placeholder entries or
counts disclosing them. Direct reads of absent, purged, or denied resources all
return exactly `{kind: "unavailable"}`. They do not return a `Proposal` with
redacted required fields. An accessible proposal-version conflict can return a
preview with `proposal_changed` and no token; it cannot return newer differences
as if they had been reviewed. Preview reads of a terminal proposal are unavailable.

Creation starts pending. Only a current pending proposal may be edited,
approved, or rejected, with an exact version guard. Editing creates a new pending
version and leaves old versions immutable. Approval and rejection are terminal;
neither can reopen or edit a terminal proposal. A guarded mutation of a terminal
proposal returns `proposal_changed`, except a recognized committed idempotent
retry, which returns its stored result. Purge can remove any state and makes it
unavailable for reads. Editing keeps the same target; changing targets requires
a new proposal.

`purged` is exactly `{kind: "purged"}` with no identifiers, values, actor, or
receipt payload. A denied response contains an empty conflict list. A service
error invalidates the current approval preview, but does not by itself settle
the original operation. The client shows the denial and never automatically
changes the requested version/patch. An `idempotency_conflict` must not be
bypassed by silently minting a new key.

The adapter returns `offline` only when it knows the request was not dispatched;
an uncertain dispatch, timeout, or lost response is `indeterminate`. Both keep
the exact original request and key for retry and disable approval under the stale
preview. An indeterminate operation remains unresolved until the same request
is reconciled; a user may not start a replacement approval with a new key as if
the first failed. These transport outcomes are not evidence of server rollback.
Retrying the original key can recover its committed receipt even when the preview
token has since expired. An uncommitted expired preview requires fresh review,
after an authoritative original-operation settlement permits replacing the key.

Every error carries required `resolution`. `unresolved` means the response does
not establish whether the exact original operation committed or can still commit.
This includes auth/cap/resource rejection before receipt lookup, regardless of
the HTTP status and even when that retry itself performed no write. Retain the
exact parked request/key and its original deployment/session/principal scope;
do not clear the journal, create a replacement approval, or reinterpret denied
receipt access as rollback. An offline retry does not resolve an earlier
uncertain dispatch either. Do not infer resolution from an error code.

`not_committed` is an authoritative durable negative receipt. Before returning
it, the service must authorize original-operation resolution, bind the exact key
and request identity, check for a prior committed/purged/negative result, and
atomically persist a terminal record preventing every late or concurrent attempt
with that key from applying. Absence of a receipt, failed current preconditions,
an empty query, rollback of this attempt, or elapsed time is insufficient. If a
prior success won the race, return its authorized receipt instead. Storage or
authorization failure to resolve the key returns `unresolved`. A recognized
negative retry never re-evaluates the request into a new mutation. It follows
the same permission, redaction and purge rules as other receipts.

The journal clears only on a validated `success`, a content-free `purged` receipt,
or an error with `resolution: "not_committed"`. All `unresolved` and transport
results retain it, including across restart and context changes. Refreshing a
preview does not replace a parked approval. The transport contract defines the
complete allowed status/code/resolution pairs. Clients require the generated
resolution field; old error shapes without it cannot enable an adapter.

Clients import canonical generated shapes during integration. The generic
notation above is emitted as concrete `ProposalMutationResult`, `ApprovalResult`,
`HistoryEventsResult`, `PreviewResult`, `ProposalsResult`, and `ProposalResult`.
The nine exact operation pairs are generated in `CoreOperations`. Use the
canonical injected adapter and advertised capability; unconfigured handlers
remain unavailable and never fall back to a local mutation.

## Inverse and conflict semantics

For each selected column, the server walks verified selected events in reverse
commit order, restoring each event's typed prior value. A later unselected event
on that column is a conflict, even if the value later returns to the same text.
An unselected event between selected events on the same column is also a conflict.
Unrelated columns retain their current values. There is no client option to
force a conflict or reinterpret it as a whole-row snapshot.

Event content, target, complete relevant history, types, catalog, invariants,
reference dependencies, and current row revision must be validated. Missing,
purged, ambiguous, untyped, or unsupported history returns `history_unavailable`.
No write is offered on the strength of an event ID alone. Values not represented
by the supported typed cells are unavailable, never coerced.

The displayed preview binds the exact row revision and authorized patch. Any
intervening row edit causes approval conflict, including an unrelated-column
edit. Refreshing preview can preserve that unrelated change, but a proposal's
stored patch/base cannot silently rebase: editing creates a new proposal version
and requires another review. A UI must discard a preview on selection, workspace,
session, target, or proposal-version change and reject late responses.

## Preview and atomic approval

Preview authenticates, authorizes, and checks revocation. It has no persistent
domain, proposal, history, auth-usage, receipt, or notification effects and sends
no deliveries or derivation requests. Provider access/security logs are outside
that guarantee. Cold initialization and current auth usage updates mean an
ordinary failed patch or rollback of its row transaction is not a preview seam.

The preview token is opaque, server-verifiable, expires, and is bound to the
deployment, authenticated principal, target, intent, selected event content,
catalog/dependencies, revision, and exact differences. Proposal previews also
bind proposal ID/version. Producing it does not create server-side preview rows.
A token is evidence for revalidation, never permission to skip it.

Approval requires service-authenticated user authority plus current permission
for every read and changed field. Proposal authority cannot approve. The server
atomically checks pending state/version, preview binding, retained source events,
row and dependency revisions, catalog validation and invariants; applies all
fields; links canonical history events to an operation and authenticated actor;
marks the exact proposal approved; and saves the receipt. Any failure rolls back
all of these. No approval state is committed before the row transaction. Stored
proposal editing/rejection races conflict with approval via the same guarded
version. Unselected fields do not appear in the patch or receipt.

Proposal state and receipts must reside with the data writer so this transaction
is real. Existing credential storage in a separate auth database is not a way to
atomically commit approval state. Authentication/revocation is checked for the
request; stronger cross-database revocation ordering must not be claimed.

## Idempotency, scope, and purge

All mutating operation keys bind deployment, authenticated principal, operation
kind, and canonical request content. Reusing a key with different content is a
conflict. A committed retry first authenticates, authorizes receipt disclosure,
and verifies request identity, then returns the stored result before checking
the current row revision/catalog. It cannot append history or apply twice, and
a later row edit does not invalidate the original receipt. Retain only scoped
receipt data; never echo the request, arbitrary row fields, or credentials.

Table scopes already exist and can bound the first slice. Column scopes remain
unavailable until explicitly advertised; dedicated proposal/user-approval
authority is an implementation prerequisite. Effective permission covers
requested columns plus validation/reference dependencies;
unknown dependencies fail closed. No client ambient replica/SQL fallback.

Purge removes sensitive copies from all proposal versions, differences, preview
material, linked activity, and cached receipt results. Later preview/approval
of purged evidence fails. A retry may return only a content-free `purged` result;
this is an explicit exception to returning the original full receipt. No receipt
or proposal access may resurrect purged values or expose previously authorized
fields after permission is revoked.

Terminal negative receipts use the same atomic key exclusion as successful
receipts. They retain only the scoped rejection needed to resolve the original
request, never arbitrary row snapshots. Purge redacts their payloads and preserves
the content-free marker needed to prevent late execution of an already settled
key. A later denial of receipt access keeps the client journal unresolved even
when a terminal receipt exists privately on the service.

## Integration sequence and acceptance

1. Add trusted actor/approval authority and typed, ordered history evidence to
   the existing writer; preserve existing stable history IDs.
2. Extract one shared validation/inverse planning path with truly inert preview;
   test cold stores, failed authorization and dependency changes.
3. Add proposal versions and atomic apply/receipt in the same data transaction,
   reusing conditional-write guards rather than a competing mutation engine.
4. Generate canonical DTOs and capability gates, then wire client adapters.

Required real-service cases include later unrelated edits preserved after a new
preview/version, later same-column edits and value cycles rejected, removed or
changed history rejected, exact-version edit/reject/approve races, row/dependency
races, revoked/agent approval denied, retry after a newer edit, mismatched keys,
purge/redaction, no preview effects on cold stores, and all-or-nothing multi-field
validation/history/receipt. Retry gates also cover a lost committed reply followed
by cap/auth/resource denial, and negative settlement racing a delayed original
attempt. Synthetic models alone do not demonstrate these.
