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
a single whole trail; bounded ordered-segment matching handles several revisions
without ordering tied timestamps. Preserve offline A->B->C as two
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

I4: Only original events absent before the request can explain new transitions.
For one transition, a linear whole-trail check is the fast path. Multiple revisions
match disjoint paths through those originals with bounded backtracking, revisiting
earlier choices for cycles and coalesced edits. An original cannot explain two
distinct updates. Cases include ABAB, ABCBC, and DBACACBADCB originals explaining
DACACBCB revisions, in either attachment order. Event IDs/timestamp ties never
invent chronology. Preserve original random IDs and all original facts; the
public optional history list shape is unchanged.

The matcher has three outcomes: proven match, exhaustively proven no-match, and
unknown because generating another state would exceed 10,000. Already-generated
states can still prove match/no-match at a zero remaining generation budget.
No-match retains the existing genuine hub/reconciliation behavior. Unknown shall
reject the entire request atomically, including earlier accepted siblings and
unprocessed rows, with zero upserts, empty hub_at, and one rejection per submitted
row in original order (including duplicate IDs): col=null, rule=history-ambiguity,
retryable=true, message="History matching budget exhausted; split revisions into
smaller requests and retry." No values, arrival stamps, originals or hub events
from that request may persist. Existing history remains unchanged. Sync retains
its push cursor; automatic splitting is not introduced.

D1 history-bearing failure isolation shall use rollback-only prefix probes before
one final accepted-sequence commit. Probes execute the same validation/history
logic and end with a deliberately failing named CHECK after user work, rolling
back all helper tables and writes. A cap reached during isolation therefore
cannot strand an earlier commit. Valid history-bearing bulk batches keep one
transaction; requests without attached originals retain ordered commit splitting.
No durable bookkeeping, new endpoint, client gate or caller logging opt-out.

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
