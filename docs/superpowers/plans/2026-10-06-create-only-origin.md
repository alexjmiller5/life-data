# Create-only origin implementation plan

Use the approved consumer semantics and the companion source contract. No live
consumer credential or personal schema is part of the source implementation.

1. Extract checked table preparation without changing ordinary single-table
   execution. RED/GREEN tests compose two real SQLite plans into one D1 batch,
   assert late rollback, read races, companion approval checks and no helpers.
2. Review the policy/grant/request design against narrow access, purge, catalog
   and original-operation uncertainty. Resolve technical findings directly with
   owners. Keep the new HTTP capability absent until all guarantees pass.
3. Add pure policy/identity/envelope tests, then implementation. Use generic
   synthetic configuration; app-owned published vectors stay with consumers.
4. Add real HTTP service tests before handlers: exact token scopes and session
   advertisement, generated/adopted identity, existing states, denial before
   reads, atomic target/origin validation and concurrent mutation failures.
5. Compose the existing checked writer plans, honoring source/provenance safety,
   supported catalog rules, purge markers, exact post-write assertions and
   content-free failures. Do not introduce a second writer or SQL bypass.
6. Add generated canonical DTOs and portable receipt validation; strict mismatch
   rejection must keep consumers inactive on an old/unconfigured service.
7. Mutation-test auth, identity, existing/adopted, read guards and both-row
   atomicity. Run all applicable checks, independent source/security review,
   push a reviewed PR, then follow existing deployment authority and verify.
8. Hand owners exact source/contract hashes separately from deployment and
   configured grant receipts. Provisioning and consumer activation stay distinct.

Observed RED: prepareChecked export absent. Focused GREEN after extraction:
62 tests / 246 assertions across checked-group, insert and patch; all Worker
regressions at extraction: 658 tests / 3242 assertions. The real HTTP acceptance
tests initially failed on the absent service and now run in
`worker/test/creation.test.js`. Internal origin eligibility is separately tested
in `worker/test/origin-scope.test.js`. Review regressions cover SQLite identifier
aliases, origin affinity and malformed receipt framing. Eleven focused mutants
cover authorization, deterministic identity, adopted absence, captured reads,
atomic origin, purge/source protection and strict client receipt/readiness gates.
