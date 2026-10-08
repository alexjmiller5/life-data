# Consumer access

How anything other than the owner's own `life` CLI and Life UI reaches a Life
Data hub. The grant grammar and the enrollment protocol are in
[scoped-enrollment.md](scoped-enrollment.md); this is the policy for using them.

## Rules

- **One credential per (caller, service) pair.** Each consumer holds a Life
  Data token minted for it alone. Never share, copy or reuse a token across
  consumers, projects or machines.
- **The consumer's project owns its credential.** A server stores it in its own
  project's secret store (for a project with a `<Project> ENV` secrets item, the
  field `LIFE_HUB_TOKEN`). A device or UI keeps it in its own secure storage.
- **Revocation touches one caller.** Revoke an enrolled credential at
  `<hub>/login/devices`, an operator-minted one with `life token revoke <name>`.
  No other consumer is affected.
- **The narrowest grants that work.** Column or whole-table grants before broad
  ones, a file prefix of its own, named streams before broad `streams:append`.
- **Consumers hold only a hub URL and their own token**, never the operator
  `HUB_TOKEN`, provider credentials or the hub's database and bucket bindings.

## Pattern A: link approval with a named profile (default)

For devices, UIs and servers. The hub operator defines the grant set once as a
profile in the service configuration `ENROLLMENT_PROFILES`
(`{"<id>": {"label": "<App>", "scopes": [...]}}`, id `[a-z][a-z0-9-]{0,63}`,
conventionally `<app>-v<n>`), then deploys. The owner approves each enrollment
in the browser, seeing the application label and every grant.

- A device or UI runs its own enrollment with the profile (life-core
  `enrollmentApproval({fingerprint, name, profile})`, or
  `life login --profile <id>` on a Mac).
- A server is enrolled by its operator in two steps:

  ```bash
  life login --profile <id> --name "<Project> server" --start pending.json
  # send the printed approval_url to the owner, who approves it
  life login --claim pending.json --wait   # prints only the token, deletes pending.json
  ```

  Pipe the claimed token straight into the project's secret store
  (`LIFE_HUB_TOKEN`), never into a file in a repo, an argument or shell history.

Changing a profile's grants changes its revision. Existing credentials keep the
grants they were approved with: enroll a new credential under the new revision,
switch the consumer to it, then revoke the old one.

## Pattern B: full-device link approval

Only for the owner's own `life` CLI (`life login`) and Life UI. A full device
credential replicates the whole estate and can approve governance proposals, so
it never goes to an application or a server.

## Pattern C: operator-minted exact token

`life token create <name> --scopes <grants>` with the operator credential, only
for a grant the hub cannot put in a profile. Every consumer grant is
profileable: `full` is pattern B, and token administration exists only as the
operator `HUB_TOKEN`, which no consumer holds. Pattern C therefore has no
consumer use; an existing operator-minted consumer token moves to pattern A at
its next rotation.

## File-prefix registry

Every file consumer and each prefix it reads or writes is listed in the
deployment's file-consumer registry (`AGENTS.md`, File service). A new file
consumer takes an unused prefix and adds its registry row in the same change
that adds its profile. Prefixes do not overlap between writers. Retained files
are listed with `GET /v1/files?prefix=` or `life files list <prefix>`.

## New consumer checklist

1. Choose the grants (grammar in [scoped-enrollment.md](scoped-enrollment.md)).
2. Add the profile to `ENROLLMENT_PROFILES` and deploy.
3. Enroll with pattern A and store the token where the consumer runs.
4. Record the consumer, its profile id and any file prefixes in `AGENTS.md`.
5. Verify: `GET /v1/session` returns the profile receipt and exactly its scopes,
   and a request outside the grants returns 403.
