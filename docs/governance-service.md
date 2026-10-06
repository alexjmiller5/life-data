# Governance service

The Worker implements the nine JSON operations specified in
`governance-transport-contract.md`. The canonical generated capability and operations are supplied with the strict
client adapter. Hosts enable them only after a configured service advertises the
complete protocol for the current credential. No deployment or
live configuration follows from this source change.

The first supported atomic unit is an existing live row in an ordinary cataloged
base table, with static catalog validation and the existing supported local
invariant templates. Unknown SQL dependencies, derived fields, custom triggers,
foreign keys and unsupported values fail closed. Reference grants are checked
before following reference tables. Dependency snapshots are bounded at 2,000
rows; the entire operation shares a 750-statement budget.

`GOVERNANCE_DEPLOYMENT_ID` is an opaque stable service identity.
`GOVERNANCE_PREVIEW_KEY` is 32 cryptographically random bytes encoded as canonical
unpadded base64url, owned by the service and supplied as a Worker secret. Both
belong in the owning project's server configuration, never client settings or
source. Missing or malformed configuration leaves the service unavailable.
Preview tokens use AES-GCM with deployment-associated framing and bind the
principal, exact intent, row revision, differences, guarded dependencies,
proposal/version and expiry. Clients never parse them. Keep deployment identity
stable across key rotation so committed original-operation receipts remain
recoverable. Uncommitted tokens require their original signing material for
revalidation; do not discard it while requests remain unresolved.

Ordinary workspace initialization creates private operational tables. A cold
preview returns unavailable without initialization. Verified Access enrollment
records user authority; operator-minted credentials receive agent proposal
authority and cannot claim approval authority. Existing unrecorded credentials
remain unverified. Current auth is checked per request; no cross-database atomic
revocation ordering is claimed.

Proposal creation/editing persists server-derived differences only. Approval
reuses the conditional row writer, committing proposal state, all changed fields,
typed canonical history and the receipt together. Rejection is version-guarded.
Stored proposal versions are immutable. Creation/editing/rejection require
proposal eligibility and target read grants; approval additionally requires
verified user approval authority and target write grants.

Terminal receipt keys bind deployment, principal, operation and canonical request.
Positive and negative receipts share the same unique exclusion key. A negative
receipt carries no historical IDs or field details; detailed conflicts remain in
preview. A lost response followed by auth, cap or resource denial stays unresolved.
A retry returns an authorized receipt before current row/catalog validation.

A column purge removes every version of each affected proposal, redacts all of
that proposal's positive receipts, and preserves a content-free target pointer.
Receipt exclusion keys survive. A private per-target invalidation nonce revokes
previously issued preview material even if the public purge marker is removed.
These nonces do not replace row revisions. Generic schema, row, purge and catalog
SQL cannot read or mutate the private governance namespace.

Limits are service-owned: 100 selected events, 64 changed columns, 65,536 request
bytes, 100 page items and a 300-second preview lifetime. A preview too large to
fit its mutation request produces no token. Legacy history may be displayed with
unknown typed values; history pagination does not certify inverse continuity.

## Host integration

`validateDeviceSession` retains a valid optional `SessionInfo.governance` while
replica eligibility remains independent. `createGovernanceAPI(capability, transport)`
returns null for an absent/unsupported capability or absent raw transport.
`createHttpHub` supplies optional `governancePost` for browser-compatible hosts;
it preserves HTTP status, JSON body and Retry-After instead of turning non-2xx
replies into ordinary row-transport exceptions. Existing POST behavior is unchanged.

Native hosts implement `GovernanceTransport(route, body)` using the exact paths
from the shared core. Return canonical `SessionReply` with status/data and optional
retryAfterSeconds; never infer a result from a thrown HTTP error. The only extra
platform outcome is `{notDispatched: true}`, permitted solely before dispatch.
Every thrown exception after dispatch is indeterminate. The canonical adapter
validates the complete status/body/resolution matrix and exact result DTOs.

Inject the resulting API as the fourth argument of `createCoreHandlers`. Without
it, the nine operations return unavailable/unresolved results and never call the
local writer or ambient hub. Replace that API and handlers with the current
deployment/session/workspace context. Existing root-owned journals must retain
the original scope and exact request on uncertain outcomes; this module neither
persists nor clears a journal and never retries or invents replacement keys.

All nine operation argument/result pairs retain their canonical DTO shapes.
No endpoint, credential, current row snapshot, client inverse, actor assertion
or HTTP envelope is added to their operation arguments. Native/web downstream
bundles, hooks, adapter activation and release remain integration work.
