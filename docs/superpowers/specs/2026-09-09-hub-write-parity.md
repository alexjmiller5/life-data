# Generic hub write parity

The hub shall reject any pushed updated_at that is absent, null, unlisted,
not a real calendar instant, or not exactly YYYY-MM-DDTHH:MM:SS.sssZ.
This protocol requirement applies independently of catalog properties.

Each row shall retain sparse patches, merged required checks, explicit null
clearing, strict-newer LWW, and per-row rejection. Duplicate IDs are processed
in request order against earlier accepted writes. Stale/replayed writes do
not mutate rows or produce history.

Validation and persistence shall be one concurrency-safe decision. LocalHub
uses BEGIN IMMEDIATE. D1 uses a transactional batch with assertions that
recheck validation reads before mutations. Enforced invariant SELECTs run
against actual post-write state; changed and before contain the affected
row in its respective state, and now contains a fixed transaction timestamp.
Advisory rules never block. Context names must not damage user tables.
An invariant failure rolls back values, provenance and history for that row.

History shall record real accepted cell updates, excluding inserts, engine
metadata timestamps, catalog and provenance. Upgraded replicas supplying original events shall not duplicate
an originating edit. Legacy compatibility has the explicit exception below. Existing historical rows remain intact. Direct hub
derivations must also validate and record actual changes transactionally.

Use Python stdlib and existing Worker facilities. No external infrastructure,
new public endpoints, production data, credentials, or owner-specific schema.

D1 reference: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
Cloudflare documents sequential transactional batches and whole-batch rollback
on a failed statement. Application preflight without in-batch assertions is
insufficient. Use CTE contexts, not connection-persistent temporary tables.

## Approved history and rollout semantics

Preserve original random event IDs. The existing push accepts an optional history
array, never a skip-logging switch. A linear degree/connectivity check recognizes
OLD->NEW trails without ordering tied timestamps. Preserve offline A->B->C as two
events and A->B->A as two distinct events. Concurrent D->C accepts strict-newer
LWW, retains original events, and adds one hub:reconcile transition. First-sync
inserts can import original events. Stale/replayed rows create no hub events;
unseen originals still replicate. Rejections retain the push cursor and withhold
their attached events from fallback replication.

Ordinary history-table replication follows attachments so new clients work with
old servers. New servers accept clients without attachments; legacy-client
aggregate/original duplicates cannot always be identified safely. Never rewrite
old history to guess that association. Upgrade clients first where possible.
The protocol is one optional list, not a separate event API.

## Review rulings and actual-write requirements

I1/I2/I3: D1 shall check refs and dynamic options at each actual mutation,
validate materialized INSERT defaults (including derived provenance), and retain
SQLite numeric-string affinity. Updates remain sparse. Schema-derived options
shall remain valid; read assertions precede helper DDL and use SELECT CASE with
native guaranteed integer overflow to abort on mismatch (I7).

I4: An attached original event is eligible once per request until its segment
explains an accepted transition. Consume segments after successful commit, not
when planning an attempt that might roll back. Multiple ordered revisions of one
ID use their own OLD/NEW segment, while coalesced edits use a complete trail.
Tied event timestamps never determine order. Preserve original random IDs and
all original facts, including divergent replica edits; no public list-shape change.

I6/M1: Table writes and derivations require Workers Paid. Every batch statement
counts toward D1's 1,000-query invocation limit. Push isolation has 750 statements
and background derivation 200; synchronous and scheduled derivation callers
share 900, including reads outside commit. Budget exhaustion shall preserve
committed progress and explicitly report pending work for retry. Normal 500-row
writes and 200-row provenance chunks shall retain bulk operation. Keep statements
within 100 bind parameters and 100KB SQL text.

Controller I8 ruling: upgraded replicas supplying originals have guaranteed
deduplication. Optional backward-compatible pushes remain supported, including
generic direct API clients. Old or uninventoryed replicas can duplicate aggregate
and original history until upgraded; this is an accepted best-effort legacy cost,
not grounds to guess/delete events, add registries/User-Agent gates, or add an
endpoint. Client-first rollout reduces exposure. The ordinary history-table
fallback remains required for new clients talking to old Workers.

Python I4/I5/I9 and consistent sync snapshot fixes are integrated separately;
shared final behavior includes preserving pending local edits and checking actual
stored timestamps independently of catalog properties.
