# Reverse references implementation plan

> **For agentic workers:** Use the executing-plans or subagent-driven-development skill with test-first implementation and actual SQLite verification.

**Goal:** Show incoming catalog relationships on a record across all three clients.

**Architecture:** Two generated core operations own metadata discovery and bounded local queries. Hosts load groups lazily and use their existing guarded record navigation.

**Tech stack:** TypeScript core, injected SQLite adapters, generated TypeScript/Swift contracts, Svelte and SwiftUI.

**Spec:** The requirements below implement the MVP record panel's referenced-by section.

## Requirements and review focus

- Add two generated core operations: referenceSources({table}) -> metadata groups and referencedBy({table,rowId,sourceTable,column,limit?,offset?}) -> one bounded group page.
- Read current live catalog ref/multi_ref definitions only. Never synthesize links/provenance data. Include live deprecated definitions because stored links still exist; hide deleted catalog rows/tables. Return source table/column/type/label and persisted skipped-table incompleteness for either the source or target table.
- Default page20/max100, one extra row for nextOffset. Parameterize all values; validate source relation targets the requested table. Source rows live-only, targets may be trashed. Preserve target primary-key collation for both scalar refs and JSON membership; malformed/nonarray JSON produces no match. Keep full row data+display labels via shared displayName; no row deduplication across distinct columns, dedupe repeated multi_ref IDs within a single source row.
- Local sources only; no HTTP, edits, history, FTS or cursor mutations. Managed state initialization through existing status helper is permitted; user data remains unchanged. Sources list does not scan source data. Query a group only when UI expands/requests it. Query returns no match for a missing target, rather than trusting a source's dangling literal.
- Snapshot catalog/status/query under existing driver transaction. SQL errors surface for that group; no fabricated empty/completeness result. Invalid persisted status also surfaces.
- Host panels lazy-load, page by returned cursor, label incomplete groups, ignore late replies after close/workspace/table/record changes, and navigate through existing fresh-row guarded opening path. Source drafts are kept on cancellation. No edit operation in the reverse panel itself.
- Test actual SQLite metadata, scalar and multi refs, repeated IDs, malformed JSON, exact membership, NOCASE target IDs, tombstones, safe pagination, foreign/removed metadata, literal injection strings, skipped status, display fallback, row updates and no user-data mutations. Add generated-contract assertions, typechecks, mutations and full project suites. Hold any client bundle until native owner is idle.

## Implementation

- [x] Observe failing metadata, paging, collation, malformed JSON, trash and contract tests.
- [x] Implement both operations and generate the shared DTOs.
- [x] Verify real SQLite behavior, invalid optional values and incomplete target identities.
- [ ] Run mutations, the full project suite, independent review and CI.
- [ ] Integrate lazy record panels in the browser and native apps after their current resource checkpoints.
- [ ] Verify real client navigation/draft preservation and update the tracked task.
