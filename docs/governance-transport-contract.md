# Governance transport contract draft

This fixes the proposed transport boundary for the operations and generated data
types in `governance-api-contract.md`. Configured Worker handlers implement these routes. Capability advertisement
and canonical client adapter integration remain pending. The released runtime
contract is unchanged. Clients keep their
injected governance API null until the service advertises the complete protocol
and the canonical adapter is available; reading this document does not enable it.

## Capability and authority

The proposed optional `/v1/session` field is `capabilities.governance`:

```ts
type GovernanceCapability = {
  protocol: "selected-inverse-proposals-v1";
  principal: Actor;
  authority: { propose: boolean; approve: boolean };
  limits: {
    maxSelectedEvents: number;
    maxChangedColumns: number;
    maxRequestBytes: number;
    maxPageSize: number;
    previewTtlSeconds: number;
  };
};
```

This proposed capability type is not yet generated. `Actor` and all operation
argument/result types already have canonical generation. Limits are positive
safe integers, supplied by the service; clients never use guessed defaults to
enable a request. Expiry in an issued preview remains authoritative. Unknown
protocols, absent capability, invalid limits, or an unsupported adapter leave
the API unavailable. There is no separate client feature flag or route discovery
from a successful ordinary row write.

Advertise the protocol only after all nine operations below and their shared
authorization, evidence, preview, atomicity, retry and purge guarantees exist.
There is no partial advertisement based on DTO availability or passing planner
tests. History without verified reversible evidence can still be displayed with
`reversible: false`, unknown typed values, and the specified unavailable reason.

The principal is an opaque service-issued credential principal, not a token
hash, display name, email or client actor assertion. Authority is service-owned
and independently revocable. `approve: true` requires verified user authority;
`full`, `admin`, table-write permission, token names and claimed origins never
provide that proof. Operator-created agent/service credentials cannot acquire
user authority by supplying a kind or profile. Legacy credentials without
recorded authority remain unavailable; do not backfill from their names.

Authority flags describe eligibility, not permission for any particular table,
field, dependency, proposal or receipt. Every operation reauthorizes its exact
resources. The initial protocol uses existing exact table scopes; it does not
advertise column scopes. Preview and receipt disclosure may require additional
read dependencies, and approval also requires write permission. Unknown
dependencies fail closed. No administrative bypass may self-approve an agent
proposal without independently established user authority.

## Exact transport mapping

All operations use authenticated JSON POST requests through the existing service
endpoint and credential seam. The body is exactly the canonical argument type;
there is no transport wrapper, client actor field or cookie-based fallback.
Responses use the corresponding generated concrete result type.

| Operation | Proposed path | Canonical request | Canonical result |
| --- | --- | --- | --- |
| `historyEvents` | `/v1/governance/history/events` | `HistoryEventsArgs` | `HistoryEventsResult` |
| `previewChanges` | `/v1/governance/preview` | `PreviewRequest` | `PreviewResult` |
| `createProposal` | `/v1/governance/proposals/create` | `CreateProposalArgs` | `ProposalMutationResult` |
| `listProposals` | `/v1/governance/proposals/list` | `ListProposalsArgs` | `ProposalsResult` |
| `getProposal` | `/v1/governance/proposals/get` | `GetProposalArgs` | `ProposalResult` |
| `editProposal` | `/v1/governance/proposals/edit` | `EditProposalArgs` | `ProposalMutationResult` |
| `previewProposal` | `/v1/governance/proposals/preview` | `PreviewProposalArgs` | `PreviewResult` |
| `approveProposal` | `/v1/governance/proposals/approve` | `ApproveProposalArgs` | `ApprovalResult` |
| `rejectProposal` | `/v1/governance/proposals/reject` | `RejectProposalArgs` | `ProposalMutationResult` |

These reads use POST to keep selections, row IDs and opaque cursors out of URL
query strings and to reuse the exact generated argument objects. They retain
read semantics. Every response has `Cache-Control: no-store`. Existing configured
CORS origin restrictions remain; authorization is never inferred from an origin.
Unknown methods and paths do not alias a known operation.

## Complete response matrix and key disposition

The following pairs are exhaustive for these nine routes. `success` must have
the exact operation-specific value shape; errors must have their required
`resolution` and conflict array. No status alone supplies a missing discriminator,
code or resolution. All unlisted combinations and malformed payloads become
`transport_error: indeterminate` after dispatch, including a valid body under
the wrong status. The adapter never repairs or guesses a response shape.

Read operations are `historyEvents`, `previewChanges`, `listProposals`,
`getProposal` and `previewProposal`:

| HTTP | Allowed result | Meaning |
| --- | --- | --- |
| 200 | `success` or `unavailable` | Completed read; absent, purged or resource-denied reads are identically unavailable |
| 400 | `unavailable` | Malformed read arguments |
| 401 | `unavailable` | Authentication failed |
| 413 | `unavailable` | Request too large |
| 429 | `unavailable` | Usage cap; includes `Retry-After` |
| 503 | `unavailable` | Protocol/storage temporarily unavailable |

A valid preview with planning conflicts is HTTP 200 `success` containing the
canonical `Preview` with no usable token, not an HTTP mutation error. Read 404,
403, 409 or 422 responses are not alternate unavailable encodings.

Mutation operations are `createProposal`, `editProposal`, `approveProposal`
and `rejectProposal`:

| HTTP | Allowed result/code | Allowed resolution | Conflict disclosure |
| --- | --- | --- | --- |
| 200 | `success` or `purged` | Not present | Not present |
| 400 | `error` / `validation_failed` | `unresolved` | Empty |
| 401 | `error` / `permission_denied` | `unresolved` | Empty |
| 403 | `error` / `permission_denied` | `unresolved` | Empty |
| 404 | `error` / `unavailable` | `unresolved` or `not_committed` | Empty |
| 409 | `error` / `proposal_changed`, `revision_changed`, `expired_preview` | `unresolved` or `not_committed` | Authorized conflicts only |
| 409 | `error` / `idempotency_conflict` | `unresolved` | Empty |
| 413 | `error` / `validation_failed` | `unresolved` | Empty |
| 422 | `error` / `validation_failed`, `history_unavailable` | `unresolved` or `not_committed` | Authorized conflicts only |
| 429 | `error` / `unavailable` | `unresolved` | Empty; includes `Retry-After` |
| 503 | `error` / `unavailable` | `unresolved` | Empty |

Ordinary absent/unsupported/inaccessible mutation resources use 404 unavailable;
401/403 describe request-level eligibility without disclosing resource existence.
Cold/incomplete governance storage or temporary unavailability uses 503. A typed
503 remains unresolved; other 5xx responses are indeterminate. Governance reads
the data store and stays capped. There is no governance prefix exemption; the
APNs auth-store-only exceptions belong to their separate contract.

A recognized error is a response to this attempt, not proof of the original
operation's outcome. For example, approval commits, its reply is lost, then an
exact retry hits the usage cap or loses authorization before receipt lookup.
The resulting 429/401/403 is `resolution: "unresolved"`; preserve the original
parked request/key, including across reload. Resource denial, history unavailability,
revision failure, an offline retry and an idempotency conflict cannot implicitly
erase earlier uncertainty either.

Only validated success, purged replay, or `resolution: "not_committed"` settles
the key. The latter is permitted only after the authorized data writer atomically
records an immutable negative receipt for the exact key/request, excluding any
late or concurrent execution. Checking that no success receipt exists is not
enough. If an original attempt wins that race, return its authorized result;
if the negative record wins, the original may never apply. Denial or inability
to perform this resolution yields `unresolved`, even for a code whose matrix
row also permits `not_committed`. A negative result cannot be promoted from a
current failure by the adapter. Settlement/disclosure honors current permission
and purge rules, and never reruns a terminal key as a fresh mutation.

The service never emits a transport discriminator. The adapter returns `offline`
only if this attempt was not dispatched; it says nothing about prior attempts.
Unexpected responses, timeouts or lost replies after dispatch are indeterminate.
Retain the exact request and key for every unresolved/transport result. Never
create a replacement approval or silently move the old request to a different
endpoint, session, principal or workspace. Preview invalidation and journal
settlement are separate decisions. The existing UI rule clearing on every
non-transport result must be updated against this generated resolution contract
before any adapter is enabled; the injected API remains null meanwhile.

## Preview and mutation implementation boundaries

Both preview routes authenticate and recheck revocation without persistent
effects, including on a cold store and on denial. They may read cap state, but
must not initialize stores, record auth usage, flush usage counters, schedule
derivations, persist previews or send notifications. Provider security/access
logging remains outside this guarantee. The current `ensureAuthReady`, token
`last_used_at` update and usage wrapper therefore cannot simply surround a
rollback-only row preview. Cold or incomplete governance storage returns
unavailable; it never creates tables from a preview request.

The service generates a verifiable opaque preview token bound as specified in
the API contract. Its signing material is service-owned, separately purposed
and absent from clients; no new secret provisioning or deployment is included
in this documentation change. Authorization and all bound evidence are checked
again when applying the proposal. The token is not an authorization grant.

Proposal versions, approval state, row changes, linked canonical history and
idempotent receipts commit together in the data writer transaction. They do not
reside in the separate auth database. Current auth is checked for each request;
cross-database atomic revocation ordering is not promised. Existing direct
conditional patch is a prerequisite to reuse, not an approval or preview alias.

The first service implementation sequence remains:

1. Trusted authority and typed, ordered canonical history evidence, including
   detection of missing or changed events and purge propagation.
2. Shared validated planning and zero-persistence authenticated preview.
3. Versioned proposals and online atomic approval/receipt, including every
   retry, denial and conflict response above.
4. Canonical capability DTO and operations, real HTTP adapter conformance,
   then capability advertisement. Root owns downstream generated integration.

The gate tests exercise the actual usage wrapper, auth path and data writer,
not a replacement mock implementation. They include cold/denied preview side
effects, exact-table/dependency restrictions, agent approval denial, retained
typed history, competing proposal mutations, changed rows/catalog/dependencies,
committed retry after a newer edit, ambiguous response reconciliation, key reuse,
purged receipt redaction, lost committed replies followed by typed cap/auth/resource
denials, negative settlement racing a delayed original, every allowed matrix pair
and status/body/resolution mismatch, and absence of the capability before readiness.
