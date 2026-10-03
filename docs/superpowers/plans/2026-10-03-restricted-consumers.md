# Restricted Consumers Implementation Plan

> Execute inline with superpowers:executing-plans, with one fresh final review.

**Goal:** Provide least-privilege row access, explicit replica eligibility, durable
transactional change subscriptions and safe retained artifacts for independent consumers.

**Architecture:** Keep routing and usage attribution compatible. A focused scope module
authorizes canonical table names and guards narrow-write eligibility within the existing
checked transaction. Persistent hub-owned triggers record subscribed changes in D1;
transactional offered batches and ACKs provide at-least-once delivery. File operations
retain separate prefix authorization.

**Tech Stack:** Worker JavaScript, D1/SQLite, Bun tests, shared TypeScript contracts,
Python CLI compatibility tests, generated Swift codecs.

**Spec:** ../../page-archiver-hub-contract.md

## Global Constraints

- Build on main without changing main or deploying; use feature branch PR.
- No personal source selectors or capture schema literals in the repository.
- No new cron, webhook, queue, provider credential or usage exemption.
- Narrow metadata is denied, never partial DDL; every artifact request checks files scope.
- Limits: 30 second hold, 1 second checks, 100 events, 1 MiB delivery, decimal sequences.
- Existing broad clients and both CORS layers remain compatible.

## Review Focus

- Case/identifier tricks and body-table mismatches must fail before table reads.
- Concurrent catalog/schema changes must not bypass narrow write policy.
- Timestamp and nested trigger ordering must preserve exact accepted changes without duplicates.
- Competing polls, ACK retries and revocation during a held request cannot lose/leak events.
- File retries must not overwrite earlier bytes or execute hostile HTML on the service origin.

### Task 1: Capabilities and replica refusal

**Files:** worker/src/scopes.js, worker/src/index.js, worker/test/scopes.test.js,
tests/fixtures/hub-capabilities-contract.json, core/src/enrollment.ts,
core/test/enrollment.test.ts, core/contract/core.json and generated contracts.
**Interfaces:** sessionCapabilities(scopes) returns exact capability fields;
scopedReplicaUnsupported is the shared 403 body. Existing session identity remains.
- [ ] Add fixture and tests for full/read/narrow/file-only scopes, malformed caps,
  unsupported versions, absent-capability fallback and denial before D1 reads.
- [ ] Run focused tests red, implement capability discovery and schema refusal.
- [ ] Generate contract, run Worker/core suites and generator --check; commit.

### Task 2: Narrow row authorization and safe writes

**Files:** worker/src/scopes.js, worker/src/index.js, worker/src/write.js,
worker/test/scopes.test.js, worker/test/usage.test.js.
**Interfaces:** authorizeTable(scopes,operation,table) is a pure pre-query check;
scopedTable(db,table,write) validates eligibility through checked reads;
pushChecked accepts an optional policy callback applied to every isolated attempt.
- [ ] Add request-level tests for reads/inserts/pushes, wrong-case/body/internals/views,
  unrelated metadata/files/usage, independent grants and revoked credentials.
- [ ] Add trigger/default/generated/FK/derive/invariant/history and concurrent-policy
  tests, including generic reference rejection without denied values.
- [ ] Observe red, implement guards and bounded scoped row reads, sanitize rejections.
- [ ] Preserve full-client behavior; run full Worker/core tests; commit.

### Task 3: Transactional subscription recording

**Files:** worker/src/subscriptions.js, worker/src/index.js, worker/src/scopes.js,
worker/test/subscriptions.test.js, tests/fixtures/hub-subscriptions-contract.json.
**Interfaces:** ensureSubscriptions(db), createSubscription(db,input),
trustedSubscriptionTrigger(row) recognize exact server-owned trigger SQL.
- [ ] Test exact insert/A-to-B/delete/derive events, noop/stale/rejected rollback,
  per-subscription sequence isolation, schema changes and capacity rollback.
- [ ] Implement private operational schema and persistent transaction-owned triggers;
  admin activation is atomic and recording continues while delivery is paused.
- [ ] Observe all tests green, run existing mutation suites; commit.

### Task 4: Offered batches, long polling and ACK

**Files:** worker/src/subscriptions.js, worker/src/index.js,
worker/test/subscriptions.test.js, worker/test/usage.test.js.
**Interfaces:** handleSubscription(request,tenant,env) serves admin and consume routes;
long polls use injectable clock/sleep in tests, uncached final token-status check.
- [ ] Test competing GETs, persistent delivery across restart, empty/size boundaries,
  forged/repeated ACKs, pause/retire, revoke during wait, body/query limits and cap.
- [ ] Implement atomic compare-and-set offers and ACK receipts; no-store responses.
- [ ] Advertise durable-pull-v1 only with implemented routes; run suites and commit.

### Task 5: Immutable artifacts and safe HTML retrieval

**Files:** worker/src/index.js, worker/test/files.test.js,
tests/fixtures/hub-files-contract.json, AGENTS.md.
**Interfaces:** conditional PUT returns MIME/bytes/SHA-256, conflicts never replace;
GET/HEAD expose verified metadata and active content gets attachment/nosniff/CSP.
- [ ] Test conditional create/retry/mismatch, independent prefixes and revocation,
  hostile MIME/content, metadata-only tokens and ambiguous encoded keys.
- [ ] Implement without changing legacy authorized overwrite semantics unless a
  conditional header is supplied; run full suites and commit.

### Task 6: Integration and reviewable delivery

**Files:** canonical fixtures, generated contracts, AGENTS.md, docs.
- [ ] Exercise wrapper cap/CORS/session behavior and all existing Python/Worker/core checks.
- [ ] Mutation-test scope-before-query, transactional event recording and ACK boundary guards.
- [ ] Fresh final review; fix demonstrated important issues with regressions.
- [ ] Publish feature branch PR, send final fixture shapes to coordinating owners,
  preserve task status. Deployment remains an explicit owner decision.
