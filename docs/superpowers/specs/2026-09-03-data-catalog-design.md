# Data Catalog: typed properties, enforced rules, derived columns, generated docs

**Date:** 2026-09-03
**Status:** Design approved, pending implementation plan

## Problem

life-data is schema-agnostic by design: SQLite accepts any value in any
column. There are no required fields, no select options, no relation
validation. A wrong write succeeds silently and fragments every later query.

The contract that replaces those guardrails currently lives as prose in an
agent skill. That has three failure modes:

1. **Nothing enforces it.** An agent that does not read the prose, or reads
   it and gets it wrong, writes garbage successfully.
2. **It drifts.** Enum lists exist in two places (the data and the markdown)
   with no mechanism keeping them equal.
3. **It has no single shape.** A rule about the data can be a type, an
   allowed-value list, a description, a cross-field invariant, a value that
   is computed from an external source, or a formatting convention. Today all
   of those are paragraphs, so none are machine-readable.

The same problem exists upstream in Notion, where it is worse: the live
property schema is a *superset* of what should be written, select writes
auto-create options on a near-miss, and the rules are spread across two skill
files and a separate repo's YAML prompt.

## Goals

- One home for every rule about the data, in one shape, attached to the thing
  it governs.
- Enforcement at the source, on every write path, so a violating row cannot
  be created or propagated.
- Columns whose value comes from a function (an API, a computation over other
  columns) are protected from hand edits and carry a recorded provenance.
- Machine-readable enough to drive a UI: a create form generated from the
  catalog, not hand-coded.
- Documentation generated from the catalog, so the agent-facing skill cannot
  drift from what is enforced.

## Non-goals

- **No network call and no model on the write path.** Checks are
  deterministic, offline, and reproducible. Code that touches the world
  lives in derivations and audits, which run explicitly and never gate a
  write.
- **No CHECK constraints or SQLite triggers for validation.** DDL replays
  through `_schema_log` into D1, and a validation trigger would fire on
  sync-*pulled* rows, letting a retired option wedge convergence.
- **No prevention of raw `sqlite3` writes.** Not achievable on a
  single-user machine. Addressed by containment and detection (Threat model).
- **No rule chaining, ordering, or rules triggering rules.** The engine
  evaluates four kinds and will never evaluate a fifth.
- **Not a Notion migration tool.** The catalog records where a property came
  from; moving data is separate work.

## The one line

**Checks are pure and run everywhere. Producers may touch the world and run
in exactly one place.**

A *check* answers "is this row acceptable" and must give the same answer on
every machine, every time, offline. A *producer* answers "what is this
column's value" and may call an API, take time, and fail. Confusing the two
is how a rules engine ends up with network calls on the write path and
verdicts that change when a third party is down.

Four kinds follow from that line:

| Kind | Is | Code | Runs | Blocks writes |
|---|---|---|---|---|
| `invariant` | a predicate over the data | SQL returning zero rows | client, hub, UI | yes |
| `doctrine` | prose | none | agent context | no |
| `derivation` | a function producing a column's value | a SQL expression, or a command | client, or a job | rejects *direct* writes to its column |
| `audit` | a check against the world | a command | scheduled | never; produces findings |

Arbitrary code is allowed in derivations and audits. Never in invariants.

## Concepts

Every fact about the data is one of three shapes, so each gets a table.

| Table | One row per | Answers |
|---|---|---|
| `catalog_tables` | table, stream or view | What is a row here? When does a row belong here? What does its id mean? |
| `catalog_properties` | (table, column) | What is this column, what values are legal, is it derived, and from what? |
| `catalog_rules` | named rule | Invariants, doctrine, and audits |

Plus one data table the engine maintains:

| Table | One row per | Answers |
|---|---|---|
| `provenance` | (table, row, derived column) | What was this value computed from, by what, when? |

An unlisted table or column is unconstrained, so adoption is incremental and
nothing breaks on day one. A stranger installing `life` gets an empty catalog
and a working generic sync layer.

## Schemas

Created through the normal `life table create` path so the sync columns are
injected and the DDL replays to every replica.

### catalog_tables

| Column | Type | Notes |
|---|---|---|
| `id` | text | Table or stream name |
| `kind` | text | `table` \| `stream` \| `view` |
| `purpose` | text | What a row IS, and when a row belongs here rather than elsewhere |
| `id_semantics` | text | What `id` means; the idempotency key on re-import |
| `provenance` | text | Where the data came from; what it supersedes |
| `owner` | text | Which skill or job writes this table (documentary) |
| `consumers` | text | JSON array of known readers |
| `description` | text | Longer prose |

### catalog_properties

| Column | Type | Notes |
|---|---|---|
| `id` | text | `<tbl>.<col>` |
| `tbl`, `col` | text | Required |
| `label` | text | Display name for a UI |
| `sort` | integer | Form and doc ordering |
| `type` | text | See type system |
| `required` | integer | 0/1. May not be null or empty after any write. Never 1 on a command-derived column |
| `default_value` | text | Literal, or `sql:<expr>`. Named so because `default` is a SQLite keyword |
| `options` | text | JSON array of `{v, d, sort}`: value, description, order |
| `options_sql` | text | SELECT returning one column of allowed values; unioned with `options` |
| `min_items`, `max_items` | integer | Cardinality for `multi_select` and `multi_ref` |
| `pattern` | text | Regex, full match |
| `ref_table` | text | Target table for `ref` / `multi_ref` |
| `derived_by` | text | `sql:<expr>` or `cmd:<name>`. Present = this column is derived |
| `inputs` | text | JSON array of columns the derivation reads. Hashed into provenance |
| `immutable` | integer | 0/1. Settable on insert, never changed afterwards, by anyone |
| `deprecated` | integer | 0/1. Never write |
| `description` | text | What this property is for, and how to fill it |
| `source`, `source_ref` | text | Provenance of the *definition*, e.g. `notion` / `<db_id>:<prop_id>` |

There is no `owner` column. Every case that wanted one ("maintained by
places-sync", "generated by TMDB") is a derivation, and a derivation is
enforced structurally rather than by an asserted writer identity.

### catalog_rules

| Column | Type | Notes |
|---|---|---|
| `id` | text | Slug |
| `scope` | text | `estate` \| `table` \| `column` |
| `tbl`, `col` | text | Nullable, per scope |
| `kind` | text | `invariant` \| `doctrine` \| `audit` |
| `text` | text | Human-readable statement. Also the error or finding message |
| `sql` | text | `invariant` only: a SELECT that must return zero rows |
| `cmd` | text | `audit` only: the command to run |
| `enforce` | integer | 0/1. Invariants: enforced on the write path when 1; always run by `life check` |

### provenance

| Column | Type | Notes |
|---|---|---|
| `id` | text | `<tbl>:<row_id>:<col>` |
| `tbl`, `row_id`, `col` | text | The derived cell |
| `derived_by` | text | The `derived_by` value at the time |
| `inputs_hash` | text | sha256 of the JSON of the input columns' values at the time |
| `source_ref` | text | What the command consulted, e.g. an external id plus a response hash; null for SQL derivations |
| `produced_at` | text | ISO UTC ms |

## Type system

`text` `number` `int` `bool` `date` `datetime` `json` `select`
`multi_select` `ref` `multi_ref` `url` `email` `phone`

Notion property mapping, used when migrating a database:

| Notion | life-data |
|---|---|
| title, rich_text | `text` (long-form body stays in Notion) |
| number | `number` / `int` |
| select, status | `select` |
| multi_select | `multi_select`, JSON array column |
| date | `date`, or a `date` pair for ranges |
| checkbox | `bool` |
| url, email, phone_number | `url` / `email` / `phone` |
| relation | `ref` / `multi_ref`, or a `links` row when the edge has its own properties |
| files | `text` (R2 key) or `json` array |
| formula, rollup | a `sql:` derivation, or not stored at all |
| created_time, last_edited_time | already injected as `created_at` / `updated_at` |
| people, created_by, last_edited_by, button, verification | dropped |

Select options that need attributes of their own (an icon, a parent, a
mapping) graduate to a real table, and the property becomes a `ref`.

## Derivations

A derived property declares `derived_by` and `inputs`. Its value is written
only by `life derive`, which evaluates the function and records a
`provenance` row. A direct write that changes a derived column is rejected on
every path. There is no writer identity to assert: the CLI knows whether it is
inside a derive.

**Two bodies, one gradient.**

- `sql:<expr>` for a function pure over the row and the database (category
  from tags, `date_went` from evidence links). Runs everywhere, may run at
  write time, and the hub can recompute it to verify.
- `cmd:<name>` when the world is involved (genres from TMDB, address from a
  Maps link). Runs client-side or in a job, never on the write path. The
  command is user state, referenced by name, resolved the same way
  `token_cmd` is. The product never learns the word TMDB.

Each derivation declares exactly how much reproducibility it gives up, and
for what.

**A command takes the row's inputs as JSON on stdin and returns a JSON
object.** Every key that names a derived column declaring that same command
is written, so one command may fill several columns (a Maps link resolving
`id`, `name`, `city`, `country`, `address`). The UI's "Resolve" button is a
call to this.

**Determinism means provenance, not permanence.** TMDB may answer differently
next year. That is a new fact with a new provenance row, not a violation.
What can never happen is a value with no recorded origin.

**Staleness is a pure check.** `life check` flags any derived cell whose
`provenance.inputs_hash` differs from the hash of its current inputs. Source
drift (the external source changed its answer) is an `audit`, because only a
re-fetch can know.

**Command-derived columns are never `required` at insert.** A row missing one
is valid but incomplete. "Underived" is a `life check` finding that a job
clears by running `life derive`. That is Synapse's cleanup-task pattern made
structural.

## Validation

### What is checked

Per changed row, per cataloged property, in this order:

1. `deprecated=1` and the write sets a non-null value → reject
2. `derived_by` set and the value changed outside `life derive` → reject
3. `immutable=1`, the row already existed, and the value changed → reject
4. `required=1` and the value is null or empty → reject
5. Type: numeric parses; `bool` ∈ {0,1}; `date` matches `YYYY-MM-DD`;
   `datetime` is ISO-8601 UTC with milliseconds; `json` parses
6. `select`: value ∈ options (`options` ∪ `options_sql` result)
7. `multi_select`: a JSON array, every element ∈ options, cardinality within
   `min_items`/`max_items`
8. `pattern`: full match
9. `ref` / `multi_ref`: every id exists in `ref_table` with `deleted_at IS NULL`

Then every `enforce=1` invariant scoped to a touched table must return zero
rows.

Rejection reports the table, row id, property, the rule that failed, and for
options the allowed values.

### What an invariant can see

The engine exposes two temp tables during validation:

- `changed`: the rows this statement changed, in their new state
- `before`: those same rows in their prior state

So transition rules ("status may go want→been, never been→want") are
ordinary zero-row SQL. A rule that references neither is evaluated
whole-table.

The engine injects `:now`. Rule SQL never reads the clock, so
`life check --as-of <ts>` reproduces any past verdict. `random()`,
`localtime`, and `date('now')` are rejected at compile.

### Rules compile

Every catalog edit and every DDL statement runs each invariant's SQL against
the schema with `LIMIT 0`. A rule that references a column that no longer
exists fails there, not silently at the next write. `sql:` derivations are
compiled the same way.

### Where it runs

**Client** (`life insert`, `life sql`), the two local write seams:

```
BEGIN
  t0 = now
  snapshot immutable and derived columns of cataloged tables
  execute the statement
  changed = rows in cataloged tables WHERE updated_at >= t0
  build `changed` and `before` from the snapshot
  validate changed rows; run enforce=1 invariants for touched tables
COMMIT, or ROLLBACK with the failure report
```

Identifying changed rows by `updated_at` requires no SQL parsing, because
the injected trigger already stamps every update. The snapshot is a full scan
of the immutable and derived columns only; at current sizes (largest table
4,761 rows) this is negligible. Ceiling to mark in code: scope by rowid past
~1M rows.

**Hub** (`/v1/rows/push`), same property checks and same invariants, from
the same catalog rows in D1. For a derived column that changed, the push must
carry a `provenance` row whose `inputs_hash` equals the hash of the row's
current inputs. The hub never calls the command. It verifies the attestation
is consistent, which is a pure computation.

Critical: the hub validates and rejects **per row, and continues**. The push
route is also how replica sync pushes, so failing a batch would let one stale
row wedge that replica's sync permanently. Rejected rows come back in the
response, the cursor advances, and the client prints them.

## Audits

An `audit` rule names a command. `life audit [id]` runs it, on a schedule or
by hand, and it returns findings as JSON (`{tbl, row_id, col, message}`),
which `life check` reports alongside everything else. An audit never blocks a
write. "Is this TMDB title exact", "does this place_id still resolve", "has
the external source changed its answer for this derived cell" all live here.

## Threat model

Raw `sqlite3` writes cannot be prevented. What the design guarantees:

- The CLI rejects a violating write on every sanctioned path.
- The hub quarantines it: a bad row written raw is rejected per-row on push,
  so it never reaches D1 and never reaches another machine.
- `life watch` runs the drift check, so a raw write surfaces within seconds.
- Catalog edits are append-only logged, so an allowlist cannot be quietly
  widened and forgotten.
- A derived column cannot be hand-edited past the hub, because a hand edit
  has no consistent provenance row.

Not "impossible to make", but "impossible to make and keep, or make and
hide".

## Catalog as a service

`GET /v1/catalog` returns `{tables, properties, rules}` as JSON under the
`tables:read` scope, with an ETag.

A create form is generated from it: required fields marked, selects
populated from `options` with their `d` text as helper copy, defaults
prefilled, `pattern` and cardinality checked before submit, derived fields
rendered read-only with their derivation named and a Resolve action where the
derivation is a command, and invariant failures displayed using the rule's
`text`. One definition drives the form, the CLI and the hub.

Findings from the mockup, now decisions:

- **Which columns a list view shows is a preference of the UI, not a fact
  about the data.** It lives in the UI's own config, never in the catalog.
- **Editing a legacy row that predates a rule forces the fix.** Touching the
  row makes it a changed row, and changed rows are validated in full. This is
  intended. `life check` reports legacy violations before enforcement is
  turned on, and `life infer` proposes the rules the data already follows.
- **Option descriptions are load-bearing.** They are the difference between
  an agent picking `sightseeing` as a catch-all and not.

## Commands

| Command | Does |
|---|---|
| `life property set <tbl>.<col> --type ... [--options ...] [--required] [--derived-by ...] [--inputs ...]` | Upsert a property |
| `life property list [tbl]` | Show the contract |
| `life property rm <tbl>.<col>` | Soft-delete |
| `life rule set <id> --kind invariant --tbl ... --sql ... --text ...` | Upsert a rule |
| `life derive <tbl>.<col> [--where ...]` | Run a derivation, write values, record provenance |
| `life audit [id]` | Run audits, report findings |
| `life check [--as-of <ts>]` | Every property check, every invariant, staleness, underived; report, never modify |
| `life infer [tbl]` | Propose properties and rules from existing data |
| `life doc [tbl]` | Render the catalog as markdown |
| `life table create` | Extended type syntax; writes catalog rows as a side effect |

`life infer` is how the catalog gets populated honestly: a column never null
in 2,511 rows proposes `required`; a text column with 14 distinct values
proposes `select` with those options; values all matching `^https://`
propose a `pattern`; values that are all ids in another table propose `ref`.
It proposes; a human accepts or edits.

## Generated documentation

`life doc` renders the catalog as the estate map, and that output becomes
the body of the `life-map` skill. Hand-editing stops. Enum lists exist once,
in the data. "A new table is undocumented" becomes impossible, because
writing the catalog rows is how the table is created. Streams document
identically (`kind='stream'`, record fields as properties).

What stays hand-written in the skill: the frontmatter and a short preamble on
how to read the catalog.

## Requirements (EARS)

1. The catalog shall hold at most one `catalog_properties` row per
   (table, column) pair.
2. The client shall treat a column with no `catalog_properties` row as
   unconstrained.
3. When a statement changes one or more rows in a cataloged table, the client
   shall validate every changed row before committing.
4. If a changed row violates any constraint, the client shall roll back the
   entire statement and report the table, row id, property and failed rule.
5. If a property is `required` and a changed row's value for it is null or
   empty, the client shall reject the write.
6. Where a property declares `options_sql`, the client shall evaluate it at
   validation time and union its result with `options` to form the allowlist.
7. If a `select` property's value is not in its allowlist, the client shall
   reject the write and report the allowed values.
8. If a `multi_select` property's value is not a JSON array, or contains an
   element outside its allowlist, or violates `min_items`/`max_items`, the
   client shall reject the write.
9. If a `ref` property's value is not the id of a row in `ref_table` with
   `deleted_at IS NULL`, the client shall reject the write.
10. While a property is `deprecated`, the client shall reject any write
    setting it to a non-null value.
11. If a property is derived and a statement outside `life derive` changes
    its value, the client shall reject the write.
12. If a property is `immutable` and the row existed before the statement,
    the client shall reject any write that changes its value.
13. When `life derive` writes a derived value, it shall record a `provenance`
    row with the hash of the declared inputs in the same transaction.
14. When a statement touches a table with `enforce=1` invariants, the client
    shall run each invariant's SQL and roll back if any returns rows.
15. While validating, the client shall expose the changed rows as `changed`
    and their prior state as `before` to invariant SQL.
16. The client shall report a failed invariant using that rule's `text`.
17. Rule SQL shall be read-only, shall not access the network, and shall not
    read the clock; the client shall reject at compile any rule using
    `random()`, `localtime`, or `date('now')`.
18. When a catalog row or a DDL statement is written, the client shall
    compile every invariant and every `sql:` derivation against the schema
    and reject the change if any fails to compile.
19. When the hub receives a rows push, it shall validate each row against the
    catalog independently.
20. If a pushed row changes a derived column, the hub shall reject it unless
    an accompanying `provenance` row's `inputs_hash` equals the hash of the
    row's current inputs.
21. If a pushed row fails validation, the hub shall reject that row, accept
    the remaining rows, return the rejected rows, and advance the cursor.
22. The client shall report rows the hub rejected.
23. Where a caller has `tables:read`, the hub shall serve the full catalog at
    `GET /v1/catalog`.
24. `life check` shall report every property violation, every invariant
    violation regardless of `enforce`, every derived cell whose provenance
    hash no longer matches its inputs, and every underived cell, without
    modifying data.
25. `life audit` shall run audit commands and report their findings without
    modifying data.
26. `life infer` shall propose catalog rows from existing data and shall not
    write them without confirmation.
27. `life doc` shall render the catalog as markdown deterministically.
28. No check on the write path shall invoke a language model, a command, or
    any network service.

## Testing

- TDD throughout: failing test first, then mutation-test each rule by
  breaking the implementation and confirming the test fails.
- **`tests/fixtures/validation-cases.json`** is the shared conformance
  fixture: each case is a property definition, a before row, an after row,
  an optional provenance row, and the expected verdict. Both the Python suite
  and the worker suite run it. A rule added on one side and not the other
  fails the other's suite immediately. This is the sharing mechanism; the two
  validators stay separate code.
- Sync regression: a row that becomes invalid after an option is retired must
  not block that replica's subsequent pushes.
- Provenance regression: a hand edit to a derived column, pushed with a stale
  provenance row, is rejected by the hub.
- Offline: `life sql` validates with no hub reachable.

## Build order

1. `catalog_tables` + `catalog_properties` + property validation (client and
   hub) + `GET /v1/catalog`
2. `catalog_rules` (`invariant` with `changed`/`before`/`:now`, `doctrine`)
   + rules compile + `life check`
3. Derivations: `derived_by`, `inputs`, `provenance`, `life derive`, hub
   provenance verification, staleness in `life check`
4. `audit` + `life audit`
5. `life infer`, then seed the estate and fix the drift it surfaces
6. `life doc`, regenerate `life-map`, delete the hand-maintained contracts

## Decisions and rejected alternatives

| Decision | Why |
|---|---|
| Checks pure, producers may touch the world | A verdict that depends on a third party being up is a lie about the data; and a check that only some consumers can run fractures the contract |
| Derivation instead of `owner` | Write authority by asserted identity is honor-system locally. A derived column is enforced structurally: only `life derive` writes it, and the hub verifies provenance |
| Provenance hash, not the value, is what the hub verifies | Lets the hub verify a nondeterministic process deterministically, with no network |
| Validate in the write path, not in SQLite | Trigger and CHECK DDL replays into D1 and fires on pulled rows, wedging sync |
| Two validators, one conformance fixture | Client is stdlib-only Python, hub is JS; shared runtime costs more than 80 lines twice |
| Hub rejects per row, never per batch | A batch failure wedges a replica permanently |
| Rules as SQL returning zero rows | One format, no DSL, no severity ladder. Salesforce grew four overlapping engines because each could not express the next thing; this one will not grow a fifth kind |
| `changed`/`before` temp tables | Transition rules without a DSL |
| Engine-injected `:now` | Reproducible verdicts; `--as-of` |
| Command-derived columns never required at insert | Otherwise every insert needs the network |
| Derivation commands are user state referenced by name | Same seam as `token_cmd`; the product ships mechanism, every function is the user's |
| Catalog tables prefixed `catalog_` | Avoids colliding with a user table named `rules` or `properties` |
| `enforce=1` invariants evaluated whole-table when they reference neither `changed` nor `before` | A legacy violation blocks writes until fixed or `enforce` flipped off; `life check` reports it first |

## Open questions

- Whether `life doc` fully generates the `life-map` skill body or writes into
  a marked block.
- Whether the catalog edit log is a stream or a local table.
- Whether `sql:` derivations run automatically at write time or only via
  `life derive`. Leaning automatic, since they are pure and instant.
