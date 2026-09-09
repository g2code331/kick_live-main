# Phase 1 security audit — Kick Live

Audited on 2026-09-09 against commit `ac38f04` (branch `arena/01a08671-kick-live-main`), after the
release-pipeline work. Scope: the whole repository — auth, roles, RLS and all five SQL files, every
browser-to-Supabase write, the portals, the match engine, the loader, notifications, deploy config,
env handling and logging.

**Read this first: what "fixed" means here.**

- `fixed in app` — the code in this repository no longer performs the unsafe operation. Compiles
  clean (`tsc -p tsconfig.json`, `tsconfig.workers.json`) and the release gates pass.
- `fixed in migration` — the database-side correction exists as
  `supabase/migrations/20260909120000_phase1_security_hardening.sql`. **It has not been executed.**
  This sandbox has no credentials for the Supabase project and no way to run Postgres, so the SQL has
  been reviewed by hand and checked for shape (balanced quotes, idempotency, self-check block,
  rollback), not applied or integration-tested. Until someone runs it, the privilege-escalation hole
  F-01 is still open in production even though the app no longer walks through it.
- `audited, deferred` — measured and described, deliberately not changed in Phase 1 (each entry names
  the phase that owns it in `docs/PRODUCTION_MIGRATION_PLAN.md`).

## Findings

| #    | Sev      | Area                | Finding                                                                                           | Status                                     |
| ---- | -------- | ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| F-01 | Critical | RLS `profiles`      | Any signed-in user could set their own `role` to `admin`                                          | fixed in migration                         |
| F-02 | Critical | Signup              | Privileged roles unlocked by a password map shipped in the bundle                                 | fixed in app                               |
| F-03 | High     | Config              | Hardcoded Supabase URL **and** key fallbacks, pointing at two different projects                  | fixed in app                               |
| F-04 | High     | Auth                | Client sent `role` in signup metadata and upserted it into `profiles`                             | fixed in app                               |
| F-05 | High     | RLS `profiles`      | `USING (true)` read policy exposed every user's email + phone to the anon key                     | fixed in migration                         |
| F-06 | High     | Grants              | Supabase defaults gave `anon` INSERT/UPDATE/DELETE on every table (RLS was the only wall)         | fixed in migration                         |
| F-07 | Medium   | RLS `activity_logs` | Audit rows were writable with any `user_id`, by anyone signed in                                  | fixed in migration                         |
| F-08 | Medium   | RLS `teams`         | Self-registration accepted an arbitrary `owner_id` and a chosen `status`                          | fixed in migration                         |
| F-09 | Medium   | RLS `media`         | Media role could edit/delete _any_ article; `author_id` is never written at all                   | partial; owner check in Phase 2            |
| F-10 | Medium   | Architecture        | 27 files write to Supabase straight from the browser (see table)                                  | audited, deferred to Phase 2               |
| F-11 | Medium   | Postgres            | `SECURITY DEFINER` helpers without `SET search_path`                                              | fixed in migration                         |
| F-12 | Low      | Logging             | Data-layer rows + per-refresh heartbeats printed in production builds                             | fixed in app (partial sweep)               |
| F-13 | Medium   | Repo hygiene        | `CREATE_ADMIN_PROFILE.sql` committed a personal email + auth UUID and was a one-paste admin grant | fixed in app                               |
| F-14 | Medium   | `media.views`       | Anonymous clients incremented a counter by read-modify-write                                      | fixed in app + migration                   |
| F-15 | Medium   | Edge                | No rate limiting or origin policy for anything; no bot check on signup                            | architecture defined, enforcement deferred |
| F-16 | Medium   | `db.ts`             | Mock data substituted for real data on any read failure, including in production                  | fixed in app                               |
| F-17 | Medium   | Schema mgmt         | Five competing SQL files, no `supabase/migrations`, no way to know what production holds          | fixed in repo                              |
| F-18 | Low      | `DataLoader`        | Busy-wait loop; polling continued in hidden tabs; whole-table loads                               | partial fix; retirement in Phase 2         |
| F-19 | Medium   | Match Control       | Ten implementations; the one actually routed is the weakest; `is_locked` never written            | audited, deferred                          |
| F-20 | Low      | Notifications       | `notifications` is write-only; no recipient column, no device tokens, nothing reads it            | audited, deferred to Phase 5               |
| F-21 | Medium   | Missing feature     | Predictions UI has no backing table — fan predictions are browser-local                           | audited, needs schema                      |
| F-22 | Low      | Docs                | Deployment guides carried the project URL + anon key literal                                      | fixed in repo                              |
| F-23 | Low      | Auth policy         | 6-character minimum enforced in the form only                                                     | fixed in app (8 at signup)                 |
| F-24 | Low      | Deploy hygiene      | `.vercel/project.json` committed against Vercel's own guidance                                    | audited, one-line fix left unexecuted      |
| F-25 | Medium   | Mock data           | `/team-portal` renders `data/mockData.ts` and never touches the database                          | audited, not changed                       |
| F-26 | Low      | Mock data           | A failed lineup write is masked by a `localStorage` copy that reads back as saved                 | audited, not changed                       |

## Critical and high

### F-01 — self-granted admin (the one that mattered)

`KICKLIVE_FINAL_SCHEMA.sql` (base schema, §7) defined:

```sql
CREATE POLICY "profiles: own update"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
```

That is a correct policy for a profile editor and a complete privilege-escalation path at the same
time: `role` is an ordinary column on `profiles`, so `PATCH /rest/v1/profiles?id=eq.<my-uuid>` with
`{"role":"admin"}` satisfied it. Every other policy in the schema is `USING (public.is_admin())`, so
that single row rewrite handed out the whole product — fixtures, results, live match events, deleting
competitions, media removal. `SUPABASE_COMPLETE_SCHEMA.sql` was worse (`USING` only, so even
_inserting_ a row for another user id passed).

The trigger created by `handle_new_user()` correctly forces `'fan'` at signup, which is why this reads
like a reviewed design rather than an oversight: the hole was not "signup can pick a role" but "anyone
can change it afterwards".

Fix (in the migration, in order of strength):

1. `revoke update (role) on public.profiles from authenticated, anon;` — grants are checked before
   policies, so the column is simply not updatable by client roles.
2. `kicklive_guard_profile_privileges()` BEFORE INSERT/UPDATE trigger: rewrites a non-admin's
   requested role to `fan` on insert, raises `42501` on a non-admin role or email change, and lets a
   superuser session (`session_user`, i.e. the dashboard or a migration, never PostgREST) through for
   bootstrapping.
3. Role changes go through `kicklive_set_user_role()`, which re-checks `is_admin()` in-database,
   refuses to demote the last admin, and writes the `activity_logs` row.
4. `profiles: public read` replaced by `profiles: authenticated read`.

Verification after applying:

```sql
-- must be false:
select has_column_privilege('authenticated','public.profiles','role','UPDATE');
-- must return zero rows:
select policyname from pg_policies where tablename='profiles' and policyname='profiles: public read';
```

Then the behavioural probe, with a fan's access token:
`PATCH /rest/v1/profiles?id=eq.<fan-uuid>` body `{"role":"admin"}` → expect `42501`; before this
migration it returned `204`.

### F-02 / F-04 — the client chose the role, twice

`src/pages/auth/SignupPage.tsx` held

```ts
const rolePasswords: Record<string, string> = {
  team_manager: "mejojO",
  media: "wojojO",
  admin: "isjojO",
};
```

and validated `rolePasswordInput !== rolePasswords[role]` in the browser. That value is in the shipped
bundle — `curl` the JS and read it — so the gate was decorative, and it was the _only_ gate on the
privileged-signup path. `AuthContext.signUp()` then sent `options.data.role` and upserted
`{ …, role }` into `profiles`.

Now: registration creates a fan, `signUp(email, password, username, phone)` has no role parameter, and
the upsert writes only `id, email, username, phone`. Manager/Media became a _request_
(`access_requests` + `kicklive_request_access`) that an admin approves in User Control; `admin` is not
requestable and is enforced by a CHECK constraint in the database, not by hiding a button.

The request flow is inert until the migration is applied — `kicklive_request_access` does not exist
before that, and `src/lib/access.ts` translates PostgREST's `PGRST202` into
"Privileged role operations need the Phase 1 hardening migration…" rather than a raw error.

### F-03 — the fallbacks disagreed with each other

`src/lib/supabase.ts` was nine lines:

```ts
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || "https://xvksxqrmdbbinlrjctri.supabase.co";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJ…InJlZiI6ImZuZWZwY2plZWJhd3NlYnhqaGNmIi…";
```

The fallback URL is project `xvksxqrmdbbinlrjctri`; the fallback key's `ref` claim is
`fnefpcjeebawsebxjhcf` (the real project, the one `.replit` and the deployment guides use). So a build
that lost its env vars did not fail: it talked to **another** Supabase project with a key from a third.
Which project got the writes depends on which fallback fired.

`src/lib/env.ts` now owns all of it: no defaults, a `ConfigError` naming the variable, an explicit
`url ref !== key ref` mismatch check, and `src/main.tsx` renders "KickLive is not configured" instead
of a blank page or a wrong-project session. `npm run build` still succeeds without env (it is a
build-time-inline value) but the _gate_ fails: `scripts/check-secrets.mjs --scan-only` — now wired into
gate 1 — greps `src/ pwa/ shared/ server/ desktop/src workers/src` for a `https://<ref>.supabase.co`
literal or any JWT-shaped literal, and a planted probe returns exit 1 with `::error::file:line`.

### F-05 / F-06 — anonymous reach

`profiles: public read USING (true)` meant the anon key alone could dump `id, email, username, phone,
role, created_at` for every account, in one request, forever (PostgREST paginates). Nothing in the UI
needed it: the six places that read `profiles` are own-profile (`AuthContext`, `ProfilePage`) or admin
(`AdminPortal`, `UserManagement`, `DataLoader.loadUsers`, `TeamDashboard` for club owners).

Separately, Supabase's default privileges grant `anon` **and** `authenticated`
`SELECT/INSERT/UPDATE/DELETE` on everything in `public`; RLS was the only thing refusing anon writes,
and one future `USING (true)` write policy would have been enough to allow them. The migration revokes
anon DML on existing tables _and_ sets `ALTER DEFAULT PRIVILEGES … REVOKE insert, update, delete …
FROM anon` so future tables start closed, keeps public _reads_ (this is a public sports site), and adds
`profiles_public` (id, username, avatar, created_at) as the view Phase 2 should read from when it
needs author names on public pages.

## Medium

**F-07 audit spoofing.** `activity_logs: auth insert WITH CHECK (true)` let any signed-in user write a
log row attributed to another `user_id`, which is the difference between an audit trail and a
suggestion box. Now `user_id = auth.uid()`, and the definer functions write their own rows (bypassing
RLS as the owner). `workers/src/middleware/audit.ts` is where that responsibility moves when the
writes move.

**F-08 team impersonation.** `teams: managers create WITH CHECK (true)` accepted any `owner_id` and any
`status`, so a signed-in user could register a club owned by somebody else, or skip the pending
review. `src/pages/portals/TeamOwnerPortal.tsx:197` already sends
`{ owner_id: profile?.id, status: 'pending' }`, so tightening to
`owner_id = auth.uid() AND status = 'pending'` constrains attackers and no legitimate caller — admins
keep working through `teams: admin all`.

**F-09 media ownership.** `media: admin and media all` (no `TO` clause, so anon was covered by the
policy text too) lets a media user edit or delete any article, including one they did not write.
`MediaPublisher` never sets `author_id` at all, so a per-author rule today would lock media users out
of their own back-catalogue and their existing drafts. Phase 1 adds `TO authenticated` + an explicit
`WITH CHECK`, and Phase 2's `POST /v1/media` sets `author_id` from the verified token; only then can
the policy become "own rows unless admin".

**F-10 direct browser writes.** The full inventory, from `from('table')` + a write verb in the same
call chain:

| File                                                                               | Writes                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `portals/TeamOwnerPortal.tsx`                                                      | players insert/update/delete, team_news insert/delete, teams insert/update            |
| `portals/admin/SeasonManagement.tsx`                                               | competitions delete, matches delete, seasons insert/update/delete                     |
| `portals/admin/MatchControl{Pro,Full,Dashboard}.tsx`                               | matches update, match_events insert, match_commentary insert, match_statistics update |
| `portals/admin/MatchControl{,Center,New,Room}.tsx`, `MatchDashboard.tsx`           | matches update, match_events insert, match_commentary insert                          |
| `portals/admin/MatchControlComplete.tsx`, `MatchControlSimple.tsx`                 | matches update                                                                        |
| `portals/AdminPortal.tsx`                                                          | activity_logs insert, competitions delete, matches delete                             |
| `portals/admin/{CompetitionWizard,FixturesViewer}.tsx`                             | competitions insert, matches insert/delete                                            |
| `portals/admin/{TeamDashboard,TeamAdder,TeamSquadDashboard}.tsx`                   | teams insert/update/delete, players delete                                            |
| `portals/admin/CompetitionEditor.tsx`                                              | competitions update                                                                   |
| `portals/MediaPortal.tsx`, `shared/MediaPublisher.tsx`, `shared/PlayerCreator.tsx` | media update/delete, media insert, players insert                                     |
| `src/lib/MatchAutomation.ts`                                                       | notifications insert                                                                  |
| `src/contexts/AuthContext.tsx`, `src/pages/ProfilePage.tsx`                        | profiles upsert/update (own row, display fields only)                                 |

Consequence: "who may write a match event" is answered entirely by RLS today, and the answer is
"anyone `profiles.role` says is admin" — which is why F-01 had to be closed first. These writes are
kept working, not deleted: narrowing the policies without replacing the callers would just break the
portals. Phase 2 moves them route by route.

**F-11 `SECURITY DEFINER` without a path.** `is_admin()` / `is_admin_or_media()` ran as the owner with
the caller's `search_path`, so a shadowing object earlier in the path could change which `profiles`
table the role check read. All definer functions in the migration (existing and new) carry
`SET search_path = public, pg_temp` and explicit `GRANT EXECUTE`.

**F-14 the view counter.** `NewsPage` did `select views` → `update views = n+1`, from an anonymous
visit, with the result ignored (`.then(() => {})`) — so in practice the count never moved (RLS denied
anon writes) and the code was a template for a counter-inflation bug. It is now
`kicklive_record_media_view(media_id)`: one row, one column, `views = coalesce(views,0) + 1`,
`published = true` only, atomic. The remaining abuse surface is volume, not correctness, and the fix
is the Worker's limiter (`BUDGETS['public.read']`, KV) rather than a database trigger.

**F-15 nothing limits or authenticates at the edge.** There is no `CORS`/`rate limit`/`Turnstile`
configuration anywhere in the repo today — which is _mostly_ correct while the browser talks to
PostgREST directly (Supabase owns CORS and its own limits), but it means the app has no defence if
`/rest/v1/rpc/…` is spammed, and no bot gate on signup or password reset. `workers/` defines the
shape (`allowedOrigins()` refuses `*`; `BUDGETS` is per-capability; `verifyTurnstile` fails closed in
production, open in dev) but nothing enforces it until Phase 2. Until then, dashboard-level settings
(auth rate limits, captcha) are the only mitigation, and that is a configuration step for whoever runs
the project, not something this repository can assert.

**F-16 mock data as a success path.** `src/lib/db.ts` returned `data/mockData.ts` whenever a read
threw. An outage, an RLS denial or a revoked grant all looked like "here are today's fixtures":
invented scores on a live product, indistinguishable from real ones in the UI. `MAY_USE_MOCK_DATA` is
now `import.meta.env.DEV`, failures log through `log.error`, and production gets `[]` so the pages show
their empty states.

**F-17 which SQL is true.** Five files could each "set up the database"
(`KICKLIVE_FINAL_SCHEMA.sql`, `SUPABASE_COMPLETE_SCHEMA.sql`, `SUPABASE_NEW_PROJECT_SETUP.sql`,
`supabase_migrations.sql`, `CREATE_ADMIN_PROFILE.sql`), with three different policy name-spaces and
overlapping column sets — and no `supabase/migrations/` at all. The final schema is the strict superset
(verified: every table/column the other four create appears in it, and it is the only one whose policy
names the app-era files also drop). Now: it is the base, `supabase/migrations/` is the delta, and each
of the other four carries a header saying it is superseded and what breaks if it is run again. Nothing
was deleted or moved, so no existing runbook 404s.

**F-19 / F-21 / F-24** are described in `docs/PRODUCTION_ARCHITECTURE.md` (§10 match control, §14
missing domains) and here only in summary. `.vercel/project.json` is committed although the
`.vercel/README.txt` Vercel itself generated says not to: `projectId`/`orgId` are not secrets, but
`ci/workflows/deploy-web.yml` may be depending on that link because `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID`
are _optional_ secrets. Fix (do it in one commit, after setting both secrets, so no deploy window is
broken):

```bash
printf '.vercel/\n' >> .gitignore && git rm -r --cached .vercel
```

## Mock and fallback data (what hides a database failure)

**F-16** covered the one that could invent a result on a public page (`db.ts`), and that is fixed. Two
more are documented rather than changed, because both are features somebody is using:

**F-25 — `/team-portal` is a mock screen.** `src/pages/portals/TeamPortal.tsx` (212 lines) imports
`teams, players, matches` from `src/data/mockData.ts` and contains **no** `supabase` reference at all:
`const myTeam = teams[0]`. The route is live in `App.tsx` (`/team-portal`, gated to `team_manager`) and
is distinct from `/team-owner`, which is the real portal. A manager sent to `/team-portal` therefore
sees a plausible club, a plausible squad and plausible fixtures, with no error — including during a
total database outage. Phase 2 decision: fold it into `TeamOwnerPortal`'s tab set, or wire it to
`GET /v1/teams/mine`. It was not deleted here because a route in the app is the owner's call, not the
auditor's.

**F-26 — a lineup save that can lie.** `TeamOwnerPortal.tsx:1108` writes `teams.lineup` and, on error
(including `42703` "column does not exist", which is handled on purpose), falls back to
`localStorage`; the reader at `:1072` prefers the database value and falls back to the same local copy.
So a lineup can look saved on the device that saved it and be absent for everyone else, and a schema
problem is invisible to the manager. `teams.lineup` does exist in the authoritative schema, so today
this is dead weight rather than a live bug — but a fallback that reads like success hides the next real
failure. Fix belongs with the Phase 2 club routes: `PATCH /v1/teams/:id` returns the row it wrote, so
"saved" means saved.

## Fixed in this phase but worth re-checking at runtime

These compiled and were reviewed, but cannot be exercised from this sandbox (no Supabase credentials,
no network to the project):

1. Signup end-to-end as a new fan, including the Manager/Media request path with the migration applied.
2. `UserManagement` approve/reject on a real pending request, and the last-admin refusal.
3. `ProfilePage` username/phone save (must pass the guard trigger; sending `email` or `role` must fail).
4. `recordMediaView` increments by exactly 1 under concurrent loads, and 0 for unpublished rows.
5. The F-01 probe from a fan token.
6. Admin reading `profiles` (User Control list) after the read policy narrowed — must still work;
   anonymous `GET /rest/v1/profiles` with the anon key must now return `[]`/403 rather than rows.

## Explicitly not done in Phase 1

Moving writes into the Worker; deleting or merging the Match Control files; wiring FCM; creating
advertising/sponsorship tables; reformatting the legacy `src/pages/**` tree; running any SQL against
production; rotating the anon key (harmless in principle, but it also invalidates `.replit` and the
docs until they are updated — a deliberate, human-owned step).
