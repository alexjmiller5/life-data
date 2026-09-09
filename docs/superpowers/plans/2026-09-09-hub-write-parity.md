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

## Review fix wave: Worker ownership

- [x] Preserve/transfer Python changes by manifest, then restore only the three
  transferred Python files to HEAD. Python I4/I5/I9 are integrated separately.
- [x] Reproduce Worker I1-I4/I6/I7 against frozen base, including actual executed
  query limits; retain identical optional history-list protocol.
- [x] Fix per-mutation dependencies, default/affinity validation, revision history
  segments, schema read assertions, and all derivation caller budgets.
- [x] Verify normal 500-row writes and 200-row provenance chunks stay bulk.
- [x] Document Workers Paid prerequisite and controller-approved I8 legacy cost.
- [x] Run full Worker suite and required static checks, review diff, commit locally
  and append exact Worker RED/GREEN evidence. Parent integrates Python and runs
  combined checks plus the supplied workerd/D1 runtime smoke.

## I4 bounded matching correction

- [x] Reproduce cyclic and reverse-attachment coalesced histories, event reuse,
  and cap rejection both before mutation and after failed-batch isolation.
- [x] Match explained transition sequences with disjoint bounded paths, retaining
  the single-transition linear fast path and genuine no-match reconciliation.
- [x] Keep history-bearing isolation rollback-only until a final atomic commit;
  report unknown as retryable history-ambiguity for every submitted row.
- [x] Align shared docs with the Python cap correction; leave Python untouched.
- [x] Verify Worker/static checks, commit with normal signing/hooks, and append
  exact evidence for parent integration and scoped runtime re-review.
