# Governance transport contract draft

This fixes the proposed transport boundary for the operations and generated data
types in `governance-api-contract.md`. No route or capability below is implemented
or advertised. The released runtime contract is unchanged. Clients keep their
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

Successful operations, unavailable reads and content-free purged mutation
receipts return HTTP 200 with their specified result discriminator. An absent,
purged or denied read has the same `{kind: "unavailable"}` body and status.
Authentication failure is HTTP 401: reads return unavailable; mutations return
`permission_denied` with no conflicts. Authenticated mutation denials use HTTP
403 with that same empty-conflict result.

Definitive version, revision, expired-preview and idempotency conflicts use HTTP
409 and the corresponding generated error code. Validation failures use HTTP
422 with `validation_failed`. Malformed or oversized mutation requests use
HTTP 400 or 413 with `validation_failed` and no payload-bearing conflicts;
malformed reads use the same status with an unavailable result. No unsupported
error discriminators are added by the client.

Governance reads the data store and stays subject to the existing usage cap.
At-cap responses use HTTP 429 and `Retry-After`: reads return unavailable and
mutations return the `unavailable` error with no conflicts. There is no governance
prefix exemption. The APNs auth-store-only exemptions are a separate contract.

Only a recognized protocol response can establish a definitive operation result.
An unexpected status/body, proxy response, timeout, or lost response after
dispatch is `transport_error: indeterminate`; retain the exact mutation request
and key. The adapter reports `offline` only when no dispatch occurred. The
service never emits either transport discriminator. HTTP 5xx cannot prove that a
mutation rolled back. A retry uses the original endpoint/session binding and
request; it never redirects the old operation into a replacement workspace.

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
purged receipt redaction, and absence of the capability before readiness.
