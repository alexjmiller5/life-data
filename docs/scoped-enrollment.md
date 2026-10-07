# Scoped device enrollment

A consumer holds its own generated credential and a user-provided service URL.
The host owns URL validation, cryptography, browser launch, polling deadlines,
cancellation and secure storage. Profile enrollment supports projected reads
and explicitly granted, revision-checked field edits. It does not
participate in replica synchronization or governance proposal/approval.

## Service configuration

`ENROLLMENT_PROFILES` is optional, service-owned JSON keyed by a public profile
ID. Each value has only `label` and `scopes`. IDs match
`[a-z][a-z0-9-]{0,63}`. Labels follow the existing enrollment label policy.
A profile has 1-64 distinct `tables:read:<table>:<column>` or
`tables:patch:<table>:<column>` grants; each table must include its `id` read.
Patch grants require reads for the same column plus `updated_at` and `hub_at`.
Identity, creation/update timestamps, hub revisions and deletion fields cannot
be patched. Internal, catalog, history, provenance and purge tables are not
eligible. Full, admin, whole-table, file and general write grants are not
accepted by this enrollment slice. Applications choose a public profile
ID and exact expected grants; customers enter only the service URL.

Profile values are installation state, never personal schema in source.
Unknown, unavailable or invalid requested profiles fail closed. Omitting a
profile retains existing full-device enrollment for existing clients. A
profile-bound fingerprint cannot be reused through legacy approval or another
profile. Start with a new candidate to reenroll. Config edits apply to future
approvals, not stored credential grants. Revoke existing credentials explicitly.

## Canonical operations and receipt

- `enrollmentApproval({fingerprint,name,profile?})` returns the existing policy
  and `/login?key=<fingerprint>&name=<encoded label>&profile=<id>` when supplied.
  Only the SHA-256 fingerprint appears in the URL, never the candidate token.
- Browser GET displays the resolved profile label and exact scopes without
  creating auth state. The same-origin POST includes `key`, `name`, `profile`
  and `profileRevision`. A changed policy returns 409. Registration checks
  the stored binding, scopes and revocation in the committing batch.
- `GET /v1/session` adds optional `enrollmentProfile: {id,revision}`.
  `EnrollmentProfileReceipt.revision` is an opaque string, exactly 64 lowercase
  hexadecimal characters. It is SHA-256 of UTF-8 JSON.stringify of
  `[id, trimmedLabel, sortedScopes]`, not a timestamp or counter. Hosts retain
  the server receipt; they do not reconstruct it from display strings.
- `EnrollmentProfileExpectation` is `{id: string, scopes: string[]}`.
  `validateDeviceSession({data,expectedProfile?})` and
  `enrollmentPollResult({reply,expectedFingerprint,expectedProfile?})` are the
  generated operation argument forms. The direct functions take `(data,
  expectedProfile?)` and `(reply,expectedFingerprint,expectedProfile?)`.
  Profile validation requires the exact scope set, valid receipt, matching
  profile, direct-read capabilities and no governance authority. Polling also
  binds the exact candidate device fingerprint. Revalidate on reconnect.
- `POST /v1/session` revokes the authenticated credential and returns
  `{logged_out:true}`. A 401 is not proof of cancellation of an unapproved link.
  Existing generation fencing and late-approval cleanup remain required.

No new transport or credentials are supplied by these pure functions. Polling
remains every 5 seconds, 300 seconds maximum, with a 65536-byte response bound.
Neither receiving a token callback nor opening the browser proves approval.

## Minimal native binding

`life-core/enrollment` exports only the pure enrollment policy functions. A
native host can bundle this entry for JavaScriptCore, with no SQL driver,
HTTP adapter, replica handlers or Life UI dependency. Generated Swift DTOs
are in `core/generated/CoreContract.generated.swift`; this file is types and
codecs, not an alternate Swift validator. The test suite bundles the minimal
entry into a realm without URL, fetch, crypto, clocks or storage, and passes a
real Worker profile approval/session through it. The app owns its small JSC
invocation and lifecycle adapter; do not copy policy into a second validator.

## Projected reads

`POST /v1/rows/pull` uses existing `{table,columns,limit?,after?,where?,since?}`.
Projected credentials must explicitly list nonempty permitted columns. The
`id` grant is required because keyset cursors expose IDs. `where` can use only
permitted columns, with the existing scalar equality semantics. Omit `since`
or send an empty string; timestamp cursors are not available to this slice.
The page size is 1-200, default 100. Response remains `{rows,next_cursor}`.
Deleted rows are returned when selected; consumers handle tombstones.

Authorization precedes data lookups. Catalogued base-table checks and the
checked-read transaction still apply. Broad and exact-table callers retain
existing behavior. Column grants do not authorize schema, options, files,
subscriptions, writes or derived values in other columns. This is not a
create-only Tasks writer contract.

## Conditional field edits

`tables:patch:<table>:<column>` authorizes only `POST /v1/rows/patch` with
`{table,id,values,expected_revision:{updated_at,hub_at}}`. Every `values` key
needs its own patch and read grants. The complete supplied revision must match
an existing live row. The ordinary catalog validation, history, atomic write
and receipt `{id,revision:{updated_at,hub_at}}` are unchanged. Missing, deleted
or stale rows return 409; never retry them automatically. A lost response is
uncertain, not evidence of failure. Read the current row before another edit.

These grants never authorize push, insert, lifecycle edits, caller history,
schema, replica synchronization or governance. Catalog invariants remain
enforced. The checked patch path additionally recognizes the exact incoming
multi-reference deletion guard template, whose deletion predicate cannot hold
for a live-row patch; arbitrary SQL and lookalike suffixes are still denied.
Writable browser approval shows the complete grants as read/update access.
Canonical enrollment validation requires `conditional_patch: revision-v1`
as well as the exact profile/scope receipt. Existing reader profiles and
accepted credentials keep their original grants until explicit reenrollment.
