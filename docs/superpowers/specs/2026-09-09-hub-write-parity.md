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
metadata timestamps, catalog and provenance. Replication shall not duplicate
an originating edit. Existing historical rows remain intact. Direct hub
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
