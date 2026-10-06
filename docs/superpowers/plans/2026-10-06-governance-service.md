# Governance Service Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. Existing product and implementation authorization applies; no additional launch decision is required.

**Goal:** Implement the selected-inverse, propose, and authenticated online approval service with atomic versioned writes and durable original-operation settlement.

**Architecture:** Reuse the existing D1 checked writer and canonical history. Private data-store proposal/evidence/receipt state commits with the row; the separate auth store establishes principal and authority. Preview authenticates and validates without persistent effects. Advertise only the complete supported protocol.

**Tech Stack:** Worker JavaScript, shared TypeScript core, D1 transactional batches, Bun SQLite service tests, generated TypeScript/Swift contracts.

**Spec:** `docs/governance-api-contract.md`, `docs/governance-transport-contract.md`.

## Global Constraints

- One existing live row; no creation, deletion, restore, cross-row writes or offline approval.
- Keep canonical history IDs; no competing revision log or client inverse compiler.
- Reuse catalog validation, dependency guards and the conditional writer.
- User authority comes from verified enrollment; full/admin, names and claimed origin cannot supply it.
- Only success, purged or durable `not_committed` settles an original request. Auth/cap/denial remains unresolved.
- No preview initialization, usage/auth writes, derivation, delivery or durable tokens.
- No personal schema/data, credentials, infrastructure provisioning, deployment or client edits.

## Review Focus

- Negative receipt and delayed original execution must mutually exclude each other under real SQLite transactions.
- History deletion, text-equivalent numeric values and same-column value cycles must not produce fabricated reversibility.
- A response-lost approval replay must survive later row/catalog edits but reauthorize current disclosure.
- Cold stores, usage caps and revoked credentials must preserve preview purity and original outcome uncertainty.
- Purging one column must remove its copies from every proposal version and receipt without permitting key reuse.

### Task 1: Atomic original-operation receipts

**Files:** `worker/src/governance-store.js`, `worker/test/governance-store.test.js`.
**Interfaces:** Private schema initialization; canonical request identity; read terminal receipt; build receipt statement inside the existing checked transaction.

- [ ] Write and run failing real D1 tests for committed replay, key/content mismatch, rollback, both success/negative race orders, and purged retry.
- [ ] Implement immutable receipt exclusion using the same database transaction as mutation; no process lock or separate receipt commit.
- [ ] Run focused tests and mutation checks, then commit.

### Task 2: Trusted authority and pure request authentication

**Files:** `worker/src/auth.js`, `worker/src/login.js`, `worker/src/index.js`, `worker/src/usage.js`, corresponding service tests.
**Interfaces:** Server-issued principal with independently recorded propose/approve authority; read-only authentication for governance reads/previews; exact typed auth/cap failures.

- [ ] Reproduce cold/denied preview writes, operator/agent self-approval, and ambiguous retry cap/auth denial through the actual wrapped HTTP service.
- [ ] Record verified user authority only through the Access-approved browser enrollment path. Legacy credentials remain unverified; operator-created credentials cannot claim user kind.
- [ ] Keep read-only auth/cap lookup free of initialization and flush effects, then verify ordinary auth compatibility.

### Task 3: Canonical typed evidence and shared patch planning

**Files:** `worker/src/history.js`, `worker/src/patch.js`, `worker/src/governance-evidence.js`, `worker/src/purge.js`, focused tests.
**Interfaces:** Complete guarded typed evidence linked to canonical event IDs; patch preparation and rollback-only commit probe; actor/operation linkage.

- [ ] Reproduce missing/changed history, later unrelated/same-column changes, value cycles, numeric type loss and dependency races.
- [ ] Add transactional evidence to canonical history, preserve legacy unknown values and fail closed where completeness cannot be proved.
- [ ] Extract shared conditional-patch planning without changing the existing route; validate preview by a rollback-only checked batch.
- [ ] Propagate purge into private evidence, all proposal versions and terminal receipts; verify no content revival.

### Task 4: Nine governance HTTP operations

**Files:** `worker/src/governance.js`, `worker/src/governance-preview.js`, `worker/src/index.js`, `worker/test/governance.test.js`.
**Interfaces:** Exact nine documented routes and canonical argument/result envelopes; opaque signed preview binding; immutable proposal versions; atomic online approval.

- [ ] Write actual HTTP red tests for propose/review/approve/reject/edit and all version/revision/authorization/idempotency races.
- [ ] Implement service-owned preview signing, guarded proposal persistence and approval through Task 3's existing writer plus Task 1 receipts.
- [ ] Replay terminal receipts before current validation; make negative settlement exclude delayed attempts in the same transaction.
- [ ] Verify size/page limits, scope dependencies, no-store/CORS and the exhaustive status/result matrix.

### Task 5: Canonical capability and operations

**Files:** `core/contract/core.json`, generated outputs, core service adapter/handler files and focused tests.
**Interfaces:** Generated governance capability and exact operation pairs; optional supported adapter that never substitutes direct writes.

- [ ] Reproduce absent/malformed capability and unsupported adapter gating.
- [ ] Generate the agreed capability and operations, expose only after all service prerequisites are ready, and test actual HTTP conformance.
- [ ] Preserve existing advertised capabilities and keep unconfigured/legacy authority unavailable.

### Task 6: Verification and bounded runtime handoff

**Files:** Current ownership documentation and service contract status.

- [ ] Run full Worker/core/Python and static/generation checks at the combined head; mutate receipt, actor, preview, revision, evidence and purge guards.
- [ ] Obtain one independent whole-branch review, resolve substantive findings with red/green evidence, and rerun affected checks.
- [ ] Commit/push the isolated feature branch and open a reviewable PR; watch its CI. No merge/deploy or live data write is implied.
- [ ] Send root the exact source/contract hashes, operation/capability readiness, remaining configuration prerequisites and no-deployment status in the shared Note.
