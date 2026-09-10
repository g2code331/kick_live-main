# Phase 4 · data architecture, caching and performance

Audits quoted here are reproducible: `node scripts/query-audit.mjs` regenerates
`docs/data/phase4-query-inventory.md` from the tree, and `--check` compares against
`scripts/query-audit.baseline.json`. Numbers in "Before" columns are that script's output at the
first commit of this phase; they are not estimates.

## 1. How the app gets data today, in one paragraph

Every screen owns its own `useEffect`, its own `supabase.from(...)` call, its own `setInterval` and its
own `loading` flag. There is no shared cache: `src/lib/api` (the Worker boundary) has no response cache,
`src/lib/db.ts` and the pages query Supabase directly with the caller's token, `pwa/sw.ts` deliberately
does not touch `/api/`, and `src/lib/DataLoader.ts` — the one thing in the tree that _is_ a cache — is
started by `App.tsx` and read by nobody. Live football therefore travels by polling (10 s to 5 min
depending on the component), and the one place that does have a push protocol (the Phase 3 match room) is
the one place the rest of the app cannot use, because it is match-scoped.

## 2. Before (measured)

| metric                                                                                                  | value                    |
| ------------------------------------------------------------------------------------------------------- | ------------------------ |
| PostgREST call sites in the app (`src/pages`, `src/components`, `src/contexts`, `src/lib`, `src/hooks`) | 217                      |
| … of which reads / writes / `rpc`                                                                       | 127 / 90 / 6             |
| files that talk to the database themselves                                                              | 43                       |
| distinct tables touched                                                                                 | 20                       |
| reads with no `limit` / `range` / `single` (unbounded)                                                  | 52                       |
| `select('*')` or whole-row embedded reads                                                               | 45                       |
| components that own a refetching interval                                                               | 6                        |
| places a query result is cached in memory or storage outside a component                                | 1 (`DataLoader`, unread) |
| realtime subscriptions                                                                                  | 0                        |

Per-page network cost at a cold visit (counted from the call sites, comments stripped):

| page                 | queries on mount                                     | extra while open                                                |
| -------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| any page (App shell) | 6 (`DataLoader.loadAll`)                             | 6 more every 5 min while the tab is visible                     |
| any signed-in page   | 1 (`auth.getSession`) + 1 (`profiles` `select('*')`) | on `onAuthStateChange` only                                     |
| `/` (HomePage)       | 3 in parallel                                        | + 1 every 30 s (live strip), never paused on hide               |
| `/matches`           | 1 (50 rows, joined)                                  | + 1 every 10 s when the filter is `all`/`live`                  |
| `/tables`            | 2 sequential                                         | none (recomputes the whole table in the browser on every visit) |
| `/team/:id`          | 3 sequential                                         | none, and 2 of them fan out per competition                     |
| `/news`              | 1 (paginated ✓)                                      | none                                                            |
| `/portal/fan`†       | 4 in parallel                                        | + the same 4 every 30 s, never paused                           |
| header (all pages)   | 0                                                    | 2 per search pause, 1 per notifications open, no cache          |

## 3. Findings

Numbered so the code and the report can point at them.

- **F-01 · `DataLoader` is a load generator with no readers.** `App.tsx` calls `loadAll()` on mount and
  `startAutoRefresh()`; nothing in `src/` calls `getTeams()`, `getMatches()`, `getPlayers()`,
  `getMedia()`, `getUsers()` or `subscribe()`. Six queries at every cold start and six every five minutes
  per open tab buy a cache that is never read. → the boot effect and the interval go away; the class stays
  (see "what is deliberately not deleted").
- **F-02 · one question, many fetchers.** `matches` is read at 34 sites, `teams` at 21, `players` at 18.
  Two screens that show "today's fixtures" ask two different questions with two different column lists, so
  neither can answer for the other. There is no key, so an identical query typed twice in a row is two
  round trips.
- **F-03 · no cache and no coalescing anywhere.** Supabase GETs carry `apikey` + `Authorization`, so
  neither the browser HTTP cache nor a CDN will serve them; `sw.ts` skips `/api/` on purpose;
  `src/lib/api` has no cache. A user tapping Back re-reads everything. In-flight duplicates are not merged
  either: mounting a page that shares a query with a component above it fires both.
- **F-04 · polling is per component and never pauses.** HomePage (30 s), MatchesPage (10 s), FanPortal
  (30 s), MatchControlFull/MultiMatchQueue (5 s) each keep their own timer while visible, and only
  `DataLoader` reacts to `visibilitychange`. Three tabs is three times the load; a backgrounded phone tab
  keeps asking until the OS kills it.
- **F-05 · standings are computed in the browser.** `StandingsPage` fetches every match of the competition
  with no limit and aggregates it in JS; `TeamProfile` does a variant of the same per competition;
  `MatchAutomation` does it again at finalization. Three implementations of one rule, one of them on the
  write path, disagreeing about what "finished" means: the browser code tests for
  `'completed' | 'full_time' | 'finished'` and `'finished'` alone, while `matches.status`'s CHECK list
  (KICKLIVE_FINAL_SCHEMA.sql) has no `finished` at all. A row that cannot exist is filtering out real ones.
- **F-06 · the payload is bigger than the page.** Whole-row or unbounded reads include
  `select('*')` over `players` and `match_events` per squad, `matches` per competition, and joined
  `teams!home_team_id(*)` embeds. The heaviest live path — `FanPortal` — reads 50 matches with nested team
  and competition objects, plus every active team with no limit, every 30 s.
- **F-07 · the flags that make a match trustworthy are read in three files.** `grep -rn is_locked src/` →
  `src/lib/live/protocol.ts`, `src/lib/live/api.ts`, `MatchControlCenter.tsx`. `confirmed_at` and
  `elapsed_seconds_before_pause` are read nowhere in the app at all. Meanwhile 31 of the 34 `matches` read
  sites decide "is this over?" from `matches.status` alone — which is why a fixture mid-correction and a
  frozen, finalized result render identically. The columns exist; the read side never looks.
- **F-08 · the header does the database's search work.** Two `ilike('%q%')` queries per keystroke pause,
  with a client-side filter afterwards (`m.homeTeam?.name...includes(q)`) that repeats work the SQL already
  did — and no debounce-level cache, so opening the notifications panel re-reads the same 8 results.
- **F-09 · no shared vocabulary for "when is this too old".** 10 s, 30 s, 5 min, "on mount", "on filter
  change" — six different answers to the same question, and none of them distinguish a number that is
  moving from a name that is not.
- **F-10 · `AuthContext` re-creates its value object on every render** — no `useMemo`, six derived
  booleans recomputed each time — so every consumer of `useAuth()` re-renders whenever the provider renders
  (`src/contexts/AuthContext.tsx:186`). `profile` is a `select('*')` on login and again on every
  `onAuthStateChange` event (`:34`, `:89`), which on a token refresh is a full-row read for four fields.
- **F-11 · the SPA bundle is one chunk with the portals inside it.** `App.tsx` imports 8 portals and 12
  pages statically; `TeamOwnerPortal.tsx` alone is 1505 lines and is unreachable for 95 % of visitors.
  `npm run build:web` reports 908 KiB of JS in 20 files / 7.45 MiB total. **→ §7.**
- **F-12 · 2.4 MB of brand PNG on the critical path.** `kicklive-icon.png` (2 456 662 bytes) is the
  loading spinner on every cold start, the header mark on every page and the auth-screen logo, rendered at
  32–128 px; `kicklive-wordmark.png` adds 2.1 MB. The install/manifest sizes already exist
  (`web-app-manifest-192x192.png`, `favicon-96x96.png`) but nothing small enough for an `<img>` does.
  **→ §7.**
- **F-13 · the Worker's public read routes are 501 stubs** — `GET /matches` (`cache: edge`,
  "max limit 100"), `GET /teams`, `GET /media/feed` are declared and unimplemented, so the one place a
  shared, cacheable, validated read could live is empty, and every fan's list request is an authenticated
  round trip to Postgres that no cache may serve.

## 4. Design

### 4.1 Layers, and what each one is allowed to know

```
view (page / portal)
   │  calls a hook: useLiveMatches(), useMatchesPage(filter, page), useStandings(compId), useTeamsIndex()…
   ▼
src/lib/data/queries.ts        one place per question: the select list, the bounds, the key, the tags
   │  read(key, fetcher, ttl, tags)
   ▼
src/lib/data/cache.ts          Map<string, Entry> + inflight dedup + TTL + tag index + subscribe
   │  transport per key: "supabase" (anon read, RLS) or "worker" (edge-cacheable, ETag)
   ▼
src/lib/supabase.ts  ·  src/lib/api (etag-aware)     ← the only two exits
```

Rules that keep it honest:

1. **A page may read; a page may not query.** Reads go through `src/lib/data/queries.ts`. Writes stay where
   they are for now: converting 90 write sites to the Worker is Phase 2's per-route migration, not a
   caching job, and doing it under a perf banner would hide a security change inside a perf change.
2. **The cache is keyed by the question, not the caller.** `matchList|filter=live|page=0`. Two components
   asking the same question share one request and one `Entry`.
3. **Nothing is cached that the engine owns without the engine's rule.** Live match state comes from the
   room (`useMatchRoom`), never from the list cache; the list cache's job on a live match is to show the
   right _set_ of matches, not their scores. That is what keeps §17's "one clock" invariant intact.

### 4.2 Key format and tags

`read` keys are `scope|sort|filters` — printable, stable, greppable, and derived from the fetcher's own
arguments (a `key` that is typed by hand next to a query is a bug waiting to be out of date, so
`queries.ts` builds both from one object).

Every entry carries the **tags** it must be invalidated by, and a mutation names the tags it dirties:

| mutation (today)                                 | invalidates                                                |
| ------------------------------------------------ | ---------------------------------------------------------- |
| team create/edit/reject (TeamDashboard)          | `teams`, `team:<id>`, `admin:counts`                       |
| player create/edit (PlayerCreator, squads)       | `players`, `squad:<teamId>`, `scorers`                     |
| match create/edit (MatchCreator, FixturesViewer) | `matches`, `match:<id>`, `standings:<compId>`              |
| article create/publish/delete (MediaPublisher)   | `media`, `media:<id>`, `news`                              |
| live engine event / transition / correction      | `matches`, `match:<id>` (the room itself is authoritative) |
| competition / season edit                        | `competitions`, `standings:*`, `seasons`                   |

Invalidation is targeted by design: `invalidate("squad:12")` must not clear the news cache. A
`clear()` on "the user did something" is the shape that turns a cache into a source of stale-data bugs.

### 4.3 Freshness classes (the answer to F-09)

| class     | TTL          | refetch triggers                                 | used by                                       |
| --------- | ------------ | ------------------------------------------------ | --------------------------------------------- |
| `live`    | 5 s floor    | room broadcast; timer only as a fallback         | match score/status surfaces in lists          |
| `fast`    | 30 s         | mount, tab-visible, `invalidate`, manual refresh | HomePage strip, `/matches`, FanPortal         |
| `page`    | 2 min        | mount, `invalidate`                              | news list, team/ player profiles, search      |
| `slow`    | 10 min       | mount, `invalidate`                              | teams index, competitions, seasons            |
| `session` | until reload | mount                                            | `profiles` for the signed-in user, auth hints |

A TTL is a **floor**, not a schedule: nothing re-reads a `slow` key because 10 minutes passed while the tab
was closed — that is what `persist` and a timestamp are for. Keys marked `persist: true` are mirrored to
`sessionStorage` (never `localStorage`: a roster of who-you-followed is per-device-ish, and a session
boundary is the honest lifetime) and revalidated on boot rather than fetched.

### 4.4 Live data must never look fresh when it is not

The one rule that outranks the rest: a cached response is allowed to be shown **while** it is refreshed
(stale-while-revalidate), never instead of a refresh that failed to happen. Concretely:

- every entry keeps `fetchedAt`, and consumers get `{data, ageMs, stale, error}`;
- `stale` is `true` the moment the TTL passes, so a UI that shows a score can say "· updated 3 min ago";
- a failed refresh keeps the old data **and** sets `error` — the caller decides whether to dim it;
- `useMatchRoom` (Phase 3) bypasses this cache entirely and owns the fan-side ladder: WS → SSE → polling,
  with its own 20 s staleness budget. The list cache's `live` class is only for the set of matches.

### 4.5 Deduplication and coalescing

- in-flight `Promise` per key (two mounters, one request);
- `minIntervalMs` per key (a component that mounts twice in one React pass cannot double-fire);
- a shared ticker for the polling keys, so 3 live surfaces on one page = 1 timer, not 3;
- `AbortSignal` handed to the transport so navigating away mid-read does not leave a stale `setState`
  behind (and does not cancel another subscriber's identical request — the abort only drops the caller).

### 4.6 Pagination and limits

NewsPage already pages with `.range()`; the pages that do not get a bounded, load-more hook instead of an
unbounded read: `/matches` (50 rows with three joins → 20 + cursor), FanPortal's `teams` (no limit → 100 +
`count: "estimated"`), TeamProfile's per-competition match loop (N+1 → one query per page of results),
and the console's squad read (`players` per two teams → `limit(60)`). The `unboundedReads` count in the
baseline is the ratchet: 52 now, and it may only go down.

### 4.7 What the Worker adds, and what it must not be used for

`GET /api/matches`, `GET /api/teams`, `GET /api/media/feed` become real handlers, because those three are
the reads where an edge cache is a _correct_ answer to "who is allowed to see this" (public, no per-user
content) and where validation belongs (`limit ≤ 100`, known status vocabulary, no `select('*')` in a URL).
They are anonymous and `public, max-age=30, s-maxage=60` + ETag/`If-None-Match` → 304, which is the only
revalidation mechanism this app can have at all (F-03). The client prefers them when a Worker is configured
and falls back to the Supabase read otherwise, and **which transport answered is a number in the
diagnostics panel** — a fallback is a documented behaviour, not a hidden one.

What stays off the Worker: per-user reads (already correct under RLS), anything per-row the edge must not
cache, and every write (Phase 2's route-by-route migration).

### 4.8 Database and indexes

No schema change without a measurement. Applied: `supabase/migrations/20260910120000_phase4_read_aggregates.sql`
— three read aggregates (`kicklive_is_final_status`, `kicklive_competition_standings`, `kicklive_squad_sizes`),
`SECURITY INVOKER` so RLS still decides which rows enter them, `search_path` pinned, `execute` granted to
`anon`/`authenticated` after a `revoke all from public`, `begin;…commit;`, a verification block that raises,
and `notify pgrst`. That is the whole change: no table, no column, no row, no policy.

**Not applied: indexes.** `node scripts/query-audit.mjs --explain` prints an
`explain (analyze, buffers, settings)` for each canonical read plus the `create index` it would justify, and
§5 of the migration carries that same six-name list as comments. The names are checked against each other by
test (`tests/unit/query-ratchet.test.ts`), because two lists that drift are two lists nobody applies. Whether
each one is added is decided by its plan — a 60-row `matches` table does not need four indexes, a season with
3 000 of them does — and this environment has no database to plan against, which is stated in §6 rather than
argued away.

### 4.9 What is deliberately not deleted

`DataLoader.ts` keeps its file and its API (`loadAll`, `subscribe`, `getMatches`, …) with a header
explaining that `App.tsx` no longer starts it, because F-01 is a claim about the current tree — if a portal
turns out to want a global team index, the loader is the shape of the answer and the new cache is where it
should live. The 10 superseded `MatchControl*` variants and `EventModal.tsx` stay exactly as Phase 3 left
them; the `matches.status = 'finished'` filter bug (F-05) is **not** silently fixed inside a perf phase in
files nobody renders — it is listed here so the deletion decision covers it.

## 5. After — the layer as built

`node scripts/query-audit.mjs` again, with the same definitions (regenerate §2's table with `--write`):

| metric                                           | before | after |
| ------------------------------------------------ | ------ | ----- |
| PostgREST call sites in `src/`                   | 217    | 211   |
| files that talk to the database directly         | 43     | 32    |
| reads with no `limit`/`range`/`single`           | 52     | 39    |
| whole-row reads that are not a single-row lookup | 45     | 32    |
| components owning a refetching interval          | 6      | 2     |

The site count is not the interesting number, because 26 of the 211 now live in
`src/lib/data/queries.ts` — the pages' own queries went from 26 to 0 while the layer gained theirs. The two
surviving pollers are `MatchControlFull.tsx` (superseded, unreachable since Phase 3) and
`DataLoader.ts` (started by nobody, counted because the interval is still in the file). What is left in the
32 unbounded reads is overwhelmingly the legacy admin screens and the superseded variants, which this phase
does not own.

What a fan's visit costs now:

| screen         | cold load                               | warm (Back/Forward, second visitor) | while open                              |
| -------------- | --------------------------------------- | ----------------------------------- | --------------------------------------- |
| any page       | 1 (`auth.getSession`) + 1 (`profiles`)  | same                                | nothing                                 |
| `/`            | 3 keys, in parallel                     | 0 reads, served from cache          | 1 read / 30 s (the strip only)          |
| `/matches`     | 1                                       | 0                                   | 1 read / 30 s, `filter`-keyed           |
| `/tables`      | 2 (competition index is `slow`, cached) | 0–1                                 | none                                    |
| `/team/:id`    | 5 keys, one per question                | 0                                   | none                                    |
| `/news`        | 1 per page                              | 0 for a page already read           | none                                    |
| `/portal/fan`† | 4 keys                                  | 0                                   | 1 read / 30 s for the match window only |
| header search  | 1 per distinct query                    | 0 for a query already typed         | none                                    |

Six `DataLoader` queries per cold start and six per five minutes per visible tab are gone for every screen,
which is where most of that reduction is.

Modules, and what each is for:

| module                        | role                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/lib/data/cache.ts`       | the `Map`: TTL, in-flight coalescing, `minIntervalMs`, tags, `sessionStorage` mirror, identity binding, armed keys |
| `src/lib/data/context.ts`     | `DataCtx`, the `QuerySpec` shape, `runQuery`, `rows()`/`one()` error unwrapping, `isMissingOnServer`               |
| `src/lib/data/queries.ts`     | every public read: columns, bound, key, tags, class — 22 specs, all pinned bounded and tagged by test              |
| `src/lib/data/useResource.ts` | `useQuery` (SWR + `poll` + `enabled` + `refetch`), `readOnce`, `invalidate`                                        |
| `src/lib/data/ticker.ts`      | one `setInterval` for the whole app; paused while hidden; catches up once on return                                |
| `src/lib/data/freshness.ts`   | the five classes, the status vocabulary from the schema's CHECK list                                               |
| `src/lib/data/standings.ts`   | the table rule, once, shared by `/tables`, `/team/:id` and the SQL fallback                                        |
| `src/lib/data/perf.ts`        | the counters: reads, hits, coalesced, stale serves, per-key ages, slowest read                                     |

Deliberate limits of this unit, stated as such:

- **Writes were not touched.** 92 of the call sites are still pages writing to Supabase directly; each moves
  when its Worker route exists (Phase 2's table), and invalidation was added at the two places that write
  rows the cached reads show (`FixturesViewer`'s reshuffle, the console's sequence advance).
- **`AdminPortal`'s seven-query dashboard load is still seven queries.** It is an admin screen, per-identity,
  mounted on demand rather than on every visit; folding it into one `adminOverview` key is a small, separate
  change and mixing it in here would have made the diff harder to review than the win is worth.
- The standings and squad-count specs call `kicklive_competition_standings` / `kicklive_squad_sizes` and fall
  back to the browser rule **until §6's migration is applied to the project** — it is written, not executed;
  this sandbox has no Postgres. The fallback is counted in the diagnostics, and `42501` does **not** fall
  back: a refusal is not the same as an absence, and the test for that distinction is why the fallback
  matcher matches codes rather than substrings.

## 6. The migration, and the one honest gap

`20260910120000_phase4_read_aggregates.sql` exists and is _not_ applied anywhere, because there is nothing
here to apply it to. What was verified instead:

| property                          | how it is verified here                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the SQL rule = the client rule    | `tests/unit/phase4-data.test.ts` parses the function bodies and compares the status list, the 3/1/0 points, the tie-break ladder, the participant set and the `active`-club filter against `src/lib/data/standings.ts`                                            |
| output shape matches `fromSqlRow` | same file, against the declared `out` parameters, in order                                                                                                                                                                                                        |
| no privilege widening             | INVOKER (not DEFINER), pinned `search_path`, `revoke all from public` before `grant execute`, all asserted in the test and again inside the migration                                                                                                             |
| additive only                     | no `create/alter/drop table`, no `update`, no `delete` — asserted over the comment-stripped file                                                                                                                                                                  |
| no unmeasured index               | every `create index` line is a comment, and the six names match `--explain`'s candidates                                                                                                                                                                          |
| syntax                            | **not verified.** No `psql`, no `pg` parser in this sandbox (`libpg-query` does not install here), and `npm run ci:install` has no SQL step. The file was reviewed by hand, statement by statement; the first real execution of it is a reviewable act on staging |
| it does not hang a deploy         | `notify pgrst, 'reload schema'` so the new RPCs resolve, and the client's `isMissingOnServer` fallback covers the window before it lands                                                                                                                          |

Until it is applied, `/tables` and `/team/:id` are correct through the browser rule and `/teams` through the
counted fallback — nothing in the app depends on the functions existing. That asymmetry is on purpose: a
performance migration must not be the reason a page stops working.

† `src/pages/portals/FanPortal.tsx` is migrated and works, but no `<Route>` in `src/App.tsx` has ever
rendered it — the screen is unreachable in the shipped app. Its reads are listed because the cost is real
whenever a route is added, and because Phase 4 changed the file; it is not evidence that anyone pays that
cost today, and it is why the row is marked rather than counted as a win.

---

## 7. Frontend load, as built (unit 4)

Two findings, one mechanism each, and both measurable from the repo without a browser.

### 7.1 Brand art (F-12)

`public/kicklive-icon.png` is the **master**: 1254², 2 456 662 bytes, and `shared/branding.ts` names it as
the source `branding.mjs` derives `.ico`, `.icns`, hicolor PNGs and PWA icons from. That is the correct file
for that job and the wrong file for a tab favicon, which is what it was: `index.html` linked it as `rel=icon`,
the header drew it at 80 px, three auth screens and the boot splash at 128 px, and `AppBackground` tiled it at
1.5 % opacity — ~4.9 MB of PNG downloaded and then scaled _down_ by 6–40× before first paint.

`scripts/brand-assets.mjs` now writes the sizes the UI draws into `public/brand/`, using the repository's own
PNG codec (`scripts/lib/png.mjs`, the file `branding.mjs` already uses, so this adds no dependency and no
second encoder). The masters are untouched and still in place.

| file                                       | drawn as                                               | before                    | after              |
| ------------------------------------------ | ------------------------------------------------------ | ------------------------- | ------------------ |
| `brand/icon-32.png`                        | tab favicon (`index.html`)                             | 2 456 662 B               | 2 422 B            |
| `brand/icon-64.png` + `public/favicon.svg` | the SVG icon                                           | 330 091 B                 | 10 649 B + 7 777 B |
| `brand/icon-192.png`                       | header mark, boot splash, auth screens, route fallback | — (same 2 456 662 B file) | 32 106 B           |
| `brand/pattern-192.png`                    | the 1.5 % background tile                              | — (same file again)       | 17 130 B           |
| `brand/wordmark-312.png`                   | header wordmark                                        | 2 160 185 B               | 24 790 B           |
| **what a cold visit pulls**                |                                                        | **4 946 938 B**           | **87 097 B**       |

The `before` column counts each file once (a browser caches by URL, so the master was fetched once and
re-used by six call sites); the `after` column is the sum of the five files a page now asks for. 98.2 %
smaller, and the largest remaining file is 31 KiB.

Three things make that defensible rather than merely smaller:

- **It is derived, not hand-shrunk.** `npm run brand:assets` regenerates every byte from the master;
  `brand:assets:check` fails if the committed files differ from what the pipeline writes, and `gates.mjs`
  gate 5 runs the check. Editing the master without regenerating is a failed gate, not a slow discovery.
- **The encoder proves what it wrote.** `decodePng(encodePng(x))` is compared pixel-for-pixel with the pixels
  the pipeline chose to keep, per target, before a byte is committed. The codec also gained the two changes
  that made this reduction possible without a palette: colour type follows the pixels (the master carries no
  alpha, and writing RGBA anyway cost a quarter of every file) and Paeth joins the per-row filter choice.
- **The loss is chosen per file and recorded.** `bits` is kept bits per channel: 8 for the favicons (a tab
  icon is seen at 1:1), 6 for the header mark and wordmark, 4 for a layer rendered at 1.5 % opacity. The
  ceilings (`maxBytes` per file, 96 KiB for everything a first paint pulls) live in the pipeline, so the
  check reports a doubled asset as a failure instead of a surprise in the release notes.

`branding.mjs check`'s `public.heavy-asset` warning used to infer "served on first paint" from a file's size,
which after this change would have been a false statement about the masters. It reads the references now: a
heavy file _loaded by a page_ warns, a heavy file nothing loads reports as unreferenced, and a path a page
references with no file under `public/` is an error (`public.missing-asset` — verified by deleting a derived
file and watching the check fail, then restoring it).

### 7.2 Route split (F-11)

`React.lazy` on every route except `HomePage` (which is what the first paint renders, so it stays a static
import), one `<Suspense>` boundary around `<Routes>` with the shell above it, and a fallback
(`src/components/RouteFallback.tsx`) in the app's existing loading language that reuses `brand/icon-192.png` —
already downloaded by the header, so waiting for a chunk costs no bytes. `prefers-reduced-motion` still
suppresses the animation, because a new animation inherits that rule.

`tools/vite-shared.ts` gained `kickliveManualChunks`, spread by both browser builds:
react / react-dom / react-is / scheduler / use-sync-external-store → `vendor-react`, `@supabase/*` →
`vendor-supabase`. That is a _cache-lifetime_ change, not a byte reduction: a copy edit used to invalidate
190 KB of framework for every visitor. React stays one chunk on purpose — splitting `react` from `react-dom`
is the classic way to ship two copies of React and get "Invalid hook call" at runtime, which is why
`bundle-budget.mjs` counts `Symbol.for("react.element")` occurrences in the built chunks rather than trusting
the config.

`scripts/bundle-budget.mjs` measures what a fan downloads, and `npm run build:web` enforces it after every
build:

| metric (from `node scripts/bundle-budget.mjs`)             | before  | after       |
| ---------------------------------------------------------- | ------- | ----------- |
| JS a visitor needs to render `/` (raw)                     | 917 KiB | **514 KiB** |
| …gzipped                                                   | —       | 152 KiB     |
| portal / live-room code a fan never fetches                | 0 KiB   | 408 KiB     |
| JS chunks in the build                                     | 20      | 49          |
| **total** JS (goes _up_, by ~15 KiB of per-chunk overhead) | 917 KiB | 923 KiB     |

The budget is a ceiling with ~8–10 % headroom (`scripts/bundle-budget.json`, regenerated with `--write`), and
it gates on the fan's set rather than the total: the split _raised_ total bytes, so a gate on the wrong metric
would have recorded the improvement as a regression. `mustBeOwnChunk` is the other half — `AdminPortal`,
`TeamOwnerPortal`, `MediaPortal`, `TeamPortal`, `MatchDetails`, `StandingsPage` must each still be a file of
their own, which is what fails if anyone re-imports a portal statically. Source-level pins (lazy-vs-static
imports in `App.tsx`, the manual-chunk function itself, the budget file's shape) are in
`tests/unit/bundle-split.test.ts`, so both failure modes are caught without needing a build.

`App.tsx` also stopped importing `FanPortal`, which has no route: under `lazy()` that import would have
emitted an orphan chunk and hidden the fact. The screen, its data-layer reads and its tests stay; wiring a
route to it is a product decision, not a build fix.

### 7.3 What this unit did not do, and cannot claim

- **No browser was run against any of it.** No headless Chrome, no Lighthouse, no real device. The numbers
  above are byte counts from `vite build` and from the asset pipeline; the PNGs were inspected as images.
  Nobody measured paint time, and "first paint" here names a set of files, not a moment on a screen.
- The **Supabase client is now the largest thing a fan downloads** (206 KiB of the 514). Shrinking that means
  not building a `supabase-js` client during boot — a change to the auth path, not a build flag.
- `public/kicklive-icon.png`, `kicklive-logo.png` and `kicklive-wordmark.png` (5.5 MB together) remain **in
  the deployment**, because `branding.mjs` reads them from there and Vite copies `publicDir` verbatim.
  `branding check` says so as one `public.heavy-unreferenced` warning. Moving them to a directory that is not
  `publicDir` is a small change with a packaging decision attached; it is listed rather than taken quietly.
- No image was converted to WebP or AVIF: this repository encodes PNG in pure JS and the sandbox cannot
  install a native encoder. The same appearance at a third of the bytes is available to whoever adds one.
- PWA/Workbox (step 13) was **not** extended to precache `public/brand/*`. `scripts/build-pwa.mjs` has no
  asset list to add them to, and inventing one means a cache-version decision the desktop shell must also
  respect; the header and wordmark are already fetched on every page anyway, so the precache would win
  nothing on a first visit and the deployment is `immutable`-cacheable per hashed path.
