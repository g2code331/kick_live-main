# `supabase/` — the database authority

This directory is where schema truth starts converging. Before Phase 1 there were **five** SQL files
in the repository root, each able to "set up the database", each with a slightly different policy set.
Nobody could tell which one production matched, which is how a privilege-escalation hole survived
review: fixing one file left four others that recreate it.

## Which file is authoritative

One answer, generated from the others: **`SETUP.sql` is the only file a new project needs to run.** You paste it whole into the
project's SQL editor (staging, then production) — step 3 of [`../docs/SETUP_WALKTHROUGH.md`](../docs/SETUP_WALKTHROUGH.md).

| File                                                                                                 | Status                                                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP.sql`                                                                                          | **the one file to run on an empty project** — generated | `KICKLIVE_FINAL_SCHEMA.sql` + every `migrations/*.sql`, concatenated verbatim in apply order, each section fenced by `BEGIN/END` banners and a `select` that names it. Regenerate with `npm run sql:bundle`; `npm run sql:bundle:check` (and CI) fail if it drifts from the sources. Never hand-edit it — edit the sources.                                                                                                                       |
| `../KICKLIVE_FINAL_SCHEMA.sql`                                                                       | **authoritative base schema** — source of section 1     | 15 tables, both helper functions, `handle_new_user` / `handle_new_match_stats` triggers, and the policy set named below. Idempotent; its `DROP POLICY IF EXISTS` list also removes the legacy policy names so an old project converges.                                                                                                                                                                                                           |
| `migrations/*.sql`                                                                                   | **authoritative deltas** — sources of sections 2..10    | Everything since — starting with the Phase 1 hardening migration.                                                                                                                                                                                                                                                                                                                                                                                 |
| `../SUPABASE_COMPLETE_SCHEMA.sql`, `../SUPABASE_NEW_PROJECT_SETUP.sql`, `../supabase_migrations.sql` | **deleted 2026-09-12 — do not resurrect or run**        | The three superseded root files. They predate Phase 1, each with a weaker policy set, and every new-project incident started with someone pasting one. They now exist only in git history; anything reading this README should run `SETUP.sql` instead.                                                                                                                                                                                           |
| `../CREATE_ADMIN_PROFILE.sql`                                                                        | bootstrap-only, review before running                   | Grants the _first_ admin from a SQL editor as a superuser: you edit one line, `p_email` (or `p_user_id`), and the script refuses placeholders, markdown-linked addresses and unknown accounts rather than guessing. Deliberately **not** in `SETUP.sql`: a generated bundle must not be able to mint an admin, and a paste-and-grant file has no name in it to begin with. Nothing in the app calls it; delete it once the instance has an admin. |

## How a grant is verified in this directory

Every privilege assertion in the base schema and the migrations reads `pg_class.relacl` / `pg_proc.proacl`
through `public.kicklive_has_grant(role, object, privilege[, column])` — never `has_table_privilege()`,
`has_column_privilege()` or `has_function_privilege()`. Those three answer **"true" for a superuser and for
the owner of the object**, and the Supabase SQL editor is one of those, so a negative assertion fires on a
correctly hardened database while a positive one passes having checked nothing. For the same reason no
`revoke … from public` stands alone where a client role is granted something in the same file: with the
default privileges Supabase creates, `anon`/`authenticated` hold their own ACL entries, and revoking from
PUBLIC does not touch them. `tests/unit/sql-shape.test.ts` fails if either rule is broken, and
`kicklive_has_grant` itself is granted to PUBLIC on purpose — a verifier nobody may execute reports nothing.

## What `authenticated` may project (Phase 10)

A row policy can only answer _which rows_; `20260916120000_phase10_privilege_tightening.sql` is the first
migration to narrow _which columns_ as well. `profiles.email` and `profiles.phone` are no longer projectable by
`authenticated` at all, so `GET /rest/v1/profiles?select=email` answers `42501` for a signed-in fan instead of
a directory. The owner reads their own row through `kicklive_profile_self()`; an admin desk reads a bounded
contact projection through `kicklive_profile_contacts(p_ids, p_limit)`, gated on `is_admin()` **on the caller's
own token** (the Phase 8 rule — a service-role call has no subject). `service_role` keeps the full table, and
`SELECT` on every other column of `profiles` is unchanged. The migration's `do $verify$` block asserts all of
it with `has_column_privilege`, because a grant that parses is not a grant that lands.

## Policy names in use

Policies are identified by name, so the names are part of the contract. Renaming one without dropping
the old name leaves **both** active, and Postgres unions them — an accidental widening.

```
profiles: authenticated read · profiles: own insert · profiles: own update · profiles: admin all
teams: public read · teams: managers create · teams: managers update own · teams: admin all
players: public read · players: managers all · players: admin all
seasons|competitions|matches|match_events|match_commentary|match_statistics|standings|team_staff:
    public read · admin all
media: public read · media: admin and media all
team_news: public read · team_news: managers all · team_news: admin all
notifications: public read · notifications: admin all
activity_logs: admin read · activity_logs: auth insert · activity_logs: admin all
access_requests: own read · access_requests: admin read
```

## Applying changes

```bash
supabase link --project-ref <ref>
supabase db push --dry-run     # diff against the real project before touching it
supabase db push               # applies supabase/migrations in filename order
```

Or paste a single migration into the dashboard SQL editor — every file here is wrapped in
`begin; … commit;` so a failure rolls back instead of half-applying.

In order, and each one safe to re-run:

| file                                           | what it does                                                                                                                                                                                                                                | reads it changes behaviour for                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `20260909120000_phase1_security_hardening.sql` | RLS + privilege hardening; the capability matrix                                                                                                                                                                                            | everything                                                                                     |
| `20260909210000_phase3_live_match_engine.sql`  | the live engine: assignments, transitions, sequences, corrections, guards                                                                                                                                                                   | `src/lib/live/*`, `MatchControlCenter`, `MatchDetails`                                         |
| `20260910120000_phase4_read_aggregates.sql`    | three read aggregates (`kicklive_competition_standings`, `kicklive_squad_sizes`, `kicklive_is_final_status`); **indexes deliberately left commented**                                                                                       | `src/lib/data/queries.ts` (`/tables`, `/team/:id`, `/teams`)                                   |
| `20260911120000_phase5_notifications.sql`      | push + inbox: five tables (`notification_devices`, `_preferences`, `_jobs`, `_deliveries`, `match_interest`), `notifications` extended in place, the fan-out triggers, the recipient functions                                              | the Worker's `/notifications/*` routes; no client role has a write grant on any of them        |
| `20260912120000_phase6_r2_media.sql`           | the media registry: `media_assets` + insert-only `media_operations`, `can_manage_team`, 16 `kicklive_*` functions for reserve/finalize/visibility/retention/migration. **Additive only** — no `*_url` column is dropped, renamed or retyped | `workers/src/routes/media.ts`, `src/lib/media/*`; the eight `*_url` columns keep their meaning |

**None of the five has been applied to a live project from this repository** — there is no database
reachable from here, so each file's own `do $$ … $$` verify block is the only execution proof that exists,
and applying them is the first manual step in `../docs/PRODUCTION_MIGRATION_PLAN.md`.

Phase 4's file adds no table, no column and no index. The index block is commented because the phase's rule
is that an index needs a plan, and no database was available to plan against — see
`../docs/PHASE4_DATA_ARCHITECTURE.md` §4.8 and `node scripts/query-audit.mjs --explain`.

Rules for files in this directory:

1. **Additive.** No `DROP TABLE`, `DROP COLUMN`, or `DELETE`. Dropping something is a separate,
   reviewed, data-backed-up operation (see `../docs/PRODUCTION_MIGRATION_PLAN.md`).
2. **One file per concern, timestamped** `YYYYMMDDHHMMSS_name.sql`, never edited after it is applied.
3. **Idempotent anyway** (`IF NOT EXISTS`, `CREATE OR REPLACE`, `drop policy if exists` first), so a
   re-run on a project that drifted cannot destroy data.
4. **Self-checking**: each migration ends with a `do $$ … $$` block that raises if its own change is
   not in place, and a commented verification/rollback section.
5. `notify pgrst, 'reload schema';` after adding functions or views, or PostgREST keeps serving the
   old catalogue.

## What is _not_ here yet

Deliberately deferred, with the phase that owns it in `../docs/PRODUCTION_MIGRATION_PLAN.md`:

- ~~`advertisers` … `sponsorships`~~ — **written, still unapplied.** The plan's single combined phase became
  two migrations, and the table names settled differently: Phase 7 (`20260913120000_phase7_advertising.sql`)
  made `advertisers`, `advertisement_campaigns`, `advertisements`, `ad_placements`, `advertisement_placements`,
  `ad_events`, `advertisement_analytics`; Phase 8 (`20260914120000_phase8_sponsorship.sql`) made `sponsors`,
  `sponsorship_packages`, `sponsorships`, `sponsorship_status_transitions`, `sponsorship_config`. The two
  systems are still not folded into `media`/`competitions`, and — the part that mattered enough to write twice
  — not into each other: the only seam is `sponsorships.advertisement_campaign_id`, nullable, written by
  nobody yet. Neither migration has been applied to a real project; both are idempotent and replay clean.
- `predictions` / `fan_votes`: `src/pages/PredictionsPage.tsx` renders without a backing table, so
  predictions are currently browser-local. The table + RLS + (Phase 2) Worker endpoint are the fix.
- ~~`device_tokens` for push~~ — written as `notification_devices` in the Phase 5 migration (token as a
  credential: `unique (provider, token)`, RLS owner-only, no client write grant); still unapplied, so the
  table does not exist in a live project until that file is run.
- Media writes out of the browser: **done for the storage plane** in Phase 6 (`media_assets`, the R2
  bucket, no `supabase.storage` call left in `src/`), **not done** for the editorial plane — `POST /media`
  and friends are still declared-and-unimplemented, so an article row is still inserted from the client
  and only its `image_url` goes through the Worker.
- The rest of the move of writes out of the browser and into Workers (Phase 2), after which most
  client-facing write policies can be narrowed to `service_role`-only.
