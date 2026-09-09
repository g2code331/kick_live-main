# `workers/` — the API boundary

**Status: Phase 2 is live.** Three routes are implemented and tested (`GET /health`, `GET /me`,
`GET /teams/mine`); the rest of the surface is _declared_ in `src/router.ts` and answers
`501 NOT_IMPLEMENTED` after authentication and authorization have already been enforced. The app
still reads and writes Supabase directly for every existing feature — that is the migration this
layer exists to serve, route by route, and it is deliberately not done in one pass.

What "live" means here, precisely: the code compiles under the repo's strict `tsconfig.workers.json`,
44 unit/integration assertions in `tests/unit/phase2-api-boundary.test.ts` run against the real
`fetch` handler, and the frontend client in `src/lib/api/` calls it. It does **not** mean deployed —
no `wrangler` binary was installed and no Cloudflare account was touched in this working session (see
_Running it_ below).

## Layout — one concern per directory

| Path                              | Owns                                                                  | Must never contain                             |
| --------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `src/index.ts`                    | the request pipeline and its order                                    | business rules, SQL                            |
| `src/router.ts`                   | the route table: path → capability → cache class → rate class → phase | any handler code                               |
| `src/routes/*.ts`                 | handlers: read body → validate → call a service → shape the response  | raw `fetch` to Supabase, role comparisons      |
| `src/middleware/auth.ts`          | _who_ is calling (JWT verify → authoritative role from `profiles`)    | authorization decisions                        |
| `src/middleware/authorization.ts` | _whether_ this caller may attempt this action                         | SQL, row filters                               |
| `src/services/teamAccess.ts`      | _this row_: ownership of a team/match (resource-level authorization)  | role checks used as a substitute for ownership |
| `src/middleware/cors.ts`          | the origin allow-list, preflight, exposed headers                     | `"*"`, `allow-credentials`                     |
| `src/middleware/ratelimit.ts`     | budget classes and the counter store (KV, or memory in dev)           | a security boundary claim                      |
| `src/middleware/turnstile.ts`     | bot check for credential exchange and anonymous writes                | a fallback "pass when missing" in production   |
| `src/middleware/audit.ts`         | the `audit_log` write for privileged actions                          | PII beyond what the audit table already keeps  |
| `src/lib/validation.ts`           | field readers, the schema-derived enum lists, body size bound         | per-route bespoke parsing                      |
| `src/lib/response.ts`             | the single envelope + `ApiError`                                      | upstream error text in a production body       |
| `src/lib/capabilities.ts`         | role → capability matrix                                              | a role inferred from a client                  |
| `src/services/supabase.ts`        | the only PostgREST transport; the three clients                       | a key read from anywhere but `env`             |
| `src/services/profiles.ts`        | the safe `profiles` projection                                        | extra columns "while we are here"              |
| `src/types/api.ts`                | the wire contract of the implemented routes                           | a duplicate of the row shape                   |

## The pipeline (this order is the security model)

```
browser (Supabase access token in `Authorization: Bearer`)
  │
  ├─ Cloudflare edge — TLS, WAF, cache rules for `cache: "edge"` routes
  │
  └─ Worker `fetch`
       1. x-request-id            every response carries one; the log line carries the same id
       2. CORS                    exact-origin allow-list from ALLOWED_ORIGINS; OPTIONS → 204
       3. matchRoute()            unknown path → 404 NOT_FOUND; known path, wrong verb → 405
       4. authenticate()          verifyAccessToken() (HS256, exp/iat/aud) → role from `profiles`
       5. authorizeForRoute()     capability matrix decides everything: `public.read` is held by
                                  anonymous callers (so declared public routes 501, not 401), any other
                                  capability is 401 without a session and 403 with the wrong role
       6. limitRequest()          BUDGETS[route.rateLimit], bucketed by userId, else by IP
       7. handler                 readJsonBody()/readQuery() → services → Supabase
       8. finalise()              cache class, security headers, rate headers, CORS echo — on success AND on error
```

Steps 4–6 run **before** the 501 stub, so a fan probing `POST /api/admin/users/:userId/role` gets 403
today, and the day someone implements it the check is already in place. That is the whole reason the
route table exists before the handlers do.

## Identity, roles and ownership

- A role in a request body, query string or cookie is **never** read. `authenticate()` takes `sub` from
  a verified token and then reads `profiles.role` from Postgres, per request.
- Supabase's JWT `role` claim is the Postgres role (`anon` / `authenticated`), not the application
  role. Confusing the two would look like a control and be a bug, so the claim is ignored.
- A valid token with no profile row is a 401, not a fallback to "fan": fail closed.
- Every non-public route goes through the same guard: `requireAuth()` in `middleware/auth.ts`, called by
  `authorizeForRoute()`. There is no per-route "is there a session?" line left to forget.
- The capability matrix answers "may this role attempt this action". `services/teamAccess.ts` answers
  "is this row yours". `/api/teams/mine` implements both: it filters on `owner_id` **and** issues its
  read with the caller's own token, so RLS enforces the same predicate a second time. A bug in the
  Worker then cannot exceed what the caller could already do.
- `supabaseAdmin()` (service role, RLS bypassed) exists for the few cross-row operations that need it
  and is deliberately unusable by handlers: `grep -rn "supabaseAdmin(" workers/src` should stay a
  two-line answer (the transport and `middleware/audit.ts`).

## Response contract

```jsonc
// 200
{ "success": true, "data": { … }, "requestId": "01J…" }

// 4xx / 5xx
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",          // stable machine-readable code
    "message": "2 field(s) in the request are not valid.",  // safe to render
    "fields": [{ "field": "minute", "message": "must be 130 or less" }],
    "detail": "…PostgREST text…"          // ONLY when APP_ENV != production
  },
  "requestId": "01J…"
}
```

Codes: `BAD_REQUEST`, `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `BOT_CHECK_FAILED`,
`NOT_IMPLEMENTED`, `DEPENDENCY_FAILED`, `INTERNAL_ERROR`. A Postgres message, a constraint name, a
column list or a stack frame never reaches a browser: `fail()` keeps them in `detail` (non-production
only) and in the log line. Upstream failures are `502 DEPENDENCY_FAILED`, not 500 — the difference is
what an on-call operator should look for.

## CORS, as a policy

- `ALLOWED_ORIGINS` is an exact, comma-separated list **per environment**; `*` is rejected by
  `src/env.ts` and an unset list means no cross-origin access at all.
- Preflight echoes the origin, `allow-methods`, `allow-headers` (`authorization, content-type,
x-request-id, turnstile-token, last-event-id`) and `max-age: 600`. A disallowed origin gets a 204
  with **no** CORS headers rather than a 403 — a distinct answer on `OPTIONS` is an origin oracle.
- `Origin: null` (sandboxed iframe, `file://`) is refused, not echoed.
- No response ever sets `Access-Control-Allow-Credentials`: this API is bearer-token authenticated, and
  a wildcard plus credentials is a cross-site read primitive.
- CORS is a browser contract, not the access control: the token check is what protects a mutation.

## Rate limits

No distributed system this phase — one table of named budgets and one enforcement point, so adding an
endpoint is one word in the route table instead of a decision someone has to remember:

| Class           | Budget     | Who gets it                                                     |
| --------------- | ---------- | --------------------------------------------------------------- |
| `public`        | 600 / 60 s | unauthenticated reads, `GET /health`                            |
| `authenticated` | 240 / 60 s | per-user reads, incl. the SPA's 15 s poll loops                 |
| `mutation`      | 60 / 60 s  | every write route                                               |
| `auth-exchange` | 5 / 900 s  | `POST /auth/sign-up`, `/auth/access-requests`, admin decisions  |
| `admin-blast`   | 10 / 60 s  | fan-out from one action (`POST /admin/notifications/broadcast`) |

Bucket key = `class:route:userId`, or `class:route:ip:<ip>` when anonymous. `RATE_LIMIT_KV` is the
shared store; without it the counter is per-isolate and the response says so
(`x-ratelimit-store: memory`) instead of pretending to be a defence. Turnstile and Supabase's own
quotas remain the real barrier for credential exchange until KV is provisioned.

## Environment and configuration

| Variable                    | Kind    | Development         | Staging           | Production         | Notes                                                                    |
| --------------------------- | ------- | ------------------- | ----------------- | ------------------ | ------------------------------------------------------------------------ |
| `APP_ENV`                   | var     | `development`       | `staging`         | `production`       | error `detail`, log verbosity, Turnstile enforcement                     |
| `SUPABASE_URL`              | var     | staging project     | staging project   | production project | must agree with the ref below                                            |
| `SUPABASE_PROJECT_REF`      | var     | staging ref         | staging ref       | production ref     | `assertSupabaseUrl()` 500s on a mismatch: no silent wrong-project writes |
| `SUPABASE_ANON_KEY`         | var     | staging key         | staging key       | production key     | public by design; RLS still applies                                      |
| `ALLOWED_ORIGINS`           | var     | localhost SPA ports | staging SPA       | app + desktop      | exact list, never `*`                                                    |
| `SUPABASE_JWT_SECRET`       | secret  | `.dev.vars`         | `wrangler secret` | `wrangler secret`  | verifies the SPA's HS256 token                                           |
| `SUPABASE_SERVICE_ROLE_KEY` | secret  | optional            | `wrangler secret` | `wrangler secret`  | only `supabaseAdmin()`; absent = admin paths fail loudly                 |
| `TURNSTILE_SECRET_KEY`      | secret  | blank (skipped)     | `wrangler secret` | `wrangler secret`  | required in production by `verifyTurnstile()`                            |
| `RATE_LIMIT_KV`             | binding | unbound (memory)    | KV namespace      | KV namespace       | created per environment                                                  |

The frontend side has exactly one new variable, `VITE_API_BASE_URL`, and its default is **empty**,
which means same-origin `/api`. `src/lib/env.ts` refuses a dev build that names a non-local API (unless
`VITE_API_ALLOW_REMOTE=1`) and refuses a production build that names `localhost`; the Vite dev server
proxies `/api` to `127.0.0.1:8787`. Local development therefore cannot reach production data by
accident, in either direction.

## Adding a route (the checklist)

1. `src/router.ts` — one entry: method, pattern, `capability`, `cache`, `rateLimit`, `phase`,
   `summary`, and the `invariants` the handler must enforce. Mark `implemented: true` only with the
   handler in the same commit.
2. `src/routes/<area>.ts` — read the body with `readJsonBody(request, DECLARED_KEYS)`, validate every
   field, call a `services/*` function, return `ok(data, { requestId })`. No `fetch` here.
3. Authorization at the top: `requireCapability(...)` / `requireRole(...)`, then the row check
   (`requireManagedTeam`) when the path names somebody's resource.
4. A privileged write also writes the audit row (`middleware/audit.ts`).
5. Frontend: add the typed call next to `apiMe()` in `src/lib/api/index.ts` and the mirrored types in
   `src/lib/api/types.ts` (a test pins the field lists against the Worker's).
6. Tests: 200 path, 401 (anonymous), 403 (wrong role), 400 (malformed body), and the resource-level
   refusal — a manager acting on somebody else's row.
7. `node scripts/worker-routes.mjs --check` then `npm run typecheck && npm test`.

## Testing without Cloudflare

`tests/unit/phase2-api-boundary.test.ts` imports the real handler and stubs only `globalThis.fetch`
(the Worker's route to Supabase), signing genuine HS256 tokens with `crypto.subtle`. It covers: health
(3 path spellings, payload content, cache class), `/me` unauthenticated / authenticated / tampered
signature / `alg: none` / expired / wrong audience / missing profile row / "read as the caller, not as
service role", authorization-before-501 for both fan and admin, the validation library (unknown keys,
types, enums, ids, scores, minutes, timestamps, 64 KB bound), the schema-mirror of every enum list,
CORS (allow, deny, `null` origin, `*` rejected, no credentials), rate-limit budgets and bucket keys,
production error sanitisation (no `42703`, no column names, no sentinel key), `SUPABASE_URL`/ref
mismatch, the three route-table invariants, and the frontend client (envelope, field errors, HTML 502,
401 retry, timeout, abort).

What this cannot prove, and what needs a real deployment: KV behaviour across isolates, the
`routes = [...]` custom domain, Turnstile's live `siteverify`, and latency of the per-request profile
read. Those are checked by the probe list in `docs/PRODUCTION_MIGRATION_PLAN.md` §Phase 2.

## Running it

```bash
npm i -D wrangler@latest                     # not installed in this repo today, on purpose
cp workers/.dev.vars.example workers/.dev.vars   # git-ignored; fill in the STAGING project
npm run worker:dev                               # wrangler dev on http://localhost:8787
curl -s localhost:8787/api/health | jq            # 200 before you touch the SPA
npm run worker:routes -- --check                  # README and router.ts agree
```

Then, in another terminal, `npm run dev` and open the admin "User Control" screen: its _API boundary
check_ panel calls `/api/health` and `/api/me` through the frontend client.

```bash
npx wrangler secret put SUPABASE_JWT_SECRET     --env staging
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
npm run worker:deploy:staging
npm run worker:deploy:production
```

## What is deliberately **not** here

- **No D1 database.** Supabase Postgres is the only source of truth; a second copy of match data with a
  sync job in the middle is how "which one did you read?" becomes the first question in every bug
  report. The `[[d1_databases]]` block stays commented in `wrangler.toml` with that note.
- **No R2 or Queue bindings.** They stay declared in the plan rather than written into the config,
  because a binding with no code behind it looks deployed and is not. Phase 4 (media, jobs) and Phase 5
  (push) add each one with its first real route. The Durable Object binding _did_ arrive with Phase 3,
  together with the class that uses it (`src/do/MatchRoom.ts`) — see "Live match engine" below.
- **No FCM/Firebase dependency and no push implementation.** `POST /admin/notifications/broadcast` is a
  row in the route table, and that is all it is.
- **No advertising or sponsorship endpoints** beyond the declared route map; the two concepts stay
  separate on purpose (an advertiser buys scheduled placements with impression events; a sponsor buys a
  season of rights).
- **No validation of a route that does not exist.** `lib/validation.ts` is complete and tested as a
  library; the first mutation route wires it. Nothing pretends a write path is live.
- **No migration of the 27 files that still write to Supabase from the browser.** The live match engine
  moves the match-control path — and only that path — behind this API; the other 26 stay on their current
  direct reads until their own phase. `src/lib/api/` is the door; each table walks through it in its own
  change.
- **No production claim.** The routes, the Durable Object and the migration are in the tree and covered
  by tests, but the migration has not been applied to a real project from this repository and nothing has
  been deployed with `wrangler`. "Live" in the route map means _a handler exists_, never _tested against
  your database_.

## Live match engine (Phase 3)

One engine, one authority per question:

| Question                                    | Answered by                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| Who may write to this match?                | `services/matchAccess.ts` (assignment rows) **+** RLS        |
| Is this change legal in this match's state? | `lib/matchLifecycle.ts` / `lib/matchEvents.ts`, again in SQL |
| What is the score?                          | `match_events` folded by Postgres — never stored as an input |
| What is the minute?                         | server timestamps (`match_start_time` + banked seconds)      |
| What is the order of events?                | `matches.live_seq`, allocated in the write function          |
| Where do the sockets live?                  | `DurableObject MatchRoom`, one per match id                  |

Write path: `POST /api/matches/:matchId/events` → authenticate → matrix (or per-match assignment) →
`Fields` validation → `resolveMatchAccess` → **MatchRoom** (serialise → re-check state →
`kicklive_record_match_event` inserts the row, allocates the sequence, recomputes the score, appends the
audit line → only then broadcast) → the response body is the same frame the fans' sockets got.

The consequences of that order are the point:

- **an acknowledged event is a durable event.** The POST's 200 means the row exists. If Postgres is
  unreachable the answer is `503 DEPENDENCY_FAILED`, nothing is broadcast, and the controller's draft
  queue keeps the entry and retries it under the same `client_event_id` — idempotent, so a retry can
  never become a second goal.
- **`Durable Object state is not the database.** Eviction, a redeploy or a crash costs a fan nothing:
the room rehydrates from `kicklive_match_live_state` and continues from the stored sequence. Deleting a
  room is an inconvenience, not a data-loss event.
- **the room holds no credentials.** The caller's bearer token is read from the subrequest, used for that
  one Postgres call, never written to storage; reads with no caller run as `anon`, under RLS. The service
  role is never used in the live path.
- **a conflict is surfaced, not swallowed.** A rejected draft answers `409` and pushes a `SYNC_CONFLICT`
  frame with the room's snapshot to every controller socket, so the console shows "the match moved" with
  the state to compare against.

Transports: WebSocket at `GET /api/live/matches/:matchId` (hibernating, read-only, authenticated for a
controller feed by a single-match ticket from `POST /api/matches/:matchId/live-ticket`), and
`GET /api/matches/:matchId/stream` (SSE) as the documented fallback for proxies and browsers that block
raw sockets. Both carry the same versioned frames and the same sequence numbers, so the client reducer is
identical; a client that detects a gap sends `resume`/`Last-Event-ID` and gets the missed events, or a
fresh `MATCH_SNAPSHOT` when the gap is wider than the retained window. Nothing ever reloads the page.

Locally, `npm run worker:local` runs the real `MatchRoom` in-process (an in-memory `DurableObjectState`),
so the sequencing, idempotency and recovery logic is exercised without Cloudflare. The Node adapter
cannot complete a WebSocket handshake — `GET /api/matches/:id/stream` is the transport to test there, and
`npx wrangler dev` is the only way to exercise a real socket.

## Route map

Generated from `src/router.ts` — `node scripts/worker-routes.mjs` regenerates this block, and
`tests/unit/phase2-api-boundary.test.ts` fails if the two drift apart. Paths are matched under
`/api` (canonical) and `/v1` (the alias the Phase 1 documents use); they are the same handlers, never
two implementations. `Live` means a handler exists; everything else answers `501 NOT_IMPLEMENTED`
_after_ authentication and authorization.

| Route                                             | Capability              | Cache   | Rate budget   | Phase | Live    | Purpose                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------- | ------- | ------------- | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                     | _public_                | edge    | public        | 2     | **yes** | Liveness + build version. Implemented today so deploy wiring is provable.                                                                                                                                                                                                                                                                                               |
| `GET /me`                                         | profile.read_own        | private | authenticated | 2     | **yes** | Who the caller is, per the database: role, email, username, capability hints. — _Role is read from `profiles` by the Worker; nothing in the request may name a role._                                                                                                                                                                                                   |
| `POST /auth/sign-up`                              | _public_                | none    | auth-exchange | 2     | —       | Create a fan account (Turnstile-gated). — _Role is never accepted from the request body; the created profile is always a fan._                                                                                                                                                                                                                                          |
| `POST /auth/access-requests`                      | identity.request_role   | none    | auth-exchange | 2     | —       | Queue a team_manager/media request for admin review. — _At most one open request per user; `admin` is not requestable._                                                                                                                                                                                                                                                 |
| `GET /matches`                                    | public.read             | edge    | public        | 2     | —       | Fixture + score list, filtered by competition/date/status, bounded page size. — _Replaces whole-table `matches` selects from 6+ components; max limit 100._                                                                                                                                                                                                             |
| `GET /matches/:matchId`                           | public.read             | none    | public        | 2     | **yes** | One match with live state and its timeline in a single round trip. — _cache flips to `none`: a live match answer must never be served from the edge cache, or the score a fan reads depends on which PoP they hit._                                                                                                                                                     |
| `GET /media/feed`                                 | public.read             | edge    | public        | 2     | —       | Published articles, paginated; the only media read the public pages need.                                                                                                                                                                                                                                                                                               |
| `GET /teams`                                      | public.read             | edge    | public        | 2     | —       | Active clubs with the columns the UI actually renders.                                                                                                                                                                                                                                                                                                                  |
| `GET /matches/:matchId/stream`                    | public.read             | none    | public        | 3     | **yes** | SSE handoff to the match Durable Object; replaces setInterval polling. — _Read-only; server-assigned sequence; resumes from Last-Event-ID; 15s keepalive comment; ends rather than lying._                                                                                                                                                                              |
| `POST /matches/:matchId/events`                   | match_control.write     | none    | mutation      | 2     | **yes** | Append one validated match event (goal, card, substitution…). — _Idempotent on client_event_id; event_type checked against the profile CHECK list; score/minute derived from events rather than trusted from the client; rejected when the match is locked; sequence allocated by Postgres; written through the Durable Object so broadcast order equals commit order._ |
| `PUT /matches/:matchId/state`                     | match_control.write     | none    | mutation      | 2     | **yes** | Clock/status transition (kickoff, half time, second half, full time, suspend…). — _Legal transitions only, from lib/matchLifecycle.ts, enforced again in SQL; the DO owns the clock and derives the minute; the browser never names a status it likes._                                                                                                                 |
| `POST /matches/:matchId/finalize`                 | match_control.finalize  | none    | mutation      | 2     | **yes** | Freeze the result from the event log: derived score written once, confirmed_at set, match completed. — _Head referee, match commissioner or admin; refuses while the clock is running; refuses if events disagree with the stored score; notifications/standings remain Phase 5._                                                                                       |
| `POST /matches/:matchId/lock`                     | match_control.lock      | none    | mutation      | 2     | **yes** | Freeze a match for review (admin-only: a lock outranks the officials' own rights). — _Reason required; broadcast to the room so a console mid-entry sees the lock before it writes._                                                                                                                                                                                    |
| `GET /matches/:matchId/snapshot`                  | public.read             | none    | public        | 3     | **yes** | Authoritative live state: score, status, server-derived clock, recent events, connection counts. — _Served by the Durable Object and rehydrated from Postgres when the room is cold; no client-supplied minute or score._                                                                                                                                               |
| `GET /matches/:matchId/events`                    | public.read             | none    | authenticated | 3     | **yes** | Timeline page, oldest first, with sequence cursor for backfill (`?after_sequence=&limit=`). — _Includes corrected rows with their replacement, so a dispute can be read as it happened._                                                                                                                                                                                |
| `GET /matches/:matchId/access`                    | profile.read_own        | private | authenticated | 3     | **yes** | What this caller may do in this match, and which transitions are legal from its current status. — _Computed from the assignment rows, never from a client claim; the console renders disabled buttons from this and the server refuses anyway._                                                                                                                         |
| `POST /matches/:matchId/corrections`              | match_control.write     | none    | mutation      | 3     | **yes** | Correct an event: the original row stays, marked corrected, with who/when/why and a replacement. — _Reason required; own events while live, any event at any time for admins; score recalculated from the surviving rows._                                                                                                                                              |
| `GET /matches/:matchId/audit`                     | match_control.read      | private | authenticated | 3     | **yes** | Who recorded, corrected or reopened what, from activity_logs, newest first. — _Read-only; admin and media roles only — officials see the same facts in the timeline itself._                                                                                                                                                                                            |
| `GET /matches/:matchId/assignments`               | profile.read_own        | private | authenticated | 3     | **yes** | Officials assigned to this match (own rows for an official, all rows for an admin — RLS decides).                                                                                                                                                                                                                                                                       |
| `POST /matches/:matchId/assignments`              | match.assign            | none    | mutation      | 3     | **yes** | Assign a user as head referee / assistant / fourth official / VAR / commissioner / data operator. — _Admin only; the assignee must have a profile row; a match may not be controlled before this exists._                                                                                                                                                               |
| `POST /matches/:matchId/assignments/stand-down`   | profile.read_own        | none    | mutation      | 3     | **yes** | Stand down from an assignment — the caller's own row, or anyone's for an admin. — _Never deletes history: the row becomes `stood_down`._                                                                                                                                                                                                                                |
| `POST /matches/:matchId/live-ticket`              | public.read             | none    | authenticated | 3     | **yes** | Short-lived, single-match credential for the WebSocket handshake (a browser cannot set headers there). — _`controller` tickets are refused unless the caller is an assigned official; carries no role the caller lacks._                                                                                                                                                |
| `GET /live/matches/:matchId`                      | public.read             | none    | authenticated | 3     | **yes** | WebSocket upgrade into the match room (read-only fan updates; writes always go through REST). — _Hibernating sockets; snapshot on connect; resume from the last sequence; no client frame can write._                                                                                                                                                                   |
| `GET /matches/:matchId/diagnostics`               | admin.audit_read        | none    | authenticated | 3     | **yes** | Room internals for incident triage: sequence, retained buffer, clock source, sockets, alarm.                                                                                                                                                                                                                                                                            |
| `GET /teams/mine`                                 | team.read_own           | private | authenticated | 2     | **yes** | The caller’s own club(s), resolved by owner_id in SQL.                                                                                                                                                                                                                                                                                                                  |
| `PATCH /teams/:teamId`                            | team.update_own         | none    | mutation      | 2     | —       | Edit club profile, lineup, gallery. — _Owner-or-admin re-check inside the handler: the capability alone is not enough._                                                                                                                                                                                                                                                 |
| `POST /players`                                   | player.manage_own_team  | none    | mutation      | 2     | —       | Add a player to a squad the caller manages.                                                                                                                                                                                                                                                                                                                             |
| `POST /media`                                     | media.publish           | none    | mutation      | 2     | —       | Create an article; author_id set from the JWT. — _Fixes today’s gap where MediaPublisher never writes author_id at all._                                                                                                                                                                                                                                                |
| `POST /media/:mediaId/publish`                    | media.publish           | none    | mutation      | 2     | —       | Flip an article public, with the featured flag needing a separate capability.                                                                                                                                                                                                                                                                                           |
| `DELETE /media/:mediaId`                          | media.delete            | none    | mutation      | 2     | —       | Delete an article. Admin-only, unlike the current media-role policy.                                                                                                                                                                                                                                                                                                    |
| `POST /notifications/subscriptions`               | profile.read_own        | none    | mutation      | 5     | —       | Register an FCM/APNs device token for the caller. — _Tokens are per-user and per-device; never stored on profiles._                                                                                                                                                                                                                                                     |
| `POST /admin/notifications/broadcast`             | notifications.broadcast | none    | admin-blast   | 5     | —       | Fan-out push/notification to an audience; the only route allowed to write many rows per call. — _Audience size is capped and the send itself runs in a Queue (Phase 4+), never in the request._                                                                                                                                                                         |
| `GET /admin/access-requests`                      | identity.read_directory | private | authenticated | 2     | —       | The pending queue behind User Control.                                                                                                                                                                                                                                                                                                                                  |
| `POST /admin/access-requests/:requestId/decision` | identity.grant_role     | none    | auth-exchange | 2     | —       | Approve or reject a request; grants the role in the same transaction.                                                                                                                                                                                                                                                                                                   |
| `POST /admin/users/:userId/role`                  | identity.grant_role     | none    | mutation      | 2     | —       | Set a role, audited, last-admin-guarded (same RPC the SPA calls today).                                                                                                                                                                                                                                                                                                 |
| `GET /admin/audit`                                | admin.audit_read        | private | authenticated | 2     | —       | activity_logs, filtered, for the admin overview.                                                                                                                                                                                                                                                                                                                        |
| `POST /uploads/sign`                              | media.publish           | none    | mutation      | 4     | —       | Signed R2 PUT for an image/video upload with size and MIME bounds.                                                                                                                                                                                                                                                                                                      |
| `GET /uploads/:key`                               | public.read             | edge    | public        | 4     | —       | R2 read-through with image resizing + immutable cache keys.                                                                                                                                                                                                                                                                                                             |
| `GET /advertising/campaigns/active`               | public.read             | edge    | public        | 6     | —       | Campaigns eligible to serve, by placement slot.                                                                                                                                                                                                                                                                                                                         |
| `POST /advertising/events`                        | placement_event.record  | none    | mutation      | 6     | —       | Impression/click events, deduplicated, written once and never aggregated in the browser.                                                                                                                                                                                                                                                                                |
| `PATCH /advertising/campaigns/:id`                | campaign.manage         | none    | mutation      | 6     | —       | Start/pause/retarget a campaign.                                                                                                                                                                                                                                                                                                                                        |
| `GET /sponsorship/packages`                       | public.read             | edge    | public        | 6     | —       | Published rate card for a season.                                                                                                                                                                                                                                                                                                                                       |
| `PATCH /sponsorship/sponsorships/:id`             | sponsorship.manage      | none    | mutation      | 6     | —       | Renewals and rights changes; separate table from ad campaigns.                                                                                                                                                                                                                                                                                                          |

`advertising` and `sponsorship` stay apart on purpose: an advertiser buys scheduled placements with
impression events; a sponsor buys a package of rights over a season. They overlap only in "shows up in
the app", and merging them early is how you end up with one 30-column table.
