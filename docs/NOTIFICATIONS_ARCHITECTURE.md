# Kick Live · Production notification architecture (Phase 5)

Written before the code, so the design is on the record rather than reconstructed from a diff. Sections 1–2
are the audit of what already exists; 3–15 are the architecture; 16–21 are the parts that need a decision or
a credential from a person.

**Status legend** (used throughout, and required by the phase brief):

| word                      | means                                                                      |
| ------------------------- | -------------------------------------------------------------------------- |
| **IMPLEMENTED**           | code is in the repository and is exercised by a test that runs in CI       |
| **CONFIGURED**            | the environment has the credential/binding, which only the operator can do |
| **REQUIRES MANUAL SETUP** | implementation waits on a step listed in §20                               |
| **NOT YET IMPLEMENTED**   | designed here, deliberately not built in this pass                         |

Nothing in this document says push works. It says what is built, what is wired, and which single missing
secret separates them.

---

## 1. Audit — what exists today

Searched for: `notifications`, `sendMatchNotification`, `push`, `FCM`, `Firebase`, device tokens,
preferences, and every match-event name the brief lists. Six things exist, and four of them are not what
their names suggest.

| found                                                                                                         | what it actually is                                                                                                                                                                                       | reuse decision                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications` table (`KICKLIVE_FINAL_SCHEMA.sql` §3.12)                                                     | `id serial, title, body, match_id → matches ON DELETE CASCADE, event_type, created_at`. **No recipient, no read state, no kind.** A broadcast log, not an inbox                                           | **Extend, do not recreate.** Additive columns (§4.1); existing rows become `user_id is null` broadcasts and keep their current visibility                                                                                   |
| `notifications: public read` policy (phase-1 hardening, `:337`)                                               | `create policy … for select to anon, authenticated using (true)` — every row readable by everyone                                                                                                         | **This is the security-critical line.** Per-user rows must not inherit it; §4.5 replaces it and a test pins the replacement                                                                                                 |
| `notifications: admin all` policy (same file, `:288`)                                                         | `for all to authenticated using (public.is_admin())`                                                                                                                                                      | Keep. It is how an admin announcement is written                                                                                                                                                                            |
| `sendMatchNotification(eventType, matchId)` (`src/lib/MatchAutomation.ts:299`)                                | Browser-side `select` of the match + a `switch` over `goal / half_time / full_time / red_card` building title/body, then `insert` into `notifications`. No push, no recipient, errors swallowed           | **Move the policy, keep the copy.** The switch becomes the server-side policy in `workers/src/lib/notificationPolicy.ts` with the same wording; the browser function stays as-is and unreferenced (§1 comment in that file) |
| Its only caller: `src/pages/portals/admin/MatchDashboard.tsx:291`                                             | `await updateStandingsAfterMatch(matchId); await sendMatchNotification('full_time', matchId)` — on a screen **nothing routes to** (`grep -rn MatchDashboard src/` → no importer)                          | So no live browser write is being removed. Phase 3's rule "the console does not decide side effects" is honoured by never reviving it                                                                                       |
| `POST /notifications/subscriptions` + `POST /admin/notifications/broadcast` (`workers/src/router.ts:371-392`) | Both declared with capability, cache class, rate class, `phase: 5`, and invariants; both answer `501` through `routes/index.ts`'s `notImplemented`                                                        | **Build these two, they are the contract already reviewed.** `subscriptions` is renamed to `devices` (§5) because a 501 nobody can have called is free to rename                                                            |
| `Header.tsx` bell (`:208-241`)                                                                                | Reads `recentResults` (finished matches, last 24 h) through the Phase 4 data layer, labelled "Match Results"; navigates on `n.id`                                                                         | Not a notification inbox, and it stays as the _results_ panel. The real inbox is a new surface (§7)                                                                                                                         |
| "Notification Prefs" tab (`ProfilePage.tsx:268-291`, `ProfileDashboard.tsx:125`)                              | Three rows of `<div>`s styled as toggles, hard-coded `on: true/false`, no state, no handler, no persistence                                                                                               | **The UI is decorative today.** Replacing it with real controls is the frontend half of this phase (§6); until then the app shows switches that cannot switch                                                               |
| `AppSettingsDashboard.tsx:14`                                                                                 | `notifications: true` in a local mock settings object                                                                                                                                                     | Ignored; not wired to anything                                                                                                                                                                                              |
| `workers/wrangler.toml:138`                                                                                   | `# [[queues.producers]] # Phase 4 — standings recompute, notification fan-out` and `# [[queues.consumers]] max_batch_size = 10, max_retries = 3, dead-letter queue` — commented, with the settings chosen | **Adopted verbatim** (§11); the reserved block is the config this phase turns on                                                                                                                                            |
| `workers/src/lib/capabilities.ts:47,97`                                                                       | `notifications.broadcast` in the union and `["admin"]` in the matrix                                                                                                                                      | Used as-is. No capability is added, so the phase-1 security test's expectations do not move                                                                                                                                 |
| Firebase / FCM / `device_tokens` / Web Push                                                                   | **Nothing.** No dependency, no config, no table, no client code, no `VITE_FIREBASE_*` var                                                                                                                 | Built here. There is no half-finished integration to preserve, and no key to accidentally already be in the tree                                                                                                            |

Also confirmed absent, so nothing was duplicated: no `push_subscriptions`, no `web_push` table, no
`device_tokens` table (`grep -in "fcm|firebase|device_token|registration_token|push" KICKLIVE_FINAL_SCHEMA.sql`
→ no match), no queue binding, no cron trigger, no `workers/src/queues/`.

Two adjacent systems this phase must not re-implement:

- **The Phase 3 live engine.** `match_events` rows carry a server-assigned per-match `sequence`, and every
  status change goes through the state machine. Notifications are a _consumer_ of that, not a second log
  (§8).
- **The Phase 4 data layer.** The inbox and preferences are read through `src/lib/data` (keys, TTL classes,
  invalidation) and written only through `src/lib/api` → Worker routes, per the standing rule that the
  browser does not write privileged rows.

## 2. The three facts that shape everything else

1. **Supabase is the record; the queue is the wake-up.** A job exists as a row before it exists in a queue,
   and any queue message that is lost is recovered by the next sweep. This is Phase 3's durability rule
   applied to delivery: the system never acknowledges a notification into a queue as its only durable copy.
2. **A notification is not a delivery.** `notifications` row = "this person had this thing in their inbox".
   `notification_deliveries` row = "this device was sent this, and here is what FCM said". An offline phone
   produces the first without the second succeeding (§13).
3. **A device token is a credential.** It is write-only from the client's side: the API accepts one, never
   returns one, and no log line or queue payload contains one (§14).

## 3. Responsibilities

```
  MATCH EVENT (referee/console)            ADMIN ANNOUNCEMENT
          │                                       │
          ▼                                       ▼
  CLOUDFLARE WORKER  ── validate, authorize, rate-limit, dedupe-key ──►  SUPABASE (RPC, one transaction)
   workers/src/routes/…                                                       ├─ match_events / status
                                                                              ├─ notifications (per recipient)
                                                                              └─ notification_jobs (PENDING)
          │  ctx.waitUntil(queue.send({ jobId }))                             after commit
          ▼
  CLOUDFLARE QUEUE  kicklive-notifications  (batch 10, retry 3, DLQ)
          │
          ▼
  QUEUE CONSUMER  workers/src/queues/notifications.ts
     claim job (FOR UPDATE SKIP LOCKED) → load recipients → batch tokens
          │
          ▼
  FCM HTTP v1  (the only component that talks to Firebase; the only holder of the server credential)
          │
          ▼
  Android · iOS · Web/PWA      →  delivery outcome written back per device
```

| component | owns                                                                                                                                                       | must not                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supabase  | recipients, preferences, history, read state, job rows, delivery rows, **idempotency constraints**, RLS                                                    | hold a Firebase credential; be reached directly from a browser for a notification write                    |
| Worker    | auth (JWT → role from Postgres), capability check, input validation, the _policy_ (event → who + what copy), job creation, rate limiting, device lifecycle | send FCM inside a match-event request; trust a client `user_id`; write a job after the DB commit failed    |
| Queue     | throughput smoothing, retry accounting, dead-lettering                                                                                                     | be the only copy of anything; carry a token or a recipient list in its payload                             |
| FCM       | delivering a message to a token; telling us a token died                                                                                                   | be the record of what a user was told (a delivered push may have no row, and a row may never be delivered) |

## 4. Data model

Everything here is additive or new. No column is dropped, no type changed, no row deleted. `notifications`
gains columns that are all nullable-with-defaults so the table remains valid for whatever it holds today.

### 4.1 `notifications` — the inbox, on the existing table

| added column                                    | why                                                                                                                                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id uuid → profiles(id) on delete cascade` | the recipient. `null` = broadcast, which is exactly every row that exists today                                                                                                                                                  |
| `kind text not null default 'system'` + CHECK   | the category (`goal, red_card, half_time, full_time, match_start, match_reminder, team_update, competition_update, news, system, announcement`); mirrors the preference keys so a job and a preference speak the same vocabulary |
| `dedupe_key text`                               | the idempotency key (§10), unique **with** `user_id`                                                                                                                                                                             |
| `read_at timestamptz`                           | §7                                                                                                                                                                                                                               |
| `metadata jsonb not null default '{}'`          | deep-link payload (match id, team id, score) — never a token, never a score _claim_: it copies what Postgres derived                                                                                                             |
| `priority smallint not null default 0`          | lets an emergency announcement sort above a goal in a busy inbox without a second table                                                                                                                                          |
| `expires_at timestamptz`                        | a 90-minute "match starting" nudge should not be unreadable next season; NULL = keep                                                                                                                                             |

Indexes: `(user_id, read_at nulls first, created_at desc)` for the inbox, unique `(user_id, dedupe_key)` for
idempotency, and `(created_at) where user_id is null` for the broadcast panel. The unique index is
`create unique index … on notifications (user_id, dedupe_key) where dedupe_key is not null` — partial, so
the pre-existing rows (which have no key, and several share `match_id`) cannot collide with each other and
fail the migration. That detail is the difference between a safe migration and one that aborts on real data.

### 4.2 `notification_preferences`

One row per user per category, plus the global switch — normalised rather than a jsonb blob, because the
recipient query filters on it and `metadata->>'goals' = 'true'` is how a fan-out index dies.

```
user_id uuid → profiles on delete cascade
kind text CHECK (same list as notifications.kind)
enabled boolean not null default <per-kind default>
channels text[] not null default '{inbox,push}'   -- 'inbox' only = silent in the app, no push
updated_at, created_at
primary key (user_id, kind)
```

Defaults are deliberately **per kind**, and the phase brief's "do not force users to enable every
notification type" is honoured by the _global_ switch, not by silently enabling push for a stranger:
`enabled` defaults true for `goal`, `full_time`, `half_time` (a match the user is watching), false for
`red_card`, `match_reminder`, `team_update`, `competition_update`, `news`, true for `system`, and the global
switch (`profiles`-level, §4.2.1) defaults **on** so the app is not born deaf. A `notification_devices` row
that no one ever created means no push regardless — so "defaults on" costs nothing until a user opts in.

`channels` is an array rather than two booleans because the phase after this adds email/SMS and `'{inbox,
email}'` must not need a migration.

### 4.2.1 the global switch

`profiles.notifications_enabled boolean not null default true`. On `profiles` rather than a
`notification_preferences` row with `kind = 'all'`, because the row-per-kind table is a set of categories and
"everything off" is not a category. It is the only column Phase 5 adds to an existing table besides
`notifications`, and it is the one a client may write through the Worker route only (RLS keeps `profiles`
writes owner-scoped, already true from phase 1).

### 4.3 `notification_devices`

```
id uuid pk default gen_random_uuid()
user_id uuid not null → profiles on delete cascade
provider text not null CHECK ('fcm','webpush')      -- §16: two flavours, one column, no second backend
token text not null                                  -- sensitive; see the grants below
platform text not null CHECK ('android','ios','web','unknown')
app_id text                                          -- package name / origin, for "which client is this"
ua_family text, ua_major int                         -- parsed from the registration UA, best-effort
active boolean not null default true
failure_count int not null default 0                 -- §12: the deactivation counter
last_error_code text                                 -- the FCM error name, never the response body
created_at, updated_at, last_seen_at, last_sent_at
unique (provider, token)                             -- the same token cannot belong to two users
index (user_id) where active
```

`unique (provider, token)` is the load-bearing line for security: it means a token that walks in through a
different account **moves** rather than duplicates, so a stolen-token registration cannot keep feeding the
previous owner and a re-login on a new account cannot leave the old one subscribed. The handler does
`insert … on conflict (provider, token) do update set user_id = excluded.user_id, active = true, …` and a
test pins that an attacker's re-registration cannot create a second recipient row (§19 case 17).

### 4.4 `notification_jobs` and `notification_deliveries`

```
notification_jobs:  id, dedupe_key unique not null, kind, match_id, competition_id, team_id,
                    title, body, metadata, status CHECK (pending,running,sent,partial,retry,failed),
                    attempts, max_attempts, next_attempt_at, recipient_count, created_at, started_at,
                    finished_at, last_error
notification_deliveries: id, job_id, device_id, user_id, status CHECK (sent,failed,skipped_invalid_token),
                    provider_message_id, fcm_error, attempt, created_at, sent_at
                    unique (job_id, device_id)
```

`notification_jobs` is the durability object (§11); `notification_deliveries` is the observability object
(§18) and the reason "which phones did this goal reach" is a query rather than a log grep. Both keep
`last_error`/`fcm_error` as _codes and short messages_, never the FCM response body (which echoes the token).

### 4.5 Policies (the part that must be read carefully)

| table                                          | who may do what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifications`                                | select: `user_id = (select auth.uid()) or user_id is null` — the **replacement** for `notifications: public read`, so a fan still sees broadcasts and sees nobody else's inbox; insert/update: owner or admin, with the owner derived by the Worker (service-role writes bypass RLS; the policy exists so a _direct_ client call cannot forge a row for someone else); delete: owner, admin for broadcasts                                                                                                                                                                                   |
| `notification_preferences`                     | select/insert/update for `user_id = auth.uid()` only, **no delete** (a missing row already means "the default", so deleting is not a meaningful user action and would look like an opt-out); admin read for support                                                                                                                                                                                                                                                                                                                                                                          |
| `notification_devices`                         | select **denied outright** (`using (false)`) and delete for `user_id = auth.uid()`; **no INSERT or UPDATE policy at all**, because registration is a function that derives the user from `auth.uid()` and a client with a direct insert path could point any token at any account. **No admin read of tokens**: an admin can revoke (delete) via the Worker route, and the route's response omits the token — RLS on the columns a browser can reach, plus a view `notification_devices_public` (`id, platform, provider, app_id, active, created_at, last_seen_at`) for the settings screen |
| `notification_jobs`, `notification_deliveries` | `to authenticated using (public.is_admin())` for select and **nothing else**: no client insert path at all, so the only writer is the Worker's service-role client. A fan cannot enumerate jobs, and a leaked anon key cannot queue a send                                                                                                                                                                                                                                                                                                                                                   |

Every new table gets `alter table … enable row level security` and `revoke all … from anon, authenticated`
in one `do $$ … foreach t in array […] $$` block (a loop, so the sixth table cannot be forgotten the way a
hand-written fifth was), plus narrow grants.

**RLS is enabled, never forced.** `force row level security` also applies to the table owner, and every RPC in
this phase is `security definer` running as the owner — so forcing it would make each function insert zero
rows into its own table. That is not a hypothetical here: Phase 1 recorded it for `access_requests`
("Deliberately NOT `force row level security`") and Phase 3 repeated it for `match_assignments`. Client-side
protection does not come from FORCE: it comes from the revokes plus the _absence_ of INSERT/UPDATE policies,
both of which apply to `anon`/`authenticated` regardless. The migration's verification block asserts
`relrowsecurity and not relforcerowsecurity` on all five tables, and raises if a later hardening pass adds
FORCE — because the failure mode is invisible from the API (a 200 from a function that wrote nothing).

No `alter default privileges … revoke update, delete` anywhere: that pattern broke writes in an earlier phase
and is still forbidden.

### 4.6 `match_interest` — the only relationship table this phase adds

```
user_id uuid not null → profiles on delete cascade
match_id integer not null → matches on delete cascade
created_at timestamptz default now()
primary key (user_id, match_id)
```

The brief's step 18 says: integrate follow/favourite tables if they exist, and do not build a favourites
system here. None exists (`grep -in "follow|interest" KICKLIVE_FINAL_SCHEMA.sql` → nothing), and the
audience resolution in §13 needs _some_ per-user relationship to be more useful than "everyone with a device".
`match_interest` is that seam: one small owner-scoped table, written by the "notify me about this match"
button on `MatchDetails`, dropped by the same button, and the natural place a later `team_follows` union
into. RLS: owner select/insert/delete, no update, no admin read (an admin has the audience count from the job
row and does not need to know who is watching what).

No `notification_topics` table, no topic subscriptions, no `competition_follows`, no `saved_matches` — those
are §20's documented non-goals, and the design does not need them to be correct.

## 5. Device registration

```
POST /api/notifications/devices      { token, provider, platform, appId? }      → 201 { id, active: true }
DELETE /api/notifications/devices/:id                                            → 204
GET  /api/notifications/devices                                                → 200 [{ id, platform, provider, appId, active, createdAt, lastSeenAt }]
```

Rules, and why:

- `user_id` is taken from the verified JWT (`principal`), never the body. A body that _contains_ `user_id`
  is a **400 `VALIDATION_FAILED`** rather than an ignored field: silently dropping a client's attempt to
  address another user teaches the attacker that it is accepted-but-not-used. The validator lists the allowed
  keys and rejects the rest.
- Anonymous → 401. Push is not offered to signed-out visitors in this phase (§7 of the brief): no anonymous
  device identity, no `client_id`-cookie model, no "we'll figure out ownership later" table. The design
  leaves room: `user_id` is the only principal, so introducing topics later adds a _second_ table
  (`notification_topics`) rather than redefining this one.
- Cap: 10 active devices per user (`max_active_devices`, checked in the same RPC), returning
  `429 DEVICE_LIMIT` — a rate limiter alone does not stop 10 000 registrations spread over a day (§19 case 1).
- Re-registration of the same `(provider, token)` refreshes `last_seen_at` and re-activates (§12's recovery
  path: a token FCM deactivated comes back when the user opts in again, from either account).
- The response never echoes the token. The client already has it; nothing needs to read it back.

## 6. Preferences API

```
GET  /api/notifications/preferences   → { notificationsEnabled, categories: { goal: {enabled, channels}, … } }
PUT  /api/notifications/preferences   → the same shape, after write; full-document semantics
```

`PUT` with full-document semantics (the client sends the whole set, the server upserts all rows it implies)
because a patch endpoint over a per-row table is how a UI and a database end up disagreeing about what "off"
meant. The route upserts via one RPC, so a settings save is one round trip and one transaction, and the
frontend's optimistic update can be reverted against the returned document (§23).

## 7. History, unread count, read state

```
GET  /api/notifications/inbox?limit=20&before=<iso>   → { items: […], unread: n }
POST /api/notifications/inbox/:id/read                → 204
POST /api/notifications/inbox/read-all                → 200 { updated: n }
```

`unread` is computed in the same RPC as the page (`count(*) filter (where read_at is null)` for the caller),
so the header badge cannot drift from the list it sits next to. Mark-read is
`update notifications set read_at = now() where id = $1 and user_id = auth.uid()` — the `user_id` predicate
lives in the SQL, not only in RLS, so "mark another user's row read" is 0 rows updated rather than a policy
refusal that a client cannot distinguish from a bug (§19 case 18). `read-all` is capped (`limit 500`) and
returns the count, because a user with 40 000 notifications should not be able to lock a connection.

Read state is stored **per notification row**, not per (user, event): the row _is_ the per-user record
(§4.1), so a broadcast has no read state and does not need one. If broadcast read tracking is ever wanted it
is a new table, not a change to this one.

## 8. Where match events create jobs

Phase 3's authoritative write path is `POST /matches/:matchId/events` (and `PUT …/state` for transitions,
`POST …/finalize`) with the DO in front. Jobs are created by an **`AFTER INSERT` trigger on `match_events`**,
in the same transaction as the event row:

```sql
create or replace function public.kicklive_notification_job_for_event()
returns trigger … as $$
begin
  if new.corrects_event_id is not null then return new; end if;      -- a correction stays silent
  if new.event_status <> 'active' then return new; end if;           -- a voided row stays silent
  v_kind := case new.event_type when 'goal' then 'goal' … else null end;
  if v_kind is null then return new; end if;                         -- not every event is a push
  …
  insert into public.notification_jobs (dedupe_key, kind, match_id, …)
  values (format('match:%s|seq:%s|kind:%s', new.match_id, coalesce(new.sequence, -new.id), v_kind), …)
  on conflict (dedupe_key) do nothing;                                -- replayed event → no second job
  return new;                                                         -- never null: an AFTER trigger's
end; $$;                                                              --   return is ignored, and a BEFORE
                                                                      --   one would drop the referee's write
create trigger kicklive_notification_job
  after insert on public.match_events
  for each row execute function public.kicklive_notification_job_for_event();
```

(The alternative considered was a line inside `kicklive_record_match_event()`. Rejected: that function is not
the only writer of `match_events` — the Durable Object's write-behind, an admin correction and any future
importer also insert — and a notification rule that lives in one caller is a rule the next caller forgets. A
trigger cannot be forgotten.)

Three reasons, in order of how much they matter:

1. **An event without its job is a lost notification.** If the job row were written by the handler after the
   event RPC returned, a Worker crash between the two is exactly the gap the brief's duplicate/failure list
   is about. One transaction means the event and the wake-up either both exist or neither does.
2. **The dedupe key needs the sequence, and only the RPC has it.** `sequence` is assigned server-side per
   match (Phase 3), so `match:12|seq:57|kind:goal` is unique for the _goal_, not for the _word_ goal — a
   corrected-and-replayed event gets the same key and is refused by the constraint, while two genuine goals
   in one match are two jobs.
3. **The referee never waits for FCM.** The handler's only post-commit work is `ctx.waitUntil(queue.send({
jobId }))` (step 11 of the brief); the match-event response has already been built from the RPC result.

Consequence to keep visible: the notification write path lives in the Phase 3 SQL, so the events RPC grows
by one insert. A goal therefore notifies when the event was accepted **by Postgres**, which is the
brief's "only from authoritative server-side events"; a client that renders a score from its own optimistic
write gets nothing, and a browser tab that replays its click gets one job because the key came from the
sequence the server assigned.

**No job is created while the migration is unapplied**, because the job row is created by a trigger that the
same migration installs: no migration, no trigger, no notification — and never a failed event. The trigger
also never returns NULL (it returns `NEW` on every early exit) because on a `BEFORE` trigger a NULL would
discard a referee's goal event; the return value of an `AFTER` trigger is ignored, and the comment in the SQL
says so, because "ignored" is a property of the timing, not of the function.

## 9. The policy, in one file

`workers/src/lib/notificationPolicy.ts` is the only place that decides who gets what. `router.ts`, the DO and
the frontend do not know any of it.

| authoritative fact                                                                | kind          | audience (resolved in SQL, §13)                                                              | push?                                                                                                                              | copy                                                              |
| --------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| event `goal` (own goal counted against the conceding side, as Phase 3 derives it) | `goal`        | users following either team **or** the competition **or** with an open `match:<id>` interest | yes                                                                                                                                | `⚽ GOAL!` / `Team 2 – 1 Team` + scorer when `player_id` resolves |
| event `half_time` / `extra_time_half_time`                                        | `half_time`   | same                                                                                         | only if the category is on                                                                                                         | `Half time` / `Half time, extra time`                             |
| event `second_half_start`                                                         | `match_start` | same                                                                                         | yes — it rides the "tell me when this match is happening" category rather than inventing a twelfth one                             | `Second half` / `Second half under way: Team v Team`              |
| event `full_time`                                                                 | `full_time`   | same                                                                                         | yes                                                                                                                                | `Full time` / `Final: Team 2 – 1 Team`                            |
| event `red_card`                                                                  | `red_card`    | same                                                                                         | **no by default** (preference default false — the brief's "do not force users to enable every type" applied to the noisy category) | `🟥 Red card`                                                     |
| event `kickoff` (written by the transition, never by a client)                    | `match_start` | same                                                                                         | yes                                                                                                                                | `Kick-off: Team v Team`                                           |

Two things this table refuses to do. It does not key off `matches.status`, because a status is a summary and a
notification is about a moment — and the moments already arrive as `match_events` rows, including the lifecycle
ones (`kicklive_lifecycle_event_for` writes `half_time` / `second_half_start` / `full_time`), so one trigger on
the event table covers every row here and no second hook on `matches` is needed. And it does not notify on
`match_abandoned`, even though abandonment is arguably the most serious moment of all: the brief's
authoritative list stops at `MATCH_ENDED`, so adding it would be a notification nobody asked for. It is listed
in §21 as a Phase 6 decision with its own category and default, not slipped in under `system`.
| admin route `POST /admin/notifications/broadcast` | `announcement` or `system` | the audience the admin selected, capped (§14) | yes | admin-supplied title/body, validated (length, no URL in `metadata` beyond known keys) |

Deliberately **not** in this table: goal-of-the-week marketing, "someone else scored in your league" (that is
`competition_update`, opt-in, and only ever generated by the cron sweep), and anything derived from
`match_commentary` — commentary rows are not authoritative facts (§1 audit).

The switch's four cases from `sendMatchNotification` are preserved _as wording_ (including the emoji) so a
fan sees the text the app has always shown; what changes is who computes it and who is allowed to trigger it.

## 10. Idempotency

Three independent constraints, because the brief's six causes of duplicates fail in three different places.

| layer     | key                                                                               | what it stops                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| job       | `notification_jobs.dedupe_key unique` = `match:<id>\|seq:<sequence>\|kind:<kind>` | duplicate API requests, a replayed event, a browser refresh resubmitting, a Worker retry of the whole RPC, a correction that re-derives the same goal |
| inbox row | `notifications (user_id, dedupe_key) unique where dedupe_key not null`            | the same event reaching one user twice through two fan-out passes; two jobs for one event cannot produce two rows per user either                     |
| delivery  | `notification_deliveries (job_id, device_id) unique`                              | **queue retries** and batch replays: a delivery row exists ⇒ that device was already told for that job, so the consumer skips it before calling FCM   |

Sequence-based keys are the reason the WebSocket reconnects and background-tab replays in the brief's list are
harmless: `sequence` is assigned once, by the server, and is what Phase 3 already carries in every frame —
so a client that reconnects, refetches and re-posts still refers to the same server-side event, and the
constraint is the thing that decides, not a cache.

Claiming a job is separately idempotent, and by a predicate rather than a lock:

```sql
update public.notification_jobs
   set status = 'running', started_at = coalesce(started_at, now()), attempts = attempts + 1
 where id = $1 and status in ('pending','retry') and next_attempt_at <= now() and attempts < max_attempts
returning *
```

Two consumers (a queue redelivery racing the cron sweep) both run that statement; one gets a row, the other
gets zero and returns `NOT_CLAIMABLE`. `attempts` is incremented **here** rather than at completion, so a
consumer that crashes mid-batch still burns an attempt instead of retrying forever — and
`kicklive_finish_notification_job` refuses to write a `retry` onto a job that has run out of budget, which is
the second half of "no infinite retry". (`for update skip locked` was the first design; it is equivalent here
and worse in one respect: a lock is released when the transaction ends, while a status of `running` outlives
it, which is exactly what a consumer that dies mid-batch needs to leave behind for the sweep to find.)

## 11. Queue, retries, DLQ, and the sweep

```
[[queues.producers]]  queue = "kicklive-notifications"  binding = "NOTIFICATION_QUEUE"
[[queues.consumers]]  queue = "kicklive-notifications"
  max_batch_size = 10        max_batch_timeout = 5
  max_concurrency = 5        min_backoff_delay = 10      max_backoff_delay = 3600
  max_retries = 3            retry_delay = [10, 60, 300]
  dead_letter_queue = "kicklive-notifications-dlq"
```

Consumer contract, per batch:

1. Parse the message. Not `{jobId: number}` → record `MALFORMED_JOB` against the DLQ path and **ack** (a
   poison message that retries forever is a worse outage than one lost notification).
2. Claim the job (§10). Nothing to claim (already `sent`/`running` by another consumer) → ack.
3. Resolve recipients (§13) and split into batches of 500 tokens.
4. Send each batch through the delivery adapter; map every outcome to a delivery row + token deactivation
   (§12). A transient failure sets `status='retry'`, `attempts+1`, `next_attempt_at = now() + backoff` and
   **rethrows** so Cloudflare redelivers the message (that is how `retry_delay` gets used); a permanent
   failure sets `failed` with a code and acks.
5. When every recipient has a delivery row, `status='sent'` (or `partial`, when some devices failed
   permanently) + `finished_at` + `recipient_count`.

**The cron sweep** (`triggers.cron = "*/5 * * * *"`) selects `status in ('pending','retry') and
next_attempt_at <= now()` and processes the same way, so a dropped queue message or a Worker that died
between commit and `queue.send` still delivers within five minutes. This is why the queue is a wake-up and
not a record: the two together give at-least-once delivery with an idempotent consumer, which is the only
honest guarantee in this design. Cloudflare's DLQ keeps undeliverable messages inspectable; a DLQ message is
never a lost job, because the job row is the truth and says `retry`/`failed` with a reason.

`notification_jobs.max_attempts` defaults to 6, not 3, because Cloudflare's retries and the sweep's retries
are separate counters and a token that failed four times in ten minutes is usually a device asleep, not a
broken subscription.

## 12. Invalid tokens

| FCM outcome                                                           | meaning                | action                                                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200                                                                   | delivered              | delivery `sent`, `device.last_sent_at = now()`, `failure_count = 0`                                                                                               |
| `UNREGISTERED` (403) or `SENDER_ID_MISMATCH`                          | token dead at Google   | **deactivate** (`active = false`, `last_error_code`), delivery `skipped_invalid_token`, do not retry. A sweep never re-activates it; only a new registration does |
| `INVALID_ARGUMENT` naming the token                                   | malformed registration | same as above, plus `failure_count + 1` so a client bug shows up in the metrics rather than in silence                                                            |
| `INVALID_ARGUMENT` naming something else                              | our payload is wrong   | job → `failed`, `MALFORMED_PAYLOAD`, **no** device deactivation (blaming the user's device for our bug is how you lose a subscriber base)                         |
| 429 / 500 / 502 / 503, `UNAVAILABLE`, `INTERNAL`, `DEADLINE_EXCEEDED` | transient              | job → `retry`, backoff; delivery rows not written for the untried tokens                                                                                          |
| `SENDER_ID_MISMATCH`, `API_KEY_DISABLED`, 401 from the token mint     | our credentials        | job → `failed` with `FCM_CONFIG`, one Worker log line, **no** device changes, and the sweep stops claiming new jobs for it (§18's alertable counter)              |
| batch partially invalid                                               | mixed                  | per-message results are read individually; a batch endpoint is _not_ used, see below                                                                              |

Two deliberate omissions. There is no batch `messages:send` (`:batch`) call, because a batch response is not
per-message atomic in the ways that matter for deactivation and the recipient sets here are small per job;
and there is no "retry invalid tokens later" path — the brief's "do not retry permanently invalid tokens
forever" is satisfied by deactivation being immediate and the sweep's predicate requiring `active = true`.

A device that is `active = false` for 30 days is deleted by the sweep (`DELETE … where not active and
updated_at < now() - interval '30 days'`) so a churned user base does not accumulate credentials, and the
retention window is a constant in the migration, not a policy the Worker can silently change.

## 13. Fan-out and batching

The naive version — one query per user to resolve preferences, one insert per notification, one FCM call per
device — is what the brief's performance step forbids. The shape here:

1. **One entitlement rule, in `kicklive_notification_audience(kind, match_id, competition_id, team_id)`**, and
   three callers of it: the device query the Worker sends to, the inbox insert, and the audience count an admin
   sees before a blast is accepted. The rule is `profiles.notifications_enabled` **and** the per-kind
   preference, where a **missing preference row is the default, not an opt-out** — `left join` plus
   `coalesce(p.enabled, (kicklive_preference_defaults() ->> kind)::boolean)`. An inner join there is the single
   easiest way to make every account that never opened the settings screen silently un-notifiable, and it looks
   identical to "nobody wants notifications" in the metrics.

   Scoped how? For a match-linked job, every user with a `match_interest` row for that match (the lightweight
   table this phase _does_ add, written by the fan UI's "notify me" button); `announcement`/`system`/`news` go
   globally. There is no `team_follows`/`competition_follows` table (§18 of Phase 4's audit), so this v1
   audience is **narrower** than "everyone who follows either team": it is "everyone who asked about this
   match". An earlier draft also widened `full_time`/`match_start` to users whose history showed they opened a
   match of that competition in the last 30 days; that is **not implemented** — inferring an audience from
   browsing history to widen a push list reads like surveillance to the person being pushed at, and it would
   have made the §20 narrowing invisible in exactly the way this document exists to prevent. When a follow
   model lands, the union goes in this one function and nowhere else.

2. **The device query** (`kicklive_notification_recipients(job_id)`) joins that audience to
   `notification_devices` filtered by `active`, `provider = 'fcm'`, `failure_count < 5` and the `push` channel,
   **and** by `not exists (… notification_deliveries job_id + device_id …)` — the last clause is the replay
   guard that turns a queue redelivery into a no-op _before_ FCM is called. It is the only query in the system
   that returns a token; it is `security definer`; it is granted to no client role.
3. **Set-based insert of inbox rows** (`kicklive_materialise_notifications`): one `insert … select` over the
   audience with `on conflict (user_id, dedupe_key) … do nothing`, keyed `job.dedupe_key || '|u:' || user_id`.
   It reads the audience and **not** the device list, which is what makes history independent of push success —
   deriving it from the device query would tie the record of a goal to the state of someone's phone.
4. **Token batches of 500** with a per-batch concurrency of 5 (`max_concurrency`), each FCM call awaited
   individually but issued in parallel, and the batch's outcomes written back in **one**
   `kicklive_record_notification_results(job_id, results[])` call. That single function writes the delivery rows
   (`on conflict (job_id, device_id) do update`), retires the devices FCM said are gone, strikes the ones that
   failed for another reason, and forgives the ones that succeeded — the consumer makes no round trip per
   device, which would make the bookkeeping the slow part of a goal.
5. `recipient_count` is recorded when the job is created, and `kicklive_finish_notification_job` recomputes
   sent/failed **from the delivery rows** rather than from what the caller believes it sent, so "this goal
   reached 12 431 devices" is a fact the evidence supports, and the latency metric (§18) has a denominator.

There is no per-user `for` loop in the consumer, and no `for` loop around FCM either: the only loop is over
batches, and its body is two awaited calls. The brief's "do not make match-control operations wait" is
satisfied structurally, because fan-out never runs in a request handler at all.

**The SQL surface, by who may call it.** 19 functions: nine self-service (`register/unregister device`,
`set_notification_preferences`, `notification_defaults_document`, `notifications_page`, `mark_notifications_read`,
`mark_all_notifications_read`, `set_match_interest`, `preference_defaults`) — every one of them deriving the user
from `auth.uid()` and taking no user id as an argument; eight service-role (`claim_notification_job`,
`materialise_notifications`, `notification_audience`, `notification_recipients`,
`record_notification_results`, `finish_notification_job`, `pending_notification_jobs`,
`prune_notification_devices`); one reachable by no role at all because it is a trigger
(`notification_job_for_event`); and one admin-only (`broadcast_notification`). The line is drawn so that
everything which touches a token, or another user's rows, is on the side a browser cannot call. §9.7 of the
migration counts the functions at runtime and `tests/unit/phase5-notifications.test.ts` counts them in the
file, so the two numbers cannot drift apart.

Read the whole section as one sentence: **the database decides who is told, the Worker decides when, and the
queue is only what makes "when" not mean "inside the referee's request".**

## 14. Security

- **Secrets.** `FCM_SERVICE_ACCOUNT_JSON` is a Worker secret (`wrangler secret put`), per environment, never
  in `wrangler.toml`, never in `.dev.vars` committed to the tree (`.dev.vars.example` documents the shape
  with placeholders, matching `SUPABASE_SERVICE_ROLE_KEY`'s existing treatment). `scripts/check-secrets.mjs`
  already fails on a JWT-shaped literal in shipped source (`jwtLiteral`, `scripts/check-secrets.mjs:92`) but
  knows nothing about PEM keys, so a service-account private key is added to its
  patterns (`"private_key": "-----BEGIN` and `firebase.googleapis.com/v1/projects/.*/service_accounts`),
  because "never commit a private key" needs a gate to be a rule.
- **Public vs private Firebase config.** The browser needs `apiKey`, `authDomain`, `projectId`,
  `messagingSenderId`, `applicationVisibi…gerVapidKey` — the _public_ web config, which Firebase itself
  documents as safe to ship in a client bundle, plus nothing else. It reaches the browser through
  `VITE_FIREBASE_*` (build-time, public by definition) **or** `GET /api/notifications/config`, which returns
  the same fields from Worker `[vars]`; the route exists so a deployment can change them without rebuilding
  the SPA. The private half (service account JSON, OAuth scope) is only ever in the Worker's secret store,
  and §5 of the phase brief's "do not expose Firebase server credentials to frontend code" is enforced by
  the fact that no frontend module imports anything that reads it.
- **Logs.** `logError`/debug lines run through `redact()`: any string under 200 chars that is not a known
  code is left alone, and a device token is matched by shape (FCM tokens are long, base64url-ish; Web Push
  keys are base64 of 65+ bytes) and replaced with `token:<sha256[0..12]>`. The hash prefix is kept so "same
  token twice" remains debuggable without making the log a credential store. Queue payloads carry `{jobId}`
  only, so a Cloudflare dashboard that shows message bodies shows nothing sensitive (§21's queue-payload
  check is satisfied by construction, not by care).
- **CORS.** Unchanged and sufficient: `ALLOWED_ORIGINS` is exact-origin and `env.ts` rejects `*`. The new
  routes are `cache: "none"` (they are per-user and mutating) so no CDN can serve one user's inbox to
  another — the mistake this line prevents is a `private` cache class on a notification list.
- **Replay.** FCM's own idempotency is not relied on. The `unique (job_id, device_id)` delivery row is the
  replay guard, and a re-delivered queue message that arrives after the job is `sent` claims nothing and
  acks (§10). A captured `POST /notifications/devices` replay is a no-op: the conflict clause updates
  `last_seen_at`.
- **Abuse (STEP 19).** Device registration: `mutation` rate class + the 10-active-device cap + `unique
(provider, token)`. Broadcast: `admin-blast` (10/60 s, already in the table) + audience cap
  (`NOTIFICATIONS_MAX_AUDIENCE`, default 50 000, refusing with `AUDIENCE_TOO_LARGE` rather than silently
  truncating) + a required `confirm: true` field on any broadcast above 1 000 recipients, which is the
  brief's "confirmation for mass notifications" and is deliberately a _payload_ field so it survives a
  scripted caller (the UI's dialog is a second, human-facing layer). Only an admin capability can create a
  job for anyone else; there is **no** route through which an ordinary user can send a push, and
  `GET /api/me`'s capability list will show `notifications.broadcast` to admins only.
- **Rate limiting per recipient, not only per caller.** A job's fan-out is bounded by `max_recipients_per_job`
  so a bug in the audience query cannot spend an hour hammering FCM on behalf of one goal; over the cap the
  job is `failed` with `AUDIENCE_TOO_LARGE` and the inbox rows are still written (§13's set-based insert
  happens before any push), which keeps "the app said something" true when "the phone said nothing" happens.

## 15. Web Push and the PWA

The existing shell is installable (`public/site.webmanifest`, `sw.js` from `scripts/build-pwa.mjs`), and the
service worker already bypasses `/api`. Web push needs three things beyond that, and the honest status of
each:

1. **Permission, asked at a meaningful moment.** No `Notification.requestPermission()` on load, and no
   interstitial: the affordance is the "notify me about this match" button on the match page and a
   one-line prompt in the profile's Notifications tab. The UI asks for the browser permission **only**
   inside a click handler on those, which is also the only context where a `denied` state is recoverable
   (the browser's site-settings sheet). `Notification.permission` is read, never requested, at mount — so a
   returning user with `granted` sees the switch on and no dialog.
2. **A token.** `getToken(messaging)` from the Firebase SDK (with `onMessage(messaging, …)` for the
   foreground case), obtained lazily by a **dynamic import** of `firebase/messaging` inside the opt-in
   handler: no visitor who never opts in pays the bundle
   cost, and Phase 4's split keeps `firebase` out of every chunk but the opt-in chunk (this is the one new
   frontend dependency; the alternative — hand-rolling FCM's registration protocol — is not a thing Google
   supports). If `VITE_FIREBASE_…` vars are absent, the flow stops with "push is not configured on this
   deployment" instead of failing silently, and the module never imports the SDK at all.
3. **Registration with the API** — §5 — then nothing. The service worker receives
   `push` → reads `event.data.json()` → shows a notification, and `notificationclick` → focuses/opens
   `/#/match/<id>`, which is how the app's own hash routing works; a `url` from the payload is opened only
   after `new URL()` parses it against the app origin, because a push payload that can set `notificationclick`
   to an arbitrary URL is a phishing primitive.

`applicationServerKey` (VAPID) is a public key in `[vars]`; the _private_ VAPID half is not needed at all
when delivery goes through FCM, which is why the brief's "FCM is the delivery abstraction" is honoured rather
than approximated: Kick Live never speaks raw Web Push to Google's endpoint, so it never holds a VAPID
private key, and §20 lists only the public half as a manual step.

## 16. Android and iOS, later, without a second backend

The table already has `platform`, `provider` and `app_id`, and the consumer already resolves recipients
without branching on any of them. What a native client needs and this design does not have: an APNs
_fallback_ (FCM covers APNs for FCM-addressed devices, so this is only about dropping FCM), a per-platform
copy override (today one copy for all platforms, and `metadata` carries what a native renderer would need),
and token-refresh handling (an FCM token rotates; `unique (provider, token)` plus "on conflict, re-point"
already makes a rotated token an update rather than a new device). No `notification_devices_android`.

## 17. Observability

Metrics are counters over the job/delivery tables — the brief's "notification latency" is
`finished_at - started_at`, and the queue's own dashboard numbers are deliberately not trusted as the record.

| metric                                                 | source                                                               | alert-worthy                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `jobs.created`                                         | insert returning count (one log line per job, at debug)              | no                                                         |
| `jobs.processed`, `.retried`, `.failed`                | status transitions, with `last_error` codes                          | `failed` by code                                           |
| `deliveries.sent`, `.skipped_invalid_token`, `.failed` | `notification_deliveries` group by status                            | `skipped_invalid_token` > 5 % of a job = credential drift  |
| `invalid_tokens.deactivated`                           | `notification_devices` where `last_error_code in ('UNREGISTERED',…)` | sustained rate = a stale subscriber list                   |
| `latency.p50/p95`, `fanout.recipients`                 | job timestamps + `recipient_count`                                   | p95 > 60 s while a match is live                           |
| `fcm.config_error`                                     | the 401/`API_KEY_DISABLED` path                                      | **immediately**, since it means every job now fails        |
| `sweep.recovered`                                      | jobs the cron picked up that the queue did not                       | any nonzero while the queue is healthy = a binding problem |

`GET /api/matches/:matchId/diagnostics` (Phase 3) is the precedent the notification equivalent follows:
`GET /api/notifications/diagnostics` (admin capability) returns the counts above plus the oldest pending job,
and — like Phase 3's — it is a _read of state_, not a new subsystem. Worker logs use `logError(requestId, …)`
with `redact()` (§14), so the request id ties a send to an audit row without either containing a token.

## 18. Testing, and what cannot be tested here

Every scenario the brief lists, and where it lives. `workers/` tests run against the same fakes the Phase 3
tests use, and `KICKLIVE_FCM_MODE=mock` (the default when `FCM_PROJECT_ID` is unset) swaps in
`mockDelivery`, which returns `projects/mock/messages/<n>`, honours a scripted failure list, and never opens a
socket — so **no test needs a Firebase project, a key, or a network** (§26 of the brief).

| #    | case                                    | test                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–2  | register / deregister a device          | `tests/unit/notifications-devices.test.ts` (handler against a fake Supabase: owner derived from the principal, second device allowed, 11th refused, `user_id` in body → 400, re-register re-points the token)                                                |
| 3–4  | preferences get/put                     | same file: defaults per §6, full-document PUT, an unknown kind → 400                                                                                                                                                                                         |
| 5–8  | create/history/read/read-all            | `tests/unit/notifications-inbox.test.ts`: the SQL predicates are asserted from the migration text (the pattern Phase 3 established for `kicklive_*` SQL) — `user_id = auth.uid()` present, `is_admin()` not used where ownership matters, `read-all` limited |
| 9–12 | goal / half-time / full-time / red-card | `tests/unit/notification-policy.test.ts`: for each authoritative fact, kind + audience selector + copy, and that `red_card` defaults off                                                                                                                     |
| 13   | duplicate event                         | same file + the job insert's `on conflict (dedupe_key) do nothing` in the migration text; a replayed sequence produces one job, and two real goals produce two                                                                                               |
| 14   | queue retry                             | `tests/integration/notifications-queue.test.ts` (worker-local): a script-`503` mock → job `retry` with `next_attempt_at`, second attempt succeeds, delivery row written once                                                                                 |
| 15   | invalid token                           | same: `UNREGISTERED` → device inactive, delivery `skipped_invalid_token`, job `sent`/`partial`, no retry                                                                                                                                                     |
| 16   | transient failure                       | same, with `429`; and `INVALID_ARGUMENT` about _our_ payload does **not** deactivate anything                                                                                                                                                                |
| 17   | unauthorized device registration        | anonymous → 401; another user's `user_id` → 400; another user's `device_id` in DELETE → 404 (RLS-shaped, asserted in the policy text too)                                                                                                                    |
| 18   | unauthorized notification access        | mark-read of a foreign row → 0 updated, no error; inbox query returns only own rows + broadcasts                                                                                                                                                             |
| 19   | admin authorization                     | `notifications.broadcast` refused for fan/team_manager/media (`403 FORBIDDEN`), allowed for admin, `confirm` required above the threshold, audience cap enforced                                                                                             |
| 20   | permission flow                         | `tests/unit/web-push-flow.test.ts`: the client module requests permission only inside the opt-in handler, stores nothing before the server confirms, and reports `unsupported`/`denied`/`unconfigured` distinctly                                            |
| 21   | offline registration retry              | same file: a failed `POST` leaves a pending intent in `sessionStorage`, retried on the next `online`/visibility change, never applied optimistically to the UI's device list                                                                                 |
| 22   | Worker failure                          | job row already committed → sweep picks it up; asserted by a test that runs the sweep handler with the queue disabled                                                                                                                                        |
| 23   | database failure                        | `POST /notifications/devices` when the insert errors → 503 `DEPENDENCY_FAILED`, the client keeps its token locally and retries, and no `active` row is claimed                                                                                               |

**What is not verified, and cannot be from this sandbox:** anything requiring a real Postgres (the migration
is parse-reviewed and pattern-tested, not executed — same limitation Phase 3 recorded in §17.4 of
`PRODUCTION_ARCHITECTURE.md`), a real Cloudflare queue (the consumer is unit-tested against message-shaped
objects; `wrangler queues` is not available offline), a real FCM endpoint (no credentials, and
`nodejs_compat` + `crypto.subtle` JWT signing is tested against a locally generated key pair, not Google), or
a browser tab (no headless Chrome: permission prompts, service-worker push handlers and the notification
click-through are asserted structurally in source and unit-tested, not driven). "A goal reaches a phone" is
therefore **not** claimed yet; §20 is the list of what stands between this code and that sentence being
true.

## 19. Files this phase touches

| new                                                           | role                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `supabase/migrations/20260911120000_phase5_notifications.sql` | the model, RLS, audience/job SQL, verification block               |
| `workers/src/lib/notificationPolicy.ts`                       | the only place event → who/what copy is decided                    |
| `workers/src/services/fcm.ts`                                 | FCM HTTP v1 delivery adapter + `redact()` + mock adapter           |
| `workers/src/services/notifications.ts`                       | device CRUD, preferences, inbox RPC wrappers, job creation helpers |
| `workers/src/routes/notifications.ts`                         | the 8 handlers                                                     |
| `workers/src/queues/notifications.ts`                         | consumer batch logic + `scheduled()` sweep                         |
| `docs/NOTIFICATIONS_ARCHITECTURE.md`                          | this file                                                          |

| modified                                                                     | why                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers/src/router.ts`                                                      | the two stubs become real; 6 routes added, each with capability + rate class + invariants                                                                                                                                             |
| `workers/wrangler.toml`                                                      | queue producer/consumer + DLQ + `triggers.cron` + `[vars]` for the public Firebase web config; the commented block becomes active                                                                                                     |
| `workers/src/index.ts`                                                       | `queue()` and `scheduled()` exports                                                                                                                                                                                                   |
| `workers/src/env.ts`                                                         | `FCM_*`, `NOTIFICATION_*` vars, `FIREBASE_WEB_CONFIG`                                                                                                                                                                                 |
| `supabase/migrations/20260909210000_phase3_live_match_engine.sql`            | **no** — Phase 3's file is applied history and is never edited; the guarded job insert ships as a _new_ migration that replaces the RPC body (`create or replace function`), which is the documented way this repo evolves a function |
| `src/pages/ProfilePage.tsx`, `src/pages/portals/shared/ProfileDashboard.tsx` | the decorative toggles become real controls                                                                                                                                                                                           |
| `src/components/Header.tsx`                                                  | the bell keeps "Match Results" and gains an unread badge fed by the inbox                                                                                                                                                             |
| `src/lib/notifications/*`                                                    | the client: opt-in flow, device sync, preferences through the data layer                                                                                                                                                              |
| `scripts/check-secrets.mjs`                                                  | the private-key patterns                                                                                                                                                                                                              |

Deleted: nothing. `sendMatchNotification` and `updateStandingsAfterMatch` stay in
`src/lib/MatchAutomation.ts` with a header recording that the notification half moved server-side in Phase 5
and why the file still exists (its standings logic is one of the three competing rules Phase 4's F-05 lists).

## 20. Manual setup — the gap between IMPLEMENTED and working

Required before any push leaves this code, in order, each one verifiable:

1. Firebase project; enable Cloud Messaging. For web push: add a **web app**, copy the public config, and set
   `FCM_WEB_PUSH_CERTIFICATES` = the `publicVapidKey` Firebase shows you.
2. For Android: `google-services.json` is a _client_ artifact (not this repo's). For iOS: upload the APNs
   key in Firebase — none of that is a Kick Live secret.
3. Service account JSON → `npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON --env production` (and staging).
   The JSON must never be committed, uploaded to a gist, or put in `workers/.dev.vars` on a branch.
4. `npx wrangler queues create kicklive-notifications` and `… kicklive-notifications-dlq`, per environment;
   paste the ids the command prints into the `[[queues.producers]]`/`[[queues.consumers]]` blocks (they are
   environment-specific, which is why the ids are not in the committed file).
5. `npx supabase db push` (or the SQL editor) with the Phase 5 migration, **then** run the file's own
   `VERIFY` queries: the audience function returns a row for a seeded device, and
   `select polname from pg_policies where tablename='notifications'` shows the owner-scoped policy and not
   `notifications: public read`. A deployment where step 5 has not happened still works — jobs are simply
   never created (there is no trigger to create them), which is the intended fail-safe.
6. `VITE_FIREBASE_*` at build time **or** the five `FIREBASE_*` Worker vars (the route serves whichever
   exists). Leaving both unset is supported and shows "push not configured" in the UI.
7. Confirm in the Firebase console that a test message is addressed to `topic: none` of the kind this app
   uses — no topic is subscribed by this design (§8 of the brief: devices are addressed individually, and
   `match:<id>`/`team:<id>` topics stay a documented extension point in `notification_topics`, not created
   here).

Known narrowings to revisit in Phase 6, none of which is a secret: no follow/team-subscription audience yet
(§13.1), no `match:<id>` topics (each match fan-out is a per-device send; topics become worth their
management cost above roughly the point where per-job recipient counts exceed FCM's 500-per-message batch
comfortably, which is a _measurement_, not a guess), no email/SMS channel despite `channels` being ready for
one, and no client-side dedupe beyond the constraints (a client that posts the same event twice relies on the
server, which is correct).

## 21. Commands

```bash
node scripts/worker-routes.mjs                      # the route/capability table, now incl. notifications
npm run build:worker 2>/dev/null || npx tsc -p tsconfig.workers.json --noEmit
node scripts/run-tests.mjs unit                      # incl. the five notification test files
node scripts/worker-local.mjs                        # :8787 with mock FCM (no credentials needed)
curl -s localhost:8787/api/notifications/config       # public web config or {"configured":false}
supabase/migrations/…phase5_notifications.sql        # run in the SQL editor; it self-verifies
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON --env staging
```

`scripts/worker-local.mjs` needs the `NOTIFICATION_QUEUE` binding to exist as an in-memory stand-in, which is
what `KICKLIVE_QUEUE_MODE=memory` does: `queue.send` appends to an array the local harness drains
synchronously, so the _consumer_ logic (the part with all the interesting failure handling) is exercised by
the same command developers already run, rather than only by tests.
