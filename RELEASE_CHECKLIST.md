# Kick Live — release checklist

Status vocabulary, used literally and nowhere softened:

| mark                     | meaning                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `READY`                  | implemented, checked in this repository, and the check is named next to it                         |
| `REQUIRES CONFIGURATION` | code is done; an environment is not (a secret, a binding, a bucket, a var)                         |
| `REQUIRES TESTING`       | code is done and static-checked; the check that would prove it needs Postgres/Cloudflare/a browser |
| `BLOCKED`                | cannot be verified from this workspace at all, and nothing here pretends otherwise                 |
| `NOT IMPLEMENTED`        | the capability does not exist; see the named "deliberately not done" section that explains why     |

Verified in this workspace on 2026-09-12 with no Postgres, no Cloudflare login and no browser:
`npm run typecheck` (all three `tsc` projects) 0 errors — re-run with exit codes preserved, after it emerged that
an earlier pass had been piping `tsc` into `tail` and reading `tail`'s status; a claim that rested on a broken
command is not a verification · `npm run build:web` succeeds (fan boot 514.5 KiB raw /
152.3 KiB gzipped over 5 chunks; 74 files, 7.30 MiB total) · `npm run build:desktop` bundles main+preload ·
`npm run test:unit` 583 pass / 0 fail · `npm run test:integration` 99 pass / 0 fail ·
`npm run worker:routes -- --check` 101/101 · `node scripts/check-secrets.mjs` finds no committed secret
and reports the 2 required CI secrets as unset here (correct — this sandbox has none) · `npm run format:check`
clean · `npm run gates` 23 pass / 0 fail / 3 skip (workflows ride on `main` now, so the old `ci:install`
failure is gone; each skip names the CI job that covers it) · `npx wrangler deploy --dry-run` exits 0 for
both `staging` and `production`
(all bindings resolve, no warnings). **`npm run check:sql` did not run: there is no Postgres binary, no container runtime
and no root in this environment, so `initdb` is impossible.** That single fact is why five rows below say
`REQUIRES TESTING` rather than `READY`.

---

## A push to `main` now builds, provisions, migrates and deploys — to staging

`ci/workflows/full-stack.yml` (installed to `.github/workflows/`, `npm run ci:check` keeps the copies identical)
runs the whole chain a human was previously doing by hand, in the order that makes each step's absence visible:
pair check → gates + `sql:run` (the migrations _executed_) → Cloudflare provisioning → staging migrations via
`psql --single-transaction` → the staging Worker → a probe of the live URL → **only then**, and only with an
explicit `deploy_production=true`, the production Worker. `deploy-web.yml` still owns Pages; its default target
moved from `production` to `staging`, so a push cannot deploy production by default while a build job and a
deploy job could not disagree about which environment they were serving. Production remains a deliberate act, the
same way the stable update channel is.

**Why the config job exists first.** Staging's Supabase project was moved to `opvkvbabryuipzwcanrv`, the URL was
updated, the anon key was not — and every check in the repository called that valid, because each value is
individually well-formed. The user-visible symptom was `POST /auth/v1/signup → 401 (Unauthorized)`. So:

- `scripts/check-project-pair.mjs` (`npm run pair:check`) reads **all three** values in every environment of
  `workers/wrangler.toml` and every generated `.env.<mode>`, decodes the key's `ref` claim, and refuses any triple
  that does not name one project. This is the only check that fails on the exact state above.
- `npm run web:env` _refuses to write_ a mismatched pair rather than propagating it into the browser bundle, and
  `web:env:check` now distinguishes the two states honestly: a mode file that is **wholly** one revision behind is
  a documented lag with a note (a working app pointed at the old database), while a **half-moved** file is fatal.
  The difference between those is precisely the difference between "annoying" and "401 on the login page".
- `src/lib/env.ts` gained a fourth boot rule: a JWT-shaped key whose payload has no usable `ref` is called out as
  the legacy-key/`sb_publishable_…` confusion rather than being sent to GoTrue to fail opaquely.
- `scripts/provision-cloudflare.mjs` (`npm run cf:check` / `cf:provision`) derives queues, R2 buckets and KV
  namespaces **from the config** rather than restating them, so a binding added to `wrangler.toml` without a
  `queues create` is a red check instead of a queue that silently never exists. It never deletes, and it will not
  paste a new KV id into the config for you — that is a commit a human reviews.
- `verify` is **21 checks** (was 20): the workflow-expression check exists because writing a workflow through a
  tool that redacts `${…}` produced exactly the file that parses as YAML and fails on the runner. `ci:check`
  cannot see that; now something does.

**Still an operator action, and only an operator can do it:** paste the new staging project's anon key into
`[env.staging.vars].SUPABASE_ANON_KEY`, run `npm run web:env`, commit both files; then in GitHub → Settings →
Environments create **`staging`** (it does not exist yet) with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`SUPABASE_DB_PASSWORD`, `SUPABASE_STAGING_PROJECT_REF=opvkvbabryuipzwcanrv` and the variable `STAGING_WEB_URL`,
and optionally a required reviewer on `production`. This session's GitHub token is read-only for
environments/secrets (`401` on create), so those four things cannot be done from here.

## Fixed 2026-09-13: the privilege self-checks could not see what they were checking

Caught by an operator, not by the suite: pasting `supabase/SETUP.sql` into the Supabase SQL editor raised
`hardening failed: authenticated can still update profiles.role directly` on a database where that revoke had
in fact landed. The assertion was written with `has_column_privilege()`, and the editor session is a superuser —
so it answers `true` for every role, every negative check fires on a hardened database and every positive check
passes unchecked — in seven files across four phases (1, 3, 5, 7, 8, 9, 10). Two changes, both asserted by
`tests/unit/sql-shape.test.ts`:

- every privilege check now reads the ACL (`pg_class.relacl` / `pg_proc.proacl` / `pg_attribute.attacl` via the
  new `public.kicklive_has_grant`), which reports what was granted regardless of who is asking. A NULL ACL is
  answered `false` for non-owners — the answer a real client role would get — and an object name that resolves
  to nothing raises, so a misspelled assertion cannot pass. Column grants come from `attacl`, **not** from
  `relacl`, which is what the first draft of that helper got wrong.
- `revoke … from public` no longer stands alone where a file grants a client role execute: with the default
  privileges Supabase creates, `anon`/`authenticated` hold their own entries, so phases 1, 3, 4, 6 and 7 were
  revoking from a pseudo-role that never had the grant. The ads block that claims "everything else is
  service-role only" was true of the RLS policy and false of the grant; it is now both. Trigger and internal helpers are deliberately left to `from public` alone — revoking execute
  from `authenticated` there would break the inserts whose own triggers call them.

The hole is real but narrow (a signed-in caller could EXECUTE an admin-only `kicklive_ad_*`/media function,
which each still gates on `is_admin()` internally, so it was a second line of defence rather than a bypass),
and it is the reason this class of assertion is now unreadable in any other shape.

## The admin paste that refused a _correct_ file, and a Pages deploy that "succeeded" with nothing in it

Both came from the same operator round, and both were bugs in what this repository tells you to do.

**`CREATE_ADMIN_PROFILE.sql` refused `g2code33@gmail.com`** — "nothing to do on purpose". The file used a placeholder
_string_ as both the thing to overwrite and the sentinel to compare against, so an operator whose real address
happened to equal it was refused as unedited. A sentinel that can collide with the value it stands in for is not a
guard. Both inputs now default to `null` (nothing to overwrite), the "nothing supplied" refusal fires only when both
are null, and **existence in `auth.users` is the only real test** — its message now states the user count, because
"0 auth users" means _sign up first_ and "N auth users" means _your address is what is wrong_. Six executed cases
cover it, including the exact one that failed here, plus the `p_user_id` path end to end.

**The Pages deploy uploaded 75 files and served "KickLive is not configured."** Not a Pages failure: `npm run
build:web` ran without the `VITE_SUPABASE_*` pair, and wrangler ships whatever `dist/web` holds. The previous advice
— export the pair inline on the build line — is the kind of step that gets omitted on the _second_ of two copy-pasted
commands. There are now tracked, generated mode files (`.env.staging`, `.env.production`, written by `npm run
web:env` from `workers/wrangler.toml`, drift-checked by `web:env:check` and by `verify`) and `npm run
build:web:staging` / `:production`. A missing mode file makes the **build refuse to run** instead of producing an
unconfigured artefact. The bundle also carries `VITE_EXPECTED_PROJECT_REF`, which closes the case the old URL↔key
cross-check could not see: a _consistent_ pair belonging to the other environment (staging's URL and staging's key,
in a production bundle) now refuses at boot and names the mode to rebuild with. `check-secrets` counts the mode files
as a source and prints where each value came from, so a fresh clone no longer reports two "missing required secrets"
for values that are deliberately public and committed.

`npm run verify` is **20 checks** now (was 18): mode-file sync, and the migrations executed on PGlite — both cheap,
both run on a machine with no database and no Cloudflare account, and both would have caught a real defect from this
week.

## The SQL now runs in CI-adjacent tooling, and four more real defects came out of it

`supabase/SETUP.sql` is executed, not read: `npm run sql:run` (and the fallback inside `npm run check:sql`) applies all
846 statements to a real PostgreSQL — PGlite, WebAssembly, no server — on a database carrying Supabase's client roles
**and their default ALL privileges**, which is the only configuration in which these grants mean anything. Three of
this section's findings came from that run; the fourth came from asserting what the bundle leaves behind rather than
what it says. All four were invisible to the 600-odd tests that were green before them.

1. **`revoke update (role) on public.profiles` never worked.** A column revoke cannot touch the table-wide
   `authenticated=arwdDxt` entry, and a table-wide UPDATE already covers every column — so the headline privilege fix of
   Phase 1 was decoration, and profiles.role stayed writable by every signed-in account. Phase 1 now revokes UPDATE at
   table level and re-grants every _other_ column, derived from `pg_attribute` (via the new
   `kicklive_narrow_column_grant`), so a column added by a later phase cannot be forgotten. Both directions are asserted:
   the hole is closed **and** the ordinary profile edit still works — an over-revoked grant is an outage, not a win.
2. **`anon` could execute nine engine RPCs.** The same shape: `revoke … from public, authenticated` left anon's own
   default aclitem in place, so `kicklive_record_match_event` and friends were callable by an anonymous role (each
   refuses at `auth.uid() is null`, but the callable surface is the finding). Sixteen revokes across phases 3 and 7 now
   name the role that actually holds the entry.
3. **`anon` still held SELECT on `profiles`.** Phase 1 dropped the _policy_; the _grant_ was never revoked, so Phase 10's
   own check raised on a real Postgres. Phase 10 now revokes it from anon and PUBLIC too.
4. **`t.tgdropped` does not exist** (Phase 9 read a column of `pg_trigger` that is not there), and `dimension_ok`
   rejected `2xx` while `api.requests` uses exactly that dimension — a validator that would have refused every legitimate
   status sample. Both fixed where they live rather than by loosening the check.

Also caught by executing: `LANGUAGE sql` bodies resolve _function_ references at CREATE time, not only table
references — Phase 7 called `kicklive_ad_targeting_matches` 100 lines before defining it, so the bundle could not apply
on an empty project at all. The ordering rule in `sql-shape` now covers functions, and both the rule and the runner were
verified red on a re-created copy of that defect.

`CREATE_ADMIN_PROFILE.sql` got the treatment the rest of this file has been getting: the raw `update profiles set role`
now goes through `kicklive_set_user_role()` when an admin already exists, refuses with a named reason when it does not
and the session is not a superuser, and **verifies the role afterwards** — because a `update 0 rows` (profile row
missing) previously looked like a successful run. All four paths — unedited placeholder, autolinked address, no such
account, happy path — are asserted in `tests/unit/sql-executes.test.mjs`, including the guarantee that it leaves exactly
one admin.

Current state on this tree: unit **629/629** · integration **99/99** · typecheck clean (four configs) · `format:check`
clean · `verify` **20/20** · `ci:check` in sync · `sql:bundle:check` current · `sql:run` **846 statements, 0 failures** ·
`worker:routes -- --check` 101/101 · `gates --skip=6` 22 pass / 0 fail / 4 skip · `npm audit` **0 vulnerabilities**.
`check:sql`'s behavioural flow still needs a DSN, and none of this was run inside Supabase itself: PGlite has no
PostgREST, so RLS is not exercised for the owner.

## Third fix on the same paste path: the ACL letter was compared to a privilege name

`aclexplode()` reports `privilege_type` as a **long name** — `EXECUTE`, `SELECT`, `UPDATE` — while `r a w d D x t
U X` are the codes used by `acldefault()` and GRANT/REVOKE text. The helper was asking `g.privilege_type =
'EXECUTE'`-shaped questions with letters, so **no branch ever matched**: every negative assertion in the bundle
("is it _still_ granted? raise if so") passed for free, and the one positive assertion in phase 3 ("is the record
function _really_ granted to `authenticated`?") failed and aborted the apply. That failure is the good news: it
is the first privilege assertion in this repository that could tell a grant from a missing one. `P0001` from
`line 38` of a verify block was therefore never a hardening gap — the grant was in `proacl` the whole time.

Fixed in one place: `public.kicklive_has_grant` translates the letter to the name and **raises** on an argument
that is neither, so a wrong code is now an error rather than a silent false; call sites keep reading like the
GRANT above them. Phase 4's one hand-written `aclexplode` read had the same defect and now compares `'EXECUTE'`.
Two new `sql-shape` lints pin the shape (no comparison of `privilege_type` to anything but a real name; every
`aclexplode` branch must filter through the translated set) and one pins that the migrations keep at least two
positive assertions, since a suite of only negatives cannot detect a comparison that never matches.

## Operator run (2026-09-13, staging + production deployed) — and one documentation bug it exposed

`kicklive-api-staging` (`4a0b276e…`) and `kicklive-api` (`c3df1979…`) are deployed to the account, both from a clean
`--dry-run`, with the queue producers/consumers and the two crons attached; the two Pages projects exist but have
**no deployment yet**, so `*.pages.dev` 404s and `probe-deploy.sh` reports FAIL — correct for an empty project, and
step 5 of the walkthrough (build with an explicit `VITE_*` pair, then `pages deploy dist/web`) is what closes it.
Production's `queues.consumers` were missing on the account before this deploy and are now set from the repo config.

The operator's `npx wrangler secret put … --env staging` attempts all failed with _"No environment found with name
staging"_ + _"Required Worker name missing"_. That was a bug in **this repository's instructions**: the config lives
at `workers/wrangler.toml`, so every `wrangler` command that targets the Worker needs `--config` and the docs said
so on the deploy lines but not on the secret lines. Fixed across the nine files that carried a bare `wrangler secret`,
`npm run worker:secret -- NAME --env staging` added so the flag cannot be forgotten, and the walkthrough now names
which commands are account-level (`pages`/`queues`/`r2`/`kv`) and therefore need nothing.

That same deploy output showed `FCM_SERVICE_ACCOUNT` present in production's **vars** — the whole service-account
JSON, private key included. The key is exposed (account config, terminal scrollback, deploy history) and the deploy
has now removed it from vars without re-adding it as a secret. **Rotation is an operator action and is not done
here**: see the walkthrough's "If a deploy warns that the remote config has `FCM_SERVICE_ACCOUNT` under `vars`".

Dependency state moved too: `vite` 7.3.2 → **7.3.6** (the `server.fs.deny` bypass in the dev server, which matters
specifically because the preview binds `0.0.0.0`) and `npm audit fix` for the transitive `postcss` /
`brace-expansion` / `sharp` advisories. `npm audit` now reports **0 vulnerabilities** — previously 14 (7 high) —
and nothing else in the tree was pinned back.

## Re-verified again at `4d4fc7b` + the editor/gate follow-up

Two SQL corrections landed after the paragraph above, both on the `SETUP.sql` apply path, both proven by paste:
`public.kicklive_has_grant` had been reading a column `aclexplode()` does not expose (`g.objid`), and four call
sites asked about a _table column_ with `U` — USAGE, a sequence/function letter; UPDATE on a column is `w`. The
helper now reads `pg_class.relacl`, `pg_proc.proacl` and `pg_attribute.attacl` in that order, pins
`set search_path = pg_catalog`, and **raises** on an object name that resolves to nothing, because silent `false`
would let a typo'd assertion certify a table as hardened. `tests/unit/sql-shape.test.ts` now lints both shapes
(mutation-checked: re-insert `g.objid` or flip a code back to `U` and the two new tests go red).

The `verify` count moved to 18 because the Worker is now typechecked there too — only `npm run gates` covered
`tsconfig.workers.json` before, so `npm run verify` could pass on a broken `workers/src`. Related editor-only
fixes: `workers/tsconfig.json` (project detection, mirroring `tsconfig.workers.json`), `.vscode/settings.json`
(pin `typescript.tsdk` to the installed 5.9.3), `"baseUrl": "."` deleted from `tsconfig.base.json` rather than
papered over with `ignoreDeprecations`, and a `gates.mjs` label that still called the Worker a skeleton.

On that tree, re-run: unit **615/615** · integration **99/99** · `typecheck` clean for all four configs
(`tsconfig.json`, `tsconfig.node.json`, `tsconfig.workers.json`, `workers/tsconfig.json`) · `format:check` clean ·
`verify` **18/18** · `worker:routes -- --check` **101/101** · `gates --skip=6` **22 pass / 0 fail / 4 skip** ·
`sql:bundle:check` current · `build:web` OK (77 files, 7.28 MiB) · `wrangler deploy --dry-run` **exit 0 for both
environments**. Still unverified, and unchanged by any of the above: **executing this SQL on a live Postgres**, and
a push actually reaching a device — neither is possible in the sandbox that produced them.

## Re-verified 2026-09-13 on the Pages + one-SQL-file tree

Still no Postgres, no Cloudflare credentials and no browser here, so `npm run check:sql` remains a loud `SKIP` and the five
`REQUIRES TESTING` rows below stay where they are. What was re-run, on this exact tree, with exit codes preserved (not piped):
`npm run test:unit` **615 pass / 0 fail** · `npm run test:integration` **99 pass / 0 fail** · `npm run typecheck` **0 errors**
· `npm run format:check` **clean** · `npm run verify` **18/18** (it typechecks the Worker now) · `npm run worker:routes -- --check` **101/101** ·
`npm run sql:bundle:check` **SETUP.sql is current (10 sections)** · `npm run gates` **22 pass / 0 fail / 4 skip** ·
`npm run build:web` ships `dist/web/{functions/[[catchall]].js,_routes.json,_headers}` · `npx wrangler deploy --dry-run` **exit 0
for both `staging` and `production`**, bindings resolve, correct `SUPABASE_PROJECT_REF` per environment.

One structural note the tests now encode: `ci/workflows/` (four files, Vercel-free) is the source of truth and
`.github/workflows/` is the tracked install target Actions actually executes, but GitHub refuses any push that touches that path
from a token without the `workflows` permission. So a branch cannot carry the Pages-era rewrite of the installed copies, and the
unit test reports the mismatch as **a warning naming `npm run ci:install`** rather than a red test; step 1 of
`docs/SETUP_WALKTHROUGH.md` is where a human runs it and commits it. Absence of an installed copy is still a hard failure.

---

## 1. SECURITY

- `READY` — RLS enabled on every app table, and a repo-wide scan for `with check (true)` returns **0 hits**
  across `KICKLIVE_FINAL_SCHEMA.sql` + all nine migrations.
- `READY` — the six `using (true)` policies that remain are all `for select`: the public competition catalogue
  (phase 1's whitelist loop), `profiles` for `authenticated`, and `kicklive_match_transitions` (phase 3).
- `READY` — **Phase 10 narrowing:** `profiles.email` / `profiles.phone` are no longer projectable by
  `authenticated` at all (`revoke select` + `grant select (…)`), so a fan's JWT cannot dump the directory;
  `kicklive_profile_self()` and `kicklive_profile_contacts()` are the only doors, both definer, both gated
  (`auth.uid()` / `is_admin()`). Asserted by the migration's own `$verify$` block and by
  `tests/unit/phase10-hardening.test.ts`.
- `READY` — `role` on `profiles` is not writable by a client (`revoke update (role)`, phase 1 F-01), and the
  guard trigger refuses an email/role change from a non-admin.
- `READY` — service-role key never shipped to a browser: `supabaseAdmin()` exists only under `workers/`,
  `scripts/check-secrets.mjs` fails a build on a JWT-shaped literal in source, and the SPA refuses to boot when
  the URL's project ref and the anon key's `ref` claim disagree.
- `READY` — CORS: `ALLOWED_ORIGINS` is an explicit list, `*` is rejected in `workers/src/env.ts`, a `null`
  origin is refused by middleware; CSP comes from `shared/branding.ts` and the error page carries its own
  `default-src 'none'`.
- `READY` — CSRF: the API is bearer-token-only (no ambient cookies), so a cross-site form post has no
  credentials to ride; the auth exchange routes are Turnstile-guarded where configured.
- `REQUIRES TESTING` — Turnstile on signup/write routes degrades to "skipped" when `TURNSTILE_SECRET_KEY` is
  unset. That is right for dev and **must be confirmed as enforced in production** (`POST /auth/...` without a
  token should fail there).
- `REQUIRES TESTING` — path traversal / upload validation (phase 6): keys are
  `<kind>/<uuid>/<slot>/v<n>-<sha8>.<ext>` built server-side from a whitelist, with mime/extension/size checks
  and no SVG. Prove it with a real `wrangler dev` + a browser upload before release; the unit tests only read
  the policy table.
- `READY` — idempotency and replay: phase 3's event chain is `(match_id, sequence)` with an idempotency window,
  and phase 9's metric writer folds a replayed flush into the same row (`scripts/sql-flow.mjs` asserts both —
  see `BLOCKED` in §2).
- `BLOCKED` — no independent secret rotation has been exercised: `AD_VIEWER_KEY_SECRET`, `SUPABASE_JWT_SECRET`
  and `FCM_SERVICE_ACCOUNT` each have a documented rotation story, none has been performed here.
- `READY` (2026-09-12) — the four workflow files ride on `main` (byte-identical to `ci/workflows/`), so the
  security/branding gates run on every push; `gates` passes with 0 fail. Re-run `npm run ci:install` after
  any edit under `ci/` — drift fails `verify` by design.

## 2. DATABASE

- `READY` — nine additive migrations; filenames are timestamps and `tests/unit/phase10-hardening.test.ts`
  asserts the ordering and that the phase numbers are `[1,3,4,5,6,7,8,9,10]` (phase 2 is Worker-only, so the
  gap is intentional and a renumber is what would be wrong).
- `READY` — no destructive statement in any phase migration: no `drop table`, `truncate`, `drop schema`,
  `alter table … drop column`, or `delete from public.…` (asserted for the phase 10 file; the phases 1–9 files
  carry their own rollback sections where they are documented as comments).
- `READY` — every phase migration ends with a `do $verify$` block that raises rather than installing quietly;
  phase 9's checks both new constraints and the grant loop's coverage, because that loop is `like`-pattern
  scoped and a function outside the pattern is invisible to it.
- `READY` (2026-09-13) — **one file to run**: `supabase/SETUP.sql` is generated from `KICKLIVE_FINAL_SCHEMA.sql` + the nine
  migrations in apply order (`npm run sql:bundle`, and `sql:bundle:check` — wired into `verify` — fails on drift). The three
  superseded root files (`SUPABASE_COMPLETE_SCHEMA.sql`, `SUPABASE_NEW_PROJECT_SETUP.sql`, `supabase_migrations.sql`) are now
  **deleted**, not banner-ed: an earlier pass left them in the tree with a warning and operators kept pasting them, which is how a
  weaker policy set nearly re-landed. `supabase/README.md` is the index and says so.
- `READY` (2026-09-13) — the bundle creates the tables **before** the `LANGUAGE sql` helpers that read `public.profiles`; that
  ordering was a real paste failure on staging (`42P01`), Postgres validates `sql` bodies at `CREATE FUNCTION` time, and
  `tests/unit/sql-shape.test.ts` now fails if a section ever reads a table created later.
- `REQUIRES TESTING` — apply order on staging: paste `supabase/SETUP.sql`, then
  `node scripts/check-sql.mjs --dsn … --allow-any-database` (never `--fresh` against a live project) and require `runFlow`,
  `runSponsorshipFlow`, `runObservabilityFlow` to print `ALL PASS`. The last two have never been executed by anyone.
- `REQUIRES TESTING` — phase 8/9/10 seed data: rate-card prices in `sponsorship_packages` must be reviewed
  against the real contracts, and `observability_config`'s buckets/thresholds (`p95_alert 1500 ms`,
  `error_rate_alert 0.05`, `rollup 14 d`, `daily 400 d`, `audit_retention 0`) are engineering defaults, not a
  policy decision somebody signed.
- `READY` — audit trail: `activity_logs` is append-only (delete refused; update refused except the profile FK's
  `on delete set null`), written by `kicklive_audit_record` with the subject from `auth.uid()`. A `delete`/
  `update` from `service_role` is refused — asserted in the (unexecuted) flow, and by trigger-text assertions in
  the unit suite.

## 3. CLOUDFLARE (Worker, Queues, Durable Objects, KV)

- `READY` — one Worker (`kicklive-api`, `src/index.ts`, `nodejs_compat`, `compatibility_date = 2026-09-01`),
  101 declared routes, **0 of them `implemented: false`**; `scripts/worker-routes.mjs --check` keeps
  `workers/README.md`, the router catalogue and the handler table in agreement.
- `READY` — staging/production are `env.staging` / `env.production` blocks with per-environment names, because
  named environments inherit no top-level bindings — the reason notifications working in dev and silently
  missing in prod is structurally hard to do by accident.
- `IN PROGRESS` — queues are created one name per command (wrangler takes a single positional):
  `kicklive-notifications-staging` exists since 2026-09-10; owed are `kicklive-ad-events-staging`,
  `kicklive-notifications-failed-staging`, `kicklive-notifications`, `kicklive-ad-events`,
  `kicklive-notifications-failed`, then `wrangler deploy`. Until a queue exists its producer throws and
  `/api` still serves reads (fail-safe by design).
- `READY` (2026-09-10) — **`RATE_LIMIT_KV` is bound in both `env.staging` and `env.production`** with a
  per-environment namespace and its real id in `workers/wrangler.toml`. `tests/unit/phase2-api-boundary.test.ts`
  asserts both blocks exist, carry 32-hex ids, and the ids differ — so this cannot regress to an inert
  comment. Post-deploy proof is one header on any rate-limited response: `x-ratelimit-store: kv` means the
  binding is live; `memory` means it is gone and the limiter is per-isolate.
- `REQUIRES CONFIGURATION` — `LIVE_MATCH_ROOM` Durable Object is declared; confirm the `new_sqlite` class
  binding in the deployed version and that `wrangler tail` shows alarm activity during a friendly match.
- `REQUIRES TESTING` — `cron` lines: five-minute sweep + hourly media/ad/observability maintenance. Verify in
  the dashboard that both fired after deploy; a `TELEMETRY_STALE` alert on a fresh install usually means the
  cron was not deployed rather than that the app is broken.
- `BLOCKED` — no `wrangler deploy` has run from this workspace (no Cloudflare credential), so nothing about the
  deployed shape — bindings, env names, DO class, queue consumers — has been observed rather than read.

## 4. R2 (media)

- `READY` — bucket is a binding (`MEDIA_BUCKET`), never an access key: no R2 credential exists in a browser
  bundle or in `.dev.vars.example` (the file says so and `check-secrets.mjs` would fail it).
- `READY` — server-side key shape, per-kind caps in `workers/src/lib/mediaPolicy.ts`, no SVG, `MEDIA_MAX_BYTES`
  as the outer bound; uploads are reserve → put → publish, so an abandoned upload cannot become visible.
- `REQUIRES CONFIGURATION` — create the buckets for staging and production (`npx wrangler r2 bucket create
kicklive-media-staging`, `kicklive-media`) — but R2 must be enabled on the account by a human in the
  dashboard first (`Please enable R2 through the Cloudflare Dashboard [code: 10042]`; a payment method is
  required even for the free tier). Then decide the public bucket policy (a
  custom domain / `token`-less public access is what `urlColumn` assumes). `MEDIA_MAX_BYTES` is already
  explicit in all three `[vars]` blocks — move the ceiling per environment if it ever needs to move.
- `REQUIRES TESTING` — phase 6's deferred work is still open: no thumbnail/`og:` variants, no resize, no video
  handling, no avatar upload UI, `teams.gallery` has no upload path, and legacy `media`-table objects are not
  deleted. `AdminPortal.tsx` still reads the legacy `media` table for its recent-media card, which is why that
  card shows pre-phase-6 rows — recorded, not fixed, because Phase 6's own doc marks it as a follow-up.
- `REQUIRES TESTING` — migration of pre-phase-6 rows into `media_assets` (the SQL keeps both; a cutover plan is
  in `docs/R2_MEDIA_ARCHITECTURE.md`) has never been rehearsed.

## 5. FCM (push)

- `READY` — server-side-only credentials: `FCM_PROJECT_ID` (var) + `FCM_SERVICE_ACCOUNT` (secret), signed
  HS256 JWT against `fcm.googleapis.com/v1/projects/<id>/messages:send`, `FCM_TIMEOUT_MS` bounding one send.
  No client ever holds a credential, and no route echoes the account JSON.
- `READY` — token storage is device-token-in, never-out: `POST /notifications/tokens` writes, and no read
  endpoint returns a token (asserted in the phase-5 tests and by the projection lists in `workers/src/routes`).
- `READY` — invalid tokens are deactivated on `UNREGISTERED`/`INVALID_ARGUMENT`, dedupe per (user, campaign),
  retries with backoff, DLQ for the poison messages, and `notifications/devices` metrics count
  `registered|pruned|invalidated`.
- `REQUIRES CONFIGURATION` — a real Firebase project: enable Cloud Messaging, download the service account,
  `npx wrangler secret put FCM_SERVICE_ACCOUNT`, and set `FCM_PROJECT_ID` to the **Cloudflare-side** project id
  (not the SPA's `projectId`, which is a different string when anything has been renamed).
- `REQUIRES TESTING` — one real device, one real match, one push. Unset credentials give the mock transport, so
  everything up to the wire is green without a single message leaving the account; that is a deliberate laptop
  default and also the exact thing a release must not mistake for proof.

## 6. AUTH

- `READY` — the SPA's session is the single source of identity; the Worker verifies the access token
  (`SUPABASE_JWT_SECRET`, HS256, `aud = authenticated`, exp) and re-reads `profiles` per request, so a role
  change lands on the next call rather than at the token's expiry.
- `READY` — `authenticate()` fails closed on a valid token with no profile row, and `Principal.role` is never
  inferred from anything but that row.
- `READY` — capabilities are server-side: `workers/src/lib/capabilities.ts` is the matrix, every route names one,
  and the frontend's `capabilities` field from `/api/me` is documented and asserted as _a hint, never a grant_.
  A browser cannot grant itself admin/media/team-manager/league-official: the role lives in `profiles.role`,
  `update (role)` is revoked, and every privileged route re-checks it.
- `READY` — role requests are a queue with an admin decision inside one definer transaction
  (`kicklive_request_access` → `kicklive_decide_access_request`), and Phase 10's contact-column narrowing moved
  that desk's applicant-email read onto `kicklive_profile_contacts`.
- `REQUIRES TESTING` — expired-session and refresh behaviour in the SPA (the 401 retry path in
  `src/lib/api/client.ts` and `onUnauthorized`), Turnstile on the exchange routes, and rate-limit behaviour for
  `auth-exchange` under a real burst.
- `NOT IMPLEMENTED` — no 2FA, no session revocation list, no row-level "who else is logged in as me". Accepted
  for a v1 with one admin class of user; recorded so nobody believes otherwise.

## 7. LIVE MATCH

- `READY` — one authoritative state: `kicklive_live_state` derived from validated `match_events`; the client
  sends commands, never scores. A body claiming `home_score = 8` is refused by field validation and there is no
  code path that writes `matches.home_score` outside the phase-3 functions (`tests/unit/phase3-live-match.test.ts`
  and the SQL flow in `scripts/sql-flow.mjs` both assert the derived-score rule).
- `READY` — sequence + gaps: `(match_id, sequence)` monotone, a gap is refused with `SEQUENCE_GAP` and the room
  falls back to a snapshot; reconnect resumes by sequence and takes a snapshot only when it must — counted as
  `live.reconnects{resume|snapshot}` since phase 9.
- `READY` — clock, pause/resume/halftime/fulltime via explicit commands and alarms; `live.lag` measures the
  write tail; `MatchRoom` emits `connections` at most once a minute so the gauge's `value_sum` stays honest.
- `READY` — transports: WebSocket with polling fallback (`GET /live/matches` snapshot + `?since=`), plus the
  offline queue in the app; conflicts resolve in the database, not in the browser.
- `REQUIRES TESTING` — the canonical Match Control Center (phase 10 step 9) is **not** finished: three surfaces
  exist (`MatchControlPro.tsx`, `MatchDashboard.tsx`, `AdminPortal`'s match control tab) and they share
  `src/lib/MatchAutomation.ts`. Consolidating them needs a human choosing one; the underlying state model is
  already single-authority, so this is UI debt, not correctness debt.
- `REQUIRES TESTING` — a real match: kickoff → goal → correction/reversal → halftime → fulltime, with a
  deliberate network drop and a duplicate event, on `wrangler dev` with Redis-free DO state. No browser or
  deployment here means the flow has not been run end to end by this change set.
- `NOT IMPLEMENTED` — no automatic fixture ingestion, no provider sync; `CompetitionEngine` computes standings
  and phase 4's `kicklive_competition_standings` is the read (both use `select('*')` in places — §10).

## 8. NOTIFICATIONS (beyond FCM)

- `READY` — triggers are server events only (phase 3 emits into the queue; there is no client path that
  "sends a push"), fan-out is capped by `NOTIFICATIONS_MAX_AUDIENCE` (refused, not truncated), preferences are
  honoured per user, and history is a table rather than a log line.
- `READY` — retries with backoff, DLQ, and `notifications.*` metrics for jobs/attempts/deliveries/errors/queue
  so a stalled consumer is visible as a rate rather than as silence; `NOTIFICATION_DLQ` and `INVALID_TOKEN_RATE`
  are alerts on the same numbers.
- `REQUIRES CONFIGURATION` — `NOTIFICATIONS_LINK_BASE` when a tap may land outside the SPA's origin;
  `NOTIFICATIONS_REMINDER_LEAD_MINUTES` to the value the operators want.
- `REQUIRES TESTING` — a reminder actually arriving at kick-off minus N, twice for one match (dedupe), and once
  to a user who disabled reminders.
- `NOT IMPLEMENTED` — in-app notification centre, email digest, per-device mute. Phase 5's doc records the choice.

## 9. MONITORING

- `READY` — `GET /api/observability/health` (public, three fields per component), the admin panel
  (Admin Portal → Monitoring: system health, API, live matches, notifications, advertising, alerts, privileged
  actions), 13 routes, `cache: none`, all gated on `admin.audit_read`/`admin.settings_write`.
- `READY` — P50/P95/P99 from a ten-bucket histogram, reported as bounds with an `open` flag; error rates,
  cache classes, rate-limit classes, upload outcomes, queue depth, live-room gauges; nothing keyed by user,
  device, socket or match _identity_ in the metric path.
- `READY` — `LOG_MODE` default `errors`, closed field set, `redact()` + the database's `SECRET_SHAPE_REFUSED`
  guard, `x-error-category` on every failure response, and the error envelope unchanged.
- `REQUIRES CONFIGURATION` — a log drain for stdout (the field list is fixed; configure the drain to it), and
  whatever alert delivery the operators want: alerts are **read**, not pushed — no paging is wired (`NOT IMPLEMENTED`).
- `REQUIRES TESTING` — retention: `kicklive_metrics_rollup_daily` / `kicklive_metrics_purge` ride the hourly
  sweep; watch one day roll over in staging and confirm `metric_daily` grew while `metric_rollups` did not.
- `REQUIRES TESTING` — the public health endpoint under a real degraded dependency (pull the R2 binding or the
  JWT secret in staging and watch the panel, not the logs).

## 10. PERFORMANCE

- `READY` — the query ratchet: `scripts/query-audit.mjs` + `docs/data/phase4-query-inventory.md` are asserted
  current by `tests/unit/query-ratchet.test.ts`, which is how this change set's five query moves got caught in
  seconds rather than in review. Per-file counts for unbounded reads are in that table.
- `READY` — data layer: one query spec per surface (`src/lib/data/*`), `limit()` + named columns in the reads the
  phases own, ETag/`Cache-Control` classes per route (`edge|private|none|handler`), stale-while-revalidate for
  public catalogues, live state never edge-cached, and the SPA's boot path measured by the build script at
  156.6 KiB gzipped.
- `READY` — 19 poll loops replaced by the phase-4/5 architecture; the remaining intervals are per-page and
  documented, and phase 9's `system.cron` metric makes a dead schedule visible.
- `REQUIRES TESTING` — the N+1 candidates: `src/lib/MatchAutomation.ts` (5 × `select('*')`) and
  `src/lib/CompetitionEngine.ts` (whole-table reads, console logging) are used by `MatchControlPro`,
  `MatchDashboard`, `CompetitionWizard` and `FixturesViewer`. They are pre-phase-4 admin surfaces; narrowing
  them is a named follow-up rather than a blind edit, because the only way to know a `select('*')` is safe to
  narrow is to render the screen.
- `REQUIRES TESTING` — index confirmation for the phase 5–9 reads on real volumes (`pg_stat_user_tables` after
  a week of staging), and `kicklive_observability_diagnostics`' own read cost.

## 11. MOBILE

- `READY` — responsive: 40 of 59 `tsx` files carry breakpoint classes; the pages named in the mandate
  (fixtures, match detail + live, standings, team/player profiles, news, portal desks, profile/auth) are the same
  React components at every width, and the PWA build (`npm run build:pwa`) ships a service worker + manifest.
- `READY` — desktop app builds main/preload (`npm run build:desktop`), packaging is
  `electron-builder` + the release pipeline's own gates.
- `REQUIRES TESTING` — a real device pass: safe-area insets on notched phones, 44px targets, no horizontal
  scroll at 360px, WebSocket reconnect on a network switch, and low-bandwidth behaviour of the live page. None of
  that is expressible in this workspace.
- `NOT IMPLEMENTED` — no native app, no offline-first cache beyond the queued writes and the service worker, no
  push from the desktop shell (mock transport unless `FCM_*` is set).

## 12. BACKUPS

- `READY` — the app is additive-only by construction, so a restore is "replay migrations from a base backup":
  no migration in the nine drops or rewrites anything, and each has a commented rollback section.
- `REQUIRES CONFIGURATION` — Supabase PITR or a scheduled `pg_dump` + a tested restore, off-box, with the
  retention the club can defend. Nothing in this repository does backups.
- `REQUIRES TESTING` — one restore rehearsal into a scratch project, then `npm run check:sql -- --dsn <scratch>`
  against it. A backup nobody has restored is a hypothesis.
- `READY` — R2 objects are never deleted by an app path except the documented retention sweep, which prunes
  `expired` rows only after `expires_at`, so a bad deploy cannot orphan the bucket.
- `BLOCKED` — no DR runbook exercise (RTO/RPO numbers are not measured anywhere in this repo).

## 13. DEPLOYMENT

- `READY` — the toolchain no longer assumes Node's built-in TypeScript stripping: every `node …` npm script
  imports `scripts/lib/ts-loader.mjs`, which transpiles `.ts` sources through the pinned `typescript` package and
  propagates itself to `node --test` children through `NODE_OPTIONS`. A repackaged Node (Debian/Ubuntu
  `nodejs`, `process.features.typescript === false`) previously turned 577 green tests into 23 identical
  `ERR_UNKNOWN_FILE_EXTENSION` failures, which reads exactly like a broken repository. Covered by
  `tests/unit/toolchain-ts-loader.test.ts`, including a probe that only a real `enum` compile can satisfy.

- `READY` — every resource, variable and secret is listed with its command in
  [`docs/ENVIRONMENT_SETUP.md`](docs/ENVIRONMENT_SETUP.md), including the names that must match each other across
  files (`NOTIFICATION_QUEUE_NAME` vs the `[[env.*.queues]]` blocks, and the KV id after you create it).
- `READY` — documented order: one SQL paste (`supabase/SETUP.sql`) → Worker (`wrangler deploy --env staging|production`) → web
  (`npm run build:web` → Cloudflare Pages, `public/functions/[[catchall]].js` + `_routes.json` + `_headers` for the SPA fallback and
  cache contract, same zone so `/api` is same-origin) → smoke (`GET /api/health`, the Monitoring panel, one upload, one push).
  `DEPLOYMENT.md`, `DEPLOYMENT_GUIDE.md` and `DEPLOYMENT_CHECKLIST.md` describe this repository, and
  [`docs/SETUP_WALKTHROUGH.md`](docs/SETUP_WALKTHROUGH.md) is the numbered order of operations for a fresh account (a test pins that
  the walkthrough, and every doc that offers next steps, point at Pages and at `SETUP.sql` only).
- `READY` (2026-09-13) — **the web host is Cloudflare Pages; Vercel is not in the architecture.** `vercel.json`/`.vercel/` are
  deleted, `check-secrets.mjs` asks for `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` instead of `VERCEL_*`, the _Deploy web_
  workflow runs `wrangler pages deploy dist/web --project-name kicklive-web[-staging]` and ends with `probe-deploy.sh` against the
  live URL, and `npm run verify` fails the build if a blanket `public/_redirects` ever comes back (that is how a stale asset hash
  turns into an HTML-200 and pins a dead PWA shell).
- `READY` (2026-09-13) — a post-deploy proof sheet exists: `docs/DEPLOYMENT_VERIFICATION.md`, 16 numbered checks with one command
  each (routes, assets-and-404s, `/api/health` + `x-ratelimit-store: kv`, auth, public data, websocket, offline replay, PWA,
  service worker, admin surface, CORS rejection, and both staging↔production cross-reference greps), plus the one-command Pages
  rollback. Nothing in it has been run against a live host from this workspace — there are no Cloudflare credentials here.
- `REQUIRES CONFIGURATION` — every var and secret listed in `.env.example` and `workers/.dev.vars.example`
  (which is now complete through phase 9, including `AD_VIEWER_KEY_SECRET` and `LOG_MODE`); the Vite build
  refuses a mismatched ref/key pair, so a half-configured deploy fails loudly.
- `READY` (2026-09-12) — workflows installed on `main` (see §1); `ci/` remains the source of truth and
  `npm run ci:install` the repair command if the two ever drift.
- `REQUIRES TESTING` — `verify.mjs check` (17 checks) and `gates` in CI on the pushed branch, plus a staging
  deploy observed through one live match.
- `BLOCKED` — nothing in this checklist has been deployed; no claim below is based on a successful deploy.

## 14. ROLLBACK

- `READY` — web: the static host keeps the previous build; roll back by promoting it. The Worker:
  `wrangler deployments list` → `wrangler rollback` (one command, one previous version), and the DO keeps its
  stored sequence so a rolled-back Worker resumes rather than resets.
- `READY` — database: no migration here is destructive, so the rollback of a _deploy_ is not the rollback of a
  _schema_: the nine files stay applied, and each phase's own rollback comment is the surgical alternative.
  Phase 9's and 10's rollback sections are written out for exactly this reason.
- `READY` — feature-level off-switches that do not need a deploy: `LOG_MODE=off` for log volume, an ad slot's
  `display` switch, a sponsor's status, `NOTIFICATIONS_REMINDER_LEAD_MINUTES=0` to stop reminders,
  `MEDIA_MAX_BYTES` to refuse uploads.
- `REQUIRES TESTING` — rehearse `wrangler rollback` on staging with a live match running, and confirm the fan
  page and the referee desk both survive mid-match (the DO is the stateful part; that is what to watch).
- `NOT IMPLEMENTED` — no blue/green database migration tooling, no `pg_dump`-to-restore automation, no
  automatic rollback on alert. `metrics_purge` will not delete audit rows even if someone asks it to, so a
  rollback never erases evidence — that is the intended asymmetry.

---

## Final rating

**PRODUCTION READY AFTER CONFIGURATION, AND REQUIRES FIXES IN ONE NAMED AREA.**

Configurable, verifiable, and honest about its gaps in §1–§6, §8–§14: the security posture, the privilege model,
the database path, the observability plane and the privacy boundary are implemented with tests, and the whole
list of what an operator must still _do_ (the remaining queues, R2 buckets, FCM, secrets, CI install, log drain,
backups — the KV namespace landed on 2026-09-10) is above with commands.

Two things stop this from being an unqualified `READY`:

1. **`REQUIRES TESTING` at the root of it:** nothing in the last three phases has been applied to a Postgres.
   `npm run check:sql` — which is the only check that can see whether a constraint fires — cannot run in this
   workspace, and Phase 8's identical gap is what produced the phase-8 `runSponsorshipFlow`. Ship after the
   `--fresh` run in §2 prints `ALL PASS` on staging.
2. **`REQUIRES FIXES`:** the three-surface match desk that has not been consolidated
   to one canonical control center, the two admin libraries that still `select('*')` and log to the console, and
   the 344 `<button>` elements without a `type` attribute (in React, a `button` in a form defaults to `submit` —
   an accidental submit on the referee desk is a real event, not a lint nit; `aria` coverage is thin at
   8 `aria-label`/1 `aria-modal`/1 `aria-live`, while all 19 `<img>` carry `alt`).

Full audit trail for this phase: `docs/PRODUCTION_MIGRATION_PLAN.md` (Phase 10 entry),
`docs/OBSERVABILITY_ARCHITECTURE.md`, `supabase/README.md`.
