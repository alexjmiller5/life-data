# Movies and TV Shows migration: hub derivations, a derivations service, and Synapse writes to life-data

**Date:** 2026-09-04
**Status:** Design approved in conversation; implementation plan follows
**Builds on:** `2026-09-03-data-catalog-design.md` (branch `data-catalog`, merged first)

## Goal

Make the catalog real on a table people actually use: migrate the Notion
Movies (582 rows) and TV Shows (257 rows) databases into life-data as
cataloged tables whose metadata is derived from TMDB on the hub, and point
Synapse at life-data so new captures land there. Notion Movies and TV Shows
retire to Legacy.

## Non-goals

- The life UI (deferred; requirements captured in a Notion note).
- Migrating Quotes, TV Episodes, Podcasts, YouTube (tasks created instead).
- Two-way sync to Notion. life-data is authoritative; Notion is retired.
- Any TMDB code inside life-data. The hub calls a named endpoint; the
  product never learns what is behind the name.

## Components

### A. Hub derivation engine (life-data, generic product code)

Implements the spec's "derivations run on the hub" decision.

**Config.** A Worker secret `DERIVATIONS`, a JSON object mapping a derivation
name to `{ "url": "...", "headers": { ... } }`. Names are what
`catalog_properties.derived_by = "http:<name>"` refers to. The product ships
no names.

**Protocol.** `POST <url>` with body `{"tbl": ..., "id": ..., "inputs": {col: value}}`;
the endpoint returns a JSON object whose keys are column names to write, plus
an optional `_source_ref` string. Keys that are not derived columns declaring
that same name are ignored. A non-2xx response or invalid JSON leaves the
cell underived and is logged.

**When it runs.**

1. **On push.** After `/v1/rows/push` upserts the accepted rows of a table,
   for each `http:` derivation named by that table's properties, for each
   accepted row whose derived cells are missing provenance or whose
   provenance `inputs_hash` no longer matches the row's inputs, the Worker
   calls the endpoint in the background (`ctx.waitUntil`). The push response
   is not delayed by derivation.
2. **Cron sweep.** A second cron trigger (every 15 minutes) selects, per
   `http:` derived property, up to 50 rows that are underived (no live
   provenance row) or stale (`provenance.produced_at < row.updated_at` and
   the recomputed `inputs_hash` differs), and derives them. Retries after
   endpoint failures happen here.
3. **`POST /v1/derive`** `{table, ids?, col?}`: runs the derivations for the
   given rows synchronously, at most 50 ids per call, and returns
   `{"derived": n, "failed": [{id, col, error}]}`. Used by `life derive`
   on a client (which selects ids locally and calls in chunks) and by the
   migration backfill.

**What a derivation write does.** In one D1 batch: `UPDATE <tbl> SET <derived cols> = ..., updated_at = now WHERE id = ?`
and, per written column, upsert `provenance` (`id = <tbl>:<row>:<col>`,
`derived_by`, `inputs_hash`, `value_hash`, `source_ref`, `produced_at`,
`updated_at = now`, `deleted_at = NULL`). Hashes use the existing type-aware
SQL rendering (a `number` input or value binds through REAL). Replicas pull
the row and its provenance on their next sync; the client's `derived` rule
never fires because the pulled row already matches provenance.

**Validation of derived output.** The Worker runs the property checks on the
derived values (type, options, pattern) before writing; a value that fails
is not written and is logged. This keeps a misbehaving endpoint from
corrupting a locked column.

**Scopes.** New token scope `tables:write` = `/v1/rows/push` and
`/v1/derive` only (no schema push, no token routes). `full` and admin keep
everything. Synapse gets a `tables:write` token.

**Client.** `life derive <tbl>.<col> [--where <sql>]` selects ids locally
and calls `/v1/derive` in chunks of 50; requires the hub; prints totals and
failures. `life check` already reports `underived`, `stale`, `orphan`.

### B. `derivations` (new Modal service, its own repo)

Scaffolded from the `modal-service` template via the `new-project` skill.
Modal app and 1Password vault named `derivations`. Holds every external-source
function life-data may call; TMDB is the first.

- `POST /movie` and `POST /tv`, `requires_proxy_auth=True` (Modal-Key /
  Modal-Secret headers). Body per the protocol above; `inputs.id` is the
  TMDB id.
- Returns `title`, `year` (int), `release_date` (YYYY-MM-DD), `genres` (JSON
  array of TMDB genre names after aliasing), `director` (movies: crew
  Director; TV: `created_by[0]`, then crew Director, then Executive
  Producer), `cast` (JSON array, top 5 by billing), `poster_url`, and
  `_source_ref = "tmdb:<movie|tv>/<id>@<YYYY-MM-DD>"`.
- Genre aliases carried over from Synapse: Science Fiction → Sci-Fi,
  Sci-Fi & Fantasy → Sci-Fi, Action & Adventure → Action, War & Politics →
  War, Reality → Reality-TV, Talk → Talk-Show.
- Secret: `TMDB_API_KEY` via `.env.tpl`. Deploy: push to `main`, CI.
- Pure core in `src/core/tmdb.py` with no Modal imports; unit tests over
  recorded TMDB responses.

### C. Migration (user op, run with the installed CLI; nothing in a repo)

**Row id = TMDB id** (string), per the estate's ID registry. `notion_id`
(the former Notion page id, dash-stripped) is kept as an immutable column so
the Quotes → Movie and Episodes → Show relations on the Notion side still
resolve until those databases migrate.

**Tables.** `movies` and `tv_shows`, created with the typed syntax, then
properties refined with `life property set`:

| col | type | contract |
|---|---|---|
| `id` | text | required, immutable. The TMDB id. Cataloged explicitly so it can be a derivation input |
| `title` | text | derived `http:tmdb_movie` / `http:tmdb_tv`, inputs `[id]` |
| `year` | int | derived |
| `release_date` | date | derived |
| `genres` | json | derived. TMDB genres after aliasing |
| `director` | text | derived |
| `cast` | json | derived |
| `poster_url` | url | derived |
| `status` | select | required, default `Not Started`; options verbatim from Notion with descriptions (movies: Priority, Not Started, In Progress, Finished, Watched Parts, Gave Up; TV: ... Watched Some ...) |
| `tags` | multi_select | open, curated; options = Notion Tags plus the Notion genre values TMDB does not produce (movies: Coming-of-age, Animé, Mocumentary, Spanish, Sport, Concert, Cult Classic; TV: Animé, Dystopia, Classics, Mocumentary, Spanish, Sport, Game-Show, Medical, Video Game, Sitcom, Educational) |
| `date_watched` | date | open |
| `notion_id` | text | immutable |

Rules: doctrine "There is no Watched status; a watched movie is Finished";
doctrine "Priority means need to watch, not favorite"; invariant (enforce 0
until the data is clean) "a row with `date_watched` has a terminal status
(Finished, Watched Parts/Watched Some, Gave Up)".

**Steps.**

1. Resolve every Notion title to a TMDB id with a local script (TMDB search;
   exact-title match first, `(YYYY)` suffix honored, else Synapse's
   popularity + minimum-votes heuristic). Output: `resolved.json` and a
   review list of ambiguous or unresolved titles. **Alex reviews the list.**
2. Create both tables and their catalog rows; `life doc movies` shows the
   contract before any row lands.
3. Insert rows: `id`, `status`, `tags` (Notion tags plus displaced genre
   values), `date_watched`, `notion_id`, `created_at` = Notion created time.
4. Backfill derivations: `life derive movies.title` (one call derives every
   `tmdb_movie` column) and `life derive tv_shows.title`.
5. `life check` must be clean apart from expected `underived` on TMDB
   failures, which are reviewed by hand.
6. The six Quotes/Episodes relations stay resolvable through `notion_id`;
   the relations model is a follow-up task (Notion task 1 below).
7. Regenerate the `life-map` sections from `life doc`; update the
   `notion-workspace` skill (Movies, TV Shows retired); **Alex confirms**
   the move of both Notion DBs to Legacy.

### D. Synapse writes movies and TV to life-data

- New settings `LIFE_HUB_URL`, `LIFE_HUB_TOKEN` (a `tables:write` token
  named `synapse`, stored in the Synapse ENV item).
- `handle_movies_tv_logic`: resolve the extracted title to a TMDB id with
  the existing search code (kept for this alone); on no confident match,
  file the cleanup task as today and stop. Otherwise push
  `{"id", "status", "tags", "updated_at"}` to `/v1/rows/push` for `movies`
  or `tv_shows`. An existing id is an update of exactly those columns (the
  upsert only touches the columns sent), which preserves today's "update
  status if it exists" behavior. A rejected row files the cleanup task with
  the rule's message.
- `_enrich_from_tmdb` and the Genres/Director/Cast fields leave the movies
  and tv-shows sections of `databases.yaml`; Title (for search), Status, and
  Tags remain. Notion page creation for these two categories is removed.
- The Synapse Executions log keeps recording the outcome; `Created Item`
  holds the life-data row reference (`movies/<id>`) instead of a Notion URL.

### E. Notion bookkeeping

Tasks (Tasks DB, tag `Chore`, priority High, due today, linked to the
`life-data` project):

1. Decide the relations model for life-data (ref columns on the child vs
   `links` rows vs both) and how data moves between Notion and life-data;
   then replace `notion_id` on movies/tv_shows accordingly.
2. Migrate TV Episodes (2 linked shows today).
3. Migrate Quotes (4 linked movies today).
4. Migrate Podcasts and YouTube Videos with Spotify/YouTube derivations on
   the `derivations` service.
5. Migrate Tasks (Synapse's densest rules) and retire notion-automations'
   compliance reconciler.
6. Move Synapse Executions to a life-data stream.
7. Delete `databases.yaml` once every Synapse target has migrated.
8. Build the life UI (see the note).

Note (Notes DB, linked to `life-data`): "life UI: surface the rules
upfront" - what a Notion-like table view must show per column (type,
required marker, options with their descriptions as helper text, derived
columns read-only with "filled by <name> after save", invariants as live
checks beside the form, doctrine as inline hints), inline editing with the
rejection message shown at the cell, a catalog editor, and what the mockup
got right and wrong.

## Sequencing

1. Merge `data-catalog` into `main`, push (deploys the hub with the catalog).
2. Hub derivation engine on a branch; merge; push.
3. Scaffold `derivations` (**Alex: `op-project-bootstrap`, paste the new
   Modal proxy token**); push; note the endpoint URLs.
4. Write `DERIVATIONS` into the Life Data ENV item and the `synapse` token
   into the Synapse ENV item (desktop auth, Alex approves); redeploy the hub
   so the secret lands.
5. Migration steps 1-5 (**Alex: title review**).
6. Synapse change on a branch; merge; push; end-to-end test by sending one
   movie through Receptor and watching the row and its derived columns land.
7. Notion tasks and note; skills; **Alex: confirm Legacy move.**

## Requirements (EARS)

1. When the hub accepts a pushed row of a table with `http:` derived properties, it shall run the derivations for that row's underived or stale cells without delaying the push response.
2. When a derivation endpoint returns a value for a derived column, the hub shall validate it against the column's property checks and shall not write a value that fails.
3. When the hub writes a derived value, it shall write the provenance row (inputs_hash, value_hash, source_ref, produced_at) in the same batch.
4. If a derivation endpoint fails, the hub shall leave the cell underived, log the failure, and retry on the next sweep.
5. Every 15 minutes, the hub shall derive up to 50 underived or stale cells per derived property.
6. Where a caller has `tables:write`, the hub shall accept `/v1/rows/push` and `/v1/derive` and refuse every other write route.
7. `POST /v1/derive` shall accept at most 50 ids per call and report per-id failures.
8. The hub shall resolve derivation names only from its `DERIVATIONS` config and shall reject a `derived_by` name it does not know with a logged error, never a crash.
9. `life derive <tbl>.<col>` shall call the hub in chunks of 50 and report totals; it shall not compute any value locally.
10. The `derivations` service shall reject requests without valid proxy-auth headers before running.
11. The `derivations` service shall return TMDB genres after aliasing and a `_source_ref` naming the TMDB resource and fetch date.
12. When Synapse classifies an input as a movie or TV show, it shall resolve a TMDB id and push `{id, status, tags}` to life-data; it shall not create a Notion page.
13. If Synapse cannot resolve a TMDB id, it shall file a cleanup task and write nothing.
14. If the hub rejects Synapse's row, Synapse shall file a cleanup task carrying the rejection message.
15. After migration, `life check` shall report no violations for `movies` and `tv_shows` other than underived cells with a recorded TMDB failure.

## Testing

- Hub: bun tests over the D1 shim with `fetch` stubbed: on-push derive
  writes value + provenance; stale detection; endpoint failure leaves cell
  underived; output failing property checks is not written; `/v1/derive`
  chunk limit; `tables:write` scope matrix.
- Client: `life derive` against the test HTTP hub (`_Handler` gains
  `/v1/derive`).
- `derivations`: unit tests over recorded TMDB JSON for movie and TV (genre
  aliasing, director fallback, missing fields); an auth test.
- Synapse: unit tests for the new handler path (resolved / unresolved /
  rejected) with the hub mocked; existing suite green.
- End to end: one real movie through Receptor after deploy.

## Decisions

| Decision | Why |
|---|---|
| Row id = TMDB id | Estate ID registry: media uses the most universal external id; dedup by id replaces dedup by title |
| `notion_id` column kept for now | Six live Notion relations point at the old page ids; the relations model is a follow-up task (owner's call) |
| Curated genre values move to `tags` | `genres` is TMDB-authoritative and locked; nothing the owner curated is lost |
| Derived output is property-checked before writing | A locked column must not be corruptible by its own source |
| `tables:write` scope | Synapse can write rows and trigger derivations, nothing else |
| Separate `derivations` service | The owner wants no external-source code coupled to life-data; the hub knows names only |
| Push only the columns you have | The upsert touches only sent columns, so a status update never clobbers tags or date_watched |
