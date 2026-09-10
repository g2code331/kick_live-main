# `supabase/` — the database authority

This directory is where schema truth starts converging. Before Phase 1 there were **five** SQL files
in the repository root, each able to "set up the database", each with a slightly different policy set.
Nobody could tell which one production matched, which is how a privilege-escalation hole survived
review: fixing one file left four others that recreate it.

## Which file is authoritative

| File                                | Status                                                 | What it is                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../KICKLIVE_FINAL_SCHEMA.sql`      | **authoritative base schema**                          | Superset of the other four: 15 tables, both helper functions, `handle_new_user` / `handle_new_match_stats` triggers, and the policy set named below. Idempotent, and its `DROP POLICY IF EXISTS` list also removes the legacy policy names so an old project converges. |
| `supabase/migrations/*.sql`         | **authoritative delta, applied after the base schema** | Everything that changed since — starting with the Phase 1 hardening migration.                                                                                                                                                                                          |
| `../SUPABASE_COMPLETE_SCHEMA.sql`   | superseded — do not run                                | Older full schema. Its `profiles` read policy is `USING`-only, i.e. strictly weaker than the current one; running it after the hardening migration re-opens the escalation hole.                                                                                        |
| `../SUPABASE_NEW_PROJECT_SETUP.sql` | superseded — do not run                                | Partial early setup (9 tables, inline subqueries instead of `is_admin()`, **no policies on `profiles` at all**).                                                                                                                                                        |
| `../supabase_migrations.sql`        | superseded — already folded in                         | Column adds (`owner_id`, `status`, `lineup`, `gallery`, …) that `KICKLIVE_FINAL_SCHEMA.sql` now contains, plus a permissive "Authenticated users can create teams" policy and a commented-out admin policy.                                                             |
| `../CREATE_ADMIN_PROFILE.sql`       | bootstrap-only, review before running                  | Grants the _first_ admin from a SQL editor as a superuser. Nothing in the app calls it; delete it once the instance has an admin.                                                                                                                                       |

`repomix-output.xml` in the repository root is a stale generated dump of the whole tree. It is not
schema and not documentation; regenerate or delete it rather than reading it.

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

| file                                           | what it does                                                                                                                                          | reads it changes behaviour for                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `20260909120000_phase1_security_hardening.sql` | RLS + privilege hardening; the capability matrix                                                                                                      | everything                                                   |
| `20260909210000_phase3_live_match_engine.sql`  | the live engine: assignments, transitions, sequences, corrections, guards                                                                             | `src/lib/live/*`, `MatchControlCenter`, `MatchDetails`       |
| `20260910120000_phase4_read_aggregates.sql`    | three read aggregates (`kicklive_competition_standings`, `kicklive_squad_sizes`, `kicklive_is_final_status`); **indexes deliberately left commented** | `src/lib/data/queries.ts` (`/tables`, `/team/:id`, `/teams`) |

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

- `advertisers`, `ad_campaigns`, `ad_placements`, `ad_placement_events`, `sponsor_packages`,
  `sponsorships` — separate concepts, separate migrations, not folded into `media`/`competitions`.
- `predictions` / `fan_votes`: `src/pages/PredictionsPage.tsx` renders without a backing table, so
  predictions are currently browser-local. The table + RLS + (Phase 2) Worker endpoint are the fix.
- `device_tokens` for push (Phase 5, with FCM).
- The move of writes out of the browser and into Workers (Phase 2), after which most client-facing
  write policies can be narrowed to `service_role`-only.
