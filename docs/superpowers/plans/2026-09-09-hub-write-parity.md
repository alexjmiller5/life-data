# Hub Write Parity Implementation Plan

> **For agentic workers:** Execute this approved plan inline, using the TDD, debugging and verification skills. No subagents.

**Goal:** Equivalent safe hub writes and cell history in SQLite and D1.
**Architecture:** Per-row SQLite transactions or guarded D1 batches; reuse
existing property/provenance validation and SQL invariant definitions.
**Tech Stack:** Python stdlib, SQLite, Worker JavaScript, Bun tests.
**Spec:** ../specs/2026-09-09-hub-write-parity.md

## Global Constraints

Python stdlib only; existing Bun/Worker facilities. Synthetic data only. No secrets,
production operations, new endpoints, pushes or deployments. Preserve historical
rows and unrelated work. No caller-controlled history opt-out. Bounded D1 query
count for 500-row batches. Logs stay in ignored `.venv/work-logs`.

- [x] Baseline: `just UV_PROJECT_ENVIRONMENT=$PWD/.venv test`.
- [x] Add failing synthetic push tests in tests/test_hub_parity.py and
  worker/test/parity.test.js: canonical timestamps, ordered duplicate patches,
  required/null/provenance checks, stale replay, transactional invariants,
  contexts including user tables named changed/before/now, history and sync.
- [x] src/life_data/catalog.py and __init__.py: transactionally validate each
  accepted row, inspect actual post-write rows, run enforced invariants, write
  deduplicated history; keep local SQL/insert validation behavior intact.
- [x] worker/src/validate.js, write.js and history.js: capture validator reads and generate
  SQL assertions, then batch the sparse mutation, invariant assertions, and
  actual cell history. index.js delegates pushes; derive.js shares the commit
  seam so external-response races cannot install stale derived results.
- [x] Make worker/test/d1shim.js prepare lazily like D1, execute batch result
  SELECTs, and inject concurrent changes before batch for race reproductions.
- [x] GREEN: run focused Python/Bun regressions, then full `just ... test`
  and `just ... check`; mutation-check the timestamp and rollback guards.
- [x] Self-review against every requirement; update current AGENTS.md/README
  descriptions, commit all safe changes, and report RED/GREEN commands,
  coverage, files, SHA and limitations. No pushes or deployments.
