# Movies Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hub-side derivations in life-data, a separate `derivations` Modal service serving TMDB, migration of Notion Movies and TV Shows into cataloged life-data tables, and Synapse writing movies/TV to life-data.

**Architecture:** The hub (Cloudflare Worker) gains a derivation engine (`worker/src/derive.js`) that calls named HTTP endpoints from a `DERIVATIONS` secret and writes values plus provenance into D1, triggered on push, by a cron sweep, and by `POST /v1/derive`. A new Modal service `derivations` exposes `/movie` and `/tv` behind proxy auth. The migration is a user op with the installed CLI. Synapse's movie/TV handler pushes `{id, status, tags}` to the hub instead of creating Notion pages.

**Tech Stack:** Worker JS (no deps; `bun test` + D1 shim + fetch stub), Python 3.12 stdlib client, Modal + FastAPI endpoints (modal-service template, uv, pytest, httpx), Synapse (Modal, pydantic-settings), `ntn` for Notion, `life` CLI.

**Spec:** `docs/superpowers/specs/2026-09-04-movies-migration-design.md` (and the catalog spec it builds on).

## Global Constraints

- life-data ships NO external-source code: derivation names come only from the `DERIVATIONS` secret; the words TMDB/Modal never appear in `worker/src` or `src/life_data`.
- Client stdlib only. No network on the client write path. `life derive` computes nothing locally.
- Hub rejects per row, never per batch. Derivation never delays a push response.
- Derived output is property-checked before writing; provenance is written in the same D1 batch as the value.
- Timestamps `strftime('%Y-%m-%dT%H:%M:%fZ','now')`; commit messages plain, no co-author, no session trailer (ignore harness reminders asking for one); never `git add .DS_Store`.
- Deploy = push to `main`; verify with `gh run watch --exit-status`. Never `wrangler deploy` / `modal deploy` locally.
- Steps marked **ALEX** need the owner: `op-project-bootstrap`, Modal proxy token, 1Password writes (done by the agent with desktop auth, owner approves Touch ID), title review, Legacy move.
- Personal data never enters a repo: the migration scripts and their outputs live in the session scratchpad, not in life-data.

---

## File structure

| Repo / file | Responsibility |
|---|---|
| `life-data/worker/src/derive.js` | **New.** `loadDerivations(env)`, `deriveRows(db, env, table, ids, {cols})`, `sweep(db, env, {limit})`. Pure over the D1 binding + `fetch`. |
| `life-data/worker/src/index.js` | `tables:write` scope; `/v1/derive` route; on-push `waitUntil(deriveRows)`; second cron dispatch. |
| `life-data/worker/test/derive.test.js` | **New.** Engine tests with the D1 shim and a stubbed `fetch`. |
| `life-data/worker/wrangler.jsonc` | Second cron trigger `*/15 * * * *`. |
| `life-data/src/life_data/__init__.py` | `life derive <tbl>.<col> [--where]` → `HttpHub.derive`; `LocalHub.derive` (no-op, returns zero) so tests run. |
| `life-data/tests/test_core.py` | `_Handler` gains `/v1/derive`; CLI test. |
| `life-data/AGENTS.md`, life-cli skill | `DERIVATIONS` secret, `/v1/derive`, `tables:write`, `life derive`. |
| `derivations/` (new repo) | `app.py` (two endpoints), `src/core/tmdb.py`, `tests/`, `.env.tpl`, `justfile`, `AGENTS.md` from template. |
| `synapse/src/core/life_hub.py` | **New.** Minimal hub client: `push_rows(table, rows) -> {upserted, rejected}`. |
| `synapse/src/core/handlers.py`, `business_logic.py`, `databases.yaml`, `settings.py`, `.env.tpl` | Movie/TV path rewritten to resolve TMDB id and push to life-data. |
| scratchpad `movies-migrate/` | `resolve.py`, `resolved.json`, `review.md`, `load.py` (user op; never committed). |

---

### Task 0: Merge and deploy the catalog

**Files:** none (git only)

- [ ] **Step 1:** In life-data: `git checkout main && git merge --no-ff data-catalog -m "Merge data-catalog: typed properties, rules, provenance, hub validation"`; run `just test && just check` on the merged tree.
- [ ] **Step 2:** `git push origin main`; `gh run list --limit 1` then `gh run watch <id> --exit-status`. The deploy workflow only runs when `worker/**` changed, which it did.
- [ ] **Step 3:** Smoke: `life sync` on this machine pushes nothing new and pulls nothing; `curl -s -H "Authorization: Bearer $LIFE_HUB_TOKEN" https://<hub>/v1/catalog | head -c 200` returns `{"tables":[],...}` (catalog empty in production until seeded).
- [ ] **Step 4:** In agent-config: `git push` (the life-cli skill commits).

---

### Task 1: Hub derivation engine

**Files:**
- Create: `worker/src/derive.js`, `worker/test/derive.test.js`
- Modify: `worker/src/index.js`

**Interfaces:**
- Produces: `loadDerivations(env) -> Map<name, {url, headers}>` (parses `env.DERIVATIONS` JSON; empty map when unset). `deriveRows(db, env, table, ids, { fetchImpl = fetch, now = new Date() }) -> { derived: number, failed: [{id, col, error}] }`. `sweep(db, env, { limit = 50, fetchImpl }) -> { derived, failed }`. All exported.
- Consumes: `propertiesFor(db, table)`, `validateRow`, `castText`, `sha256hex` from `validate.js` (export the last two if not already).

- [ ] **Step 1: Write the failing tests** (`worker/test/derive.test.js`): seed the shim with `catalog_properties` for `movies` (`id` text required, `title` text derived `http:tmdb_movie` inputs `["id"]`, `genres` json derived same name, `status` select options), `provenance`, `movies` (row `id='78'`, `status='Not Started'`, title NULL). Stub `fetchImpl` to assert the request body `{tbl:'movies', id:'78', inputs:{id:'78'}}` and the `Modal-Key` header from `env.DERIVATIONS`, returning `{title:'Blade Runner', genres:['Sci-Fi','Drama'], _source_ref:'tmdb:movie/78@2026-09-04'}`. Assert after `deriveRows`: title written, genres JSON text, two provenance rows with `derived_by='http:tmdb_movie'`, `source_ref`, `inputs_hash == sha256(json_array('78'))`, `value_hash == sha256('Blade Runner')`, `updated_at` bumped. Second test: endpoint returns 500 → nothing written, `failed[0].error` mentions 500. Third: endpoint returns `{status:'Nope'}` (a non-derived key) → ignored. Fourth: endpoint returns `title: 123` when a `pattern` property check fails → not written, in `failed`. Fifth: unknown name (`http:nope`) → `failed` with "no derivation configured", no throw. Sixth: `sweep` finds the underived row and derives it; after that, `sweep` derives nothing; then `UPDATE movies SET updated_at = '2030-...'` (inputs unchanged) → sweep re-hashes and still derives nothing; change the row's `id`-input? (id is immutable) — instead seed a second property with inputs `["status"]`, change status, and assert sweep re-derives it.
- [ ] **Step 2: Run** `cd worker && bun test test/derive.test.js` → fails to import.
- [ ] **Step 3: Implement `derive.js`**

```js
import { propertiesFor, validateRow, castText, sha256hex } from "./validate.js";

export function loadDerivations(env) {
  if (!env.DERIVATIONS) return new Map();
  const obj = JSON.parse(env.DERIVATIONS);
  return new Map(Object.entries(obj).map(([k, v]) => [k, { url: v.url, headers: v.headers ?? {} }]));
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function hashes(db, typeOf, inputs, row, col, value) {
  const casts = inputs.map((c) => castText(typeOf[c])).join(", ") || "NULL";
  const it = Object.values(await db.prepare(`SELECT json_array(${casts}) AS j`).bind(...inputs.map((c) => row[c] ?? null)).first())[0];
  const vt = Object.values(await db.prepare(`SELECT coalesce(${castText(typeOf[col], true)}, '') AS v`).bind(value ?? null).first())[0];
  return { inputs_hash: await sha256hex(it), value_hash: await sha256hex(vt) };
}

export async function deriveRows(db, env, table, ids, { fetchImpl = fetch } = {}) {
  const derivations = loadDerivations(env);
  const props = await propertiesFor(db, table);
  const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
  const byName = new Map();
  for (const p of props) if (p.derived_by?.startsWith("http:")) {
    const name = p.derived_by.slice(5);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(p);
  }
  const out = { derived: 0, failed: [] };
  for (const id of ids) {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
    if (!row) continue;
    for (const [name, cols] of byName) {
      const target = derivations.get(name);
      if (!target) { out.failed.push({ id, col: cols[0].col, error: `no derivation configured for ${name}` }); continue; }
      const inputs = cols[0].inputs ?? [];
      const body = { tbl: table, id, inputs: Object.fromEntries(inputs.map((c) => [c, row[c] ?? null])) };
      let result;
      try {
        const res = await fetchImpl(target.url, { method: "POST", headers: { "Content-Type": "application/json", ...target.headers }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`endpoint ${name} returned ${res.status}`);
        result = await res.json();
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`endpoint ${name} returned non-object`);
      } catch (e) { out.failed.push({ id, col: cols[0].col, error: String(e) }); continue; }
      const sourceRef = result._source_ref ?? null;
      const values = {};
      for (const p of cols) if (p.col in result) values[p.col] = Array.isArray(result[p.col]) || (result[p.col] && typeof result[p.col] === "object") ? JSON.stringify(result[p.col]) : result[p.col];
      const candidate = { ...row, ...values };
      const viol = validateRow(cols, row, candidate, { inDerive: new Set(Object.keys(values)) });
      if (viol.length) { out.failed.push({ id, col: viol[0].col, error: viol[0].message }); continue; }
      const stmts = [];
      const sets = Object.keys(values).map((c) => `${c} = ?`).join(", ");
      if (!sets) continue;
      stmts.push(db.prepare(`UPDATE ${table} SET ${sets}, updated_at = (${NOW}) WHERE id = ?`).bind(...Object.values(values), id));
      for (const c of Object.keys(values)) {
        const h = await hashes(db, typeOf, inputs, row, c, values[c]);
        stmts.push(db.prepare(
          `INSERT INTO provenance (id, tbl, row_id, col, derived_by, inputs_hash, value_hash, source_ref, produced_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, (${NOW}), (${NOW}), NULL)
           ON CONFLICT(id) DO UPDATE SET derived_by = excluded.derived_by, inputs_hash = excluded.inputs_hash,
             value_hash = excluded.value_hash, source_ref = excluded.source_ref, produced_at = excluded.produced_at,
             updated_at = excluded.updated_at, deleted_at = NULL`
        ).bind(`${table}:${id}:${c}`, table, id, c, `http:${name}`, h.inputs_hash, h.value_hash, sourceRef));
      }
      await db.batch(stmts);
      out.derived += 1;
    }
  }
  return out;
}

export async function underivedOrStale(db, table, prop, limit) {
  const { results } = await db.prepare(
    `SELECT t.* , p.inputs_hash AS _prov FROM ${table} t
     LEFT JOIN provenance p ON p.id = ? || ':' || t.id || ':' || ? AND p.deleted_at IS NULL
     WHERE t.deleted_at IS NULL AND (p.id IS NULL OR t.updated_at > p.produced_at) LIMIT ?`
  ).bind(table, prop.col, limit).all();
  return results ?? [];
}

export async function sweep(db, env, { limit = 50, fetchImpl = fetch } = {}) {
  const out = { derived: 0, failed: [] };
  const { results: tables } = await db.prepare("SELECT DISTINCT tbl FROM catalog_properties WHERE deleted_at IS NULL AND derived_by LIKE 'http:%'").all();
  for (const { tbl } of tables ?? []) {
    const props = await propertiesFor(db, tbl);
    const typeOf = Object.fromEntries(props.map((p) => [p.col, p.type]));
    const ids = new Set();
    for (const p of props.filter((p) => p.derived_by?.startsWith("http:"))) {
      for (const row of await underivedOrStale(db, tbl, p, limit)) {
        if (row._prov == null) { ids.add(row.id); continue; }
        const inputs = p.inputs ?? [];
        const casts = inputs.map((c) => castText(typeOf[c])).join(", ") || "NULL";
        const it = Object.values(await db.prepare(`SELECT json_array(${casts}) AS j`).bind(...inputs.map((c) => row[c] ?? null)).first())[0];
        if ((await sha256hex(it)) !== row._prov) ids.add(row.id);
      }
    }
    if (ids.size) { const r = await deriveRows(db, env, tbl, [...ids].slice(0, limit), { fetchImpl }); out.derived += r.derived; out.failed.push(...r.failed); }
  }
  return out;
}
```

`db.batch` must exist on the D1 shim: add `batch(stmts)` that runs each statement's `run()` in order inside a transaction (`BEGIN`/`COMMIT`).

If `castText` in `validate.js` does not take a second "value" argument, adapt: the value cast is `CAST(? AS TEXT)` or `CAST(CAST(? AS REAL) AS TEXT)` when the column type is `number`; factor that so `validatePush` and `derive.js` use the same helper.

- [ ] **Step 4: Wire `index.js`**: `allowed()` gains scope `tables:write` for `/v1/rows/push` and `/v1/derive`; route `POST /v1/derive` `{table, ids, col?}` → `ident(table)`, refuse more than 50 ids (400), return `deriveRows(...)`; in the push route after the upsert: `ctx.waitUntil(deriveRows(db, env, table, accepted.map(r => r.id)))` guarded by `try/catch` that logs (needs `env`/`ctx` threaded into the route; do it the way `/v1/backup` is special-cased); `scheduled()`: `if (event.cron === "*/15 * * * *") ctx.waitUntil(sweep(env.DB, env)); else runBackup(...)`; `wrangler.jsonc` `"crons": ["10 9 * * *", "*/15 * * * *"]`. Add a scope test in `push.test.js` for `tables:write`.
- [ ] **Step 5:** `cd worker && bun test`; commit "Hub derivation engine: named HTTP endpoints, on-push and sweep, POST /v1/derive".

---

### Task 2: `life derive` as a hub request

**Files:** `src/life_data/__init__.py`, `tests/test_core.py`, `AGENTS.md`, life-cli skill.

- [ ] **Step 1: Tests**: `_Handler` handles `/v1/derive` by recording the body and returning `{"derived": len(ids), "failed": []}`; test `life derive movies.title --where "status='x'"` with a local db holding 120 matching rows → three calls of 50/50/20 and printed totals; `life derive` with no hub configured errors clearly.
- [ ] **Step 2:** `HttpHub.derive(table, ids, col=None) -> dict` posting to `/v1/derive`; `LocalHub.derive` returns `{"derived": 0, "failed": []}`; CLI `derive` subparser (`ref`, `--where`) selects ids with `execute_sql` (a SELECT, read path), chunks by 50, aggregates, prints JSON, exit 1 if any failed.
- [ ] **Step 3:** AGENTS.md: `DERIVATIONS` secret shape, `/v1/derive`, `tables:write`, the 15-minute sweep; skill: `life derive` documented as a hub request; `life token create <name> --scopes tables:write`.
- [ ] **Step 4:** `just test && just check`; commit; merge to `main`; push; `gh run watch --exit-status`.

---

### Task 3: `derivations` Modal service (new project)

**Files:** new repo at `~/Desktop/coding/active-projects/derivations`.

- [ ] **Step 1:** Invoke the `new-project` skill with the `modal-service` template (description: "External-source derivation functions life-data's hub calls by name. First: TMDB movie and TV metadata."; topics per `repo-metadata`). PostHog: no. Delete the template `daily()` cron (cron budget).
- [ ] **Step 2:** `src/core/tmdb.py` (no Modal imports): `details(kind, tmdb_id, key, http=httpx) -> dict` calling `GET https://api.themoviedb.org/3/{kind}/{id}?append_to_response=credits`; `GENRE_ALIASES` from the spec; `director_for(kind, data)` (movie: crew job Director, first; tv: `created_by[0].name`, else crew Director, else Executive Producer); `cast_for(data, n=5)`; `to_row(kind, data, today) -> {title, year, release_date, genres, director, cast, poster_url, _source_ref}` (`poster_url` = `https://image.tmdb.org/t/p/w500` + `poster_path` or None; TV uses `name`/`first_air_date`). Tests over two recorded JSON fixtures (a movie, a TV show with `created_by`), aliasing, missing poster, missing director.
- [ ] **Step 3:** `app.py`: two `@app.function(secrets=[modal.Secret.from_name("derivations")]) @modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)` functions `movie(body: dict)` and `tv(body: dict)` returning `to_row(...)` for `body["inputs"]["id"]`; 404-style JSON error `{"error": "..."}` with status 422 when the id is missing or TMDB returns 404.
- [ ] **Step 4:** `.env.tpl`: `TMDB_API_KEY=op://derivations/derivations ENV/TMDB_API_KEY`. **ALEX:** run `op-project-bootstrap ./.env.tpl --repo alexjmiller5/derivations`; mint a Modal proxy auth token for the hub (Modal dashboard → Settings → Proxy Auth Tokens; the agent drives Chrome via `chrome-control` if asked) and paste `MODAL_KEY`/`MODAL_SECRET` into the `derivations ENV` item as fields `HUB_PROXY_KEY`/`HUB_PROXY_SECRET` (they are what the hub will send, not what the service reads).
- [ ] **Step 5:** `just test`; commit; push; `gh run watch --exit-status`; record the two endpoint URLs from the Modal deploy output.

---

### Task 4: Secrets wiring

- [ ] **Step 1:** `DERIVATIONS` JSON: `{"tmdb_movie": {"url": "<movie url>", "headers": {"Modal-Key": "<key>", "Modal-Secret": "<secret>"}}, "tmdb_tv": {...}}`. Store it as a field `DERIVATIONS` on the `Life Data ENV` item (desktop auth: `zsh -ic 'op-personal item edit ...'`; **ALEX approves**), then set the Worker secret: `cd worker && bunx wrangler@4 secret put DERIVATIONS` with `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` from the Life Data vault via desktop auth. This is a one-time secret write, the same way `HUB_TOKEN` was set; Worker secrets persist across deploys.
- [ ] **Step 2:** `life token create synapse --scopes tables:write` (admin token); write the value as field `LIFE_HUB_TOKEN` and `LIFE_HUB_URL=https://life-data.nqipomyrjb.workers.dev` on the `Synapse ENV` item (desktop auth, **ALEX approves**); never print the token in chat.
- [ ] **Step 3:** Verify: `curl -s -X POST $HUB/v1/derive -H "Authorization: Bearer <synapse token>" -d '{"table":"movies","ids":[]}'` → `{"derived":0,"failed":[]}` (route + scope live; table may not exist yet, which is a 500 → then verify after Task 5 step 2 instead).

---

### Task 5: Migrate Movies and TV Shows (user op)

All scripts live in the scratchpad `movies-migrate/`; inputs are the `notion-movies.json` / `notion-tv.json` dumps already there.

- [ ] **Step 1: Resolve titles.** `resolve.py`: for each Notion row, parse `Title` for a trailing `(YYYY)`; call TMDB `/search/movie` or `/search/tv` (`TMDB_API_KEY` from the AI Agent vault ref in the notion-workspace skill); pick: exact case-insensitive title (and year if given) match → else the single result → else top popularity with `vote_count >= 20` marked `ambiguous`; no results → `unresolved`. Write `resolved.json` `[{notion_id, title, tmdb_id, matched_title, year, confidence}]` and `review.md` listing every `ambiguous`/`unresolved` row with the top 3 candidates. **ALEX reviews `review.md`** and edits `resolved.json` (or replies with corrections). Rows the owner marks skip are not migrated and are listed in the final report.
- [ ] **Step 2: Create tables and catalog** (installed `life`, after Task 0 deployed):

```
life table create movies 'status:select!(Priority|Not Started|In Progress|Finished|Watched Parts|Gave Up)' \
  'tags:multi_select(All-time Favorite|Studio Ghibli|LS477|Sad|Best Movies|Coming-of-age|Animé|Mocumentary|Spanish|Sport|Concert|Cult Classic)' \
  'date_watched:date' 'notion_id:text' 'title:text' 'year:int' 'release_date:date' 'genres:json' 'director:text' 'cast:json' 'poster_url:url'
life property set movies.id --type text --required 1 --immutable 1 --label "TMDB id" --description "The TMDB movie id. Row identity; re-imports dedupe on it."
life property set movies.status --default "Not Started" --description "Priority = need to watch. There is no Watched: a watched movie is Finished." --options '[{"v":"Priority","d":"Need to watch / must watch"},{"v":"Not Started","d":"Default. Saved, not started"},{"v":"In Progress","d":"Currently watching"},{"v":"Finished","d":"Watched it. This is the watched state"},{"v":"Watched Parts","d":"Saw some of it, not finished"},{"v":"Gave Up","d":"Stopped on purpose"}]'
for c in title year release_date genres director cast poster_url; do life property set movies.$c --derived-by http:tmdb_movie --inputs id; done
life property set movies.notion_id --immutable 1 --description "Former Notion page id (dash-stripped). Keeps Quotes relations resolvable until Quotes migrate."
life property set movies.tags --description "Yours. Curated labels TMDB cannot know, incl. former genre-like values (Cult Classic, Spanish, Concert...)."
life property set movies.date_watched --description "When you finished it. Only meaningful with a terminal status."
life rule set movies-no-watched-status --scope table --tbl movies --kind doctrine --text "There is no Watched status. A watched movie is Finished; Date Watched is the date."
life rule set movies-priority-means-need --scope column --tbl movies --col status --kind doctrine --text "Priority means need to watch / dying to see. It is not a favorite marker; use tags for that."
life rule set movies-date-implies-terminal --scope table --tbl movies --kind invariant --enforce 0 --text "A row with date_watched has a terminal status." --sql "SELECT id FROM movies WHERE deleted_at IS NULL AND date_watched IS NOT NULL AND status NOT IN ('Finished','Watched Parts','Gave Up')"
life table set movies --kind table --purpose "Movies to watch or that I've watched. One row per TMDB movie." --id-semantics "TMDB movie id" --provenance "Notion Movies (retired 2026-09), Synapse captures" --owner synapse --consumers "life-map"
```

Same for `tv_shows` with `Watched Some`, TV tag options (All-time Favorite|Animé|Dystopia|Classics|Mocumentary|Spanish|Sport|Game-Show|Medical|Video Game|Sitcom|Educational), `http:tmdb_tv`, and the doctrine "TV's partial status is Watched Some, not Watched Parts". Then `life doc movies` and `life doc tv_shows` to eyeball the contract; `life sync`.

- [ ] **Step 3: Load rows.** `load.py` reads the Notion dump + `resolved.json` and prints a JSON array for `life insert movies`: `id` = tmdb id string, `status`, `tags` = Notion Tags ∪ (Notion Genres minus the TMDB-producible set after aliasing), `date_watched`, `notion_id`, `created_at` = Notion `created_time`. Duplicate tmdb ids in Notion (two pages, one film): keep the one with the more advanced status, report the pair. `life insert movies` rejects nothing (tags outside options mean the option list in step 2 is incomplete: fix the catalog, never the data). Same for `tv_shows`. `life sync`.
- [ ] **Step 4: Derive.** `life derive movies.title` (one call per `tmdb_movie` group derives every derived column) then `life derive tv_shows.title`; expect ~17 hub calls of 50. `life sync`; `life sql "SELECT count(*) FROM movies WHERE title IS NULL"` → 0 except recorded failures.
- [ ] **Step 5: Check.** `life check` → only `underived` findings for rows whose TMDB fetch failed; resolve each by hand (wrong id → fix `resolved.json`, delete the row, re-insert; TMDB missing → keep, note). `life sql` spot checks: 5 known films' genres/director look right; `SELECT status, count(*) FROM movies GROUP BY 1` matches the Notion counts (95/285/9/183/8/2).
- [ ] **Step 6: Docs.** Paste `life doc movies` / `life doc tv_shows` output into the `life-map` skill (replace nothing else); update `notion-workspace` SKILL.md Quick Reference + `references/workspace-map.md` Movies/TV Shows entries to "RETIRED, migrated to life-data `movies` / `tv_shows` 2026-09-04"; bump both skills' Last verified. **ALEX confirms** moving the two Notion DBs under the Legacy page (agent moves them with `ntn api v1/pages/<db page id> -X PATCH` parent change, or the owner drags them).

---

### Task 6: Synapse writes movies and TV to life-data

**Files (synapse repo, branch `life-data-movies`):** `src/core/settings.py`, `.env.tpl`, `src/core/life_hub.py` (new), `src/core/handlers.py`, `src/core/business_logic.py`, `src/core/databases.yaml`, tests.

- [ ] **Step 1: Tests first** (pytest, hub mocked with `httpx.MockTransport` or `respx` if already a dep; otherwise monkeypatch `life_hub.push_rows`): (a) movie input with a confident TMDB match → `push_rows("movies", [{"id": "78", "status": "Not Started", "tags": [...], "updated_at": <iso ms>}])` called once, no Notion create; (b) no TMDB match → cleanup task created, nothing pushed; (c) hub returns `rejected` for the row → cleanup task carries the rule message; (d) tv-shows category → table `tv_shows`.
- [ ] **Step 2:** `settings.py` fields `life_hub_url: str`, `life_hub_token: str`; `.env.tpl` lines `LIFE_HUB_URL=op://Synapse/Synapse ENV/LIFE_HUB_URL`, `LIFE_HUB_TOKEN=op://Synapse/Synapse ENV/LIFE_HUB_TOKEN`. `life_hub.py`: `push_rows(table, rows)` → `POST {url}/v1/rows/push` `{"table", "columns": sorted(union of keys), "rows"}` with `Authorization: Bearer`, `User-Agent: synapse`, returns the JSON.
- [ ] **Step 3:** `handle_movies_tv_logic`: `kind = "movie" | "tv"`; `tmdb_id = resolve_tmdb_id(kind, title)` (wrap existing `tmdb_search` + the exact/year/popularity rule from the migration script so Synapse and the migration agree); on None → existing cleanup-task path; else `push_rows(table, [row])`; on `rejected` → cleanup task with the message; return `f"{table}/{tmdb_id}"` as the created-item reference. Remove the `_enrich_from_tmdb` call for these two categories and the Notion `create_page`/`update_status` path for them.
- [ ] **Step 4:** `databases.yaml` movies/tv-shows: drop Genres, Director, Famous Cast Members; keep Title (instruction: resolve to the official title for TMDB search), Status (allowlist unchanged; TV gains Watched Some and Gave Up, fixing the known defect), Tags (allowlist = the catalog options from Task 5).
- [ ] **Step 5:** `just test && just check`; commit; push branch; open PR or merge to `main` per the repo's norm (push to main deploys); `gh run watch --exit-status`.
- [ ] **Step 6: End to end.** Send "watch Blade Runner 2049" through Receptor (`receptor` skill); within a minute: `life sync && life sql "SELECT id, title, status, genres FROM movies WHERE id = '335984'"` shows the row with derived title and genres; Synapse Executions shows the outcome with `movies/335984`.

---

### Task 7: Notion tasks, the UI note, memory

- [ ] **Step 1:** Create the eight tasks from the spec's section E in the Tasks DB via `ntn api v1/pages` (each: Name verbatim from the spec list, Status `To Do`, Priority `High`, Tags `Chore`, Due Date today, Project relation → `3ce03953-a8af-8119-a844-ee00f8211559`). Task 1's Notes property: "Decide: ref columns on the child table vs `links` rows vs both; how relations survive a Notion↔life-data move; then replace `notion_id` on movies/tv_shows."
- [ ] **Step 2:** Create the Notes page "life UI: surface the rules upfront" (Project → life-data) with the spec's section E content expanded: per-column affordances, inline rejection messages, catalog editor, Notion-like table view, and a short "what the mockup got right/wrong" list (mono-for-governed-values and the live rule ledger were right; the panel layout and lack of a table-first editing surface were wrong).
- [ ] **Step 3:** Update memory: `life-ui-mockup.md` (note exists, UI deferred), add `movies-migration.md` (tables, derivation names, what only Alex can do).

---

## Self-review

Spec coverage: A → Tasks 1-2; B → Task 3; C → Task 5; D → Task 6; E → Task 7; sequencing → Task 0 and the order above; EARS 1-9 → Tasks 1-2 tests; 10-11 → Task 3; 12-14 → Task 6; 15 → Task 5 step 5. Alex-only steps are marked in Tasks 3, 4, 5, 6. No task holds personal data in a repo: dumps, `resolved.json`, and `review.md` stay in the scratchpad.
