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
| `/portal/fan`        | 4 in parallel                                        | + the same 4 every 30 s, never paused                           |
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
  `npm run build:web` reports 908 KiB of JS in 20 files / 7.45 MiB total.
- **F-12 · 2.4 MB of brand PNG on the critical path.** `kicklive-icon.png` (2 456 662 bytes) is the
  loading spinner on every cold start, the header mark on every page and the auth-screen logo, rendered at
  32–128 px; `kicklive-wordmark.png` adds 2.1 MB. The install/manifest sizes already exist
  (`web-app-manifest-192x192.png`, `favicon-96x96.png`) but nothing small enough for an `<img>` does.
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

No schema change without a measurement. `--explain` prints the EXPLAIN statements for the canonical reads;
the candidate index set in the generated SQL is derived from the three WHERE/ORDER shapes the audit shows
over and over (`status,start_time`, `competition_id,start_time`, `team_id`, `created_at desc`, `goals desc`).
Whether each is added is decided by the plan, not by the count — a 60-row `matches` table does not need
four indexes, a season with 3 000 of them does. Migrations only; nothing drops or rewrites data.

### 4.9 What is deliberately not deleted

`DataLoader.ts` keeps its file and its API (`loadAll`, `subscribe`, `getMatches`, …) with a header
explaining that `App.tsx` no longer starts it, because F-01 is a claim about the current tree — if a portal
turns out to want a global team index, the loader is the shape of the answer and the new cache is where it
should live. The 10 superseded `MatchControl*` variants and `EventModal.tsx` stay exactly as Phase 3 left
them; the `matches.status = 'finished'` filter bug (F-05) is **not** silently fixed inside a perf phase in
files nobody renders — it is listed here so the deletion decision covers it.
