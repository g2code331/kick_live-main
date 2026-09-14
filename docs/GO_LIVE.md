# Kick Live — go live, one line per action

`docs/SETUP_WALKTHROUGH.md` is the **setup** order of operations (it assumes nothing is provisioned). This file is the
**go-live** list: what is left when the repository is green and staging is running, in the order that never leaves a
half-live production. Each step is one action, with the output that proves it worked. If a step's proof fails, stop —
every later step inherits the broken one.

Rules that keep this boring on purpose:

- **Staging first, always.** Production receives only what staging has already run.
- **Nothing deploys production by itself.** A push to `main` provisions, migrates and deploys **staging**; production
  needs a `workflow_dispatch` with `deploy_production=true` (and, if you follow D6, a reviewer's click).
- **`npm run preflight:production` is the gate.** Run it before every attempt: one line per check, and it may say
  `WARN`/`SKIP` only for the handful of things your credentials alone can answer. Exit 0 = the repo is ready.
- **Never claim a deploy from a green preflight.** This script has no network by design; it proves the repo, not the
  account.

## A · Prove the repo (no credentials, ~2 minutes)

| #   | action                                        | proof                                                                          |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| A1  | `npm ci --no-audit --no-fund`                 | exit 0 (a benign `EBADENGINE` for `ini` on Node 22 is noise)                   |
| A2  | `npm run preflight:production`                | every `PASS`, `preflight: N/N green, 0 red`                                    |
| A3  | `npm run verify`                              | `verify (check): 22/22 checks passed`                                          |
| A4  | `npm run pair:check`                          | `every URL/ref/key triple belongs to one project`                              |
| A5  | `npm run web:env:check`                       | `.env.staging` and `.env.production` both `current`                            |
| A6  | `npm run sql:bundle:check && npm run sql:run` | `SETUP.sql is current`, then `… 0 failure(s)`                                  |
| A7  | `npm run db:check`                            | 10 rows, all `pass` (or `n/a`), against a throwaway Postgres                   |
| A8  | `npm run ci:check`                            | no sync problem (the installed `.github/workflows` copy equals `ci/workflows`) |

An `A` failure is always repo-side: a stray `}` glued to a secret in a workflow, a mode file describing the other
project, a bundle that cannot be applied. Those three have all actually happened here; each now has a check.

## B · Cloudflare: what the dashboard still needs

The repo already declares everything (`workers/wrangler.toml` is the single source of truth). Account-side work shows
up as a Worker that deploys fine and then errors on its first queue write — never as a build failure.

| #   | action                                                                                                                                                                                                                                               | proof / note                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | dash.cloudflare.com → My Profile → API tokens → Create (Custom)                                                                                                                                                                                      | scopes: `Account · Workers Scripts · Edit`, `Account · Queue · Edit`, `User · Memberships · Read`, and `Zone · DNS · Edit` only if you also do domain work. Account: `g2code332`. No Global token |
| B2  | `export CLOUDFLARE_API_TOKEN=…` `export CLOUDFLARE_ACCOUNT_ID=…`                                                                                                                                                                                     | `npx wrangler whoami` lists `Workers Scripts: Edit`                                                                                                                                               |
| B3  | `npm run cf:check`                                                                                                                                                                                                                                   | prints the diff, changes nothing                                                                                                                                                                  |
| B4  | `npm run cf:provision -- --apply`                                                                                                                                                                                                                    | creates the missing queues + R2 buckets, idempotently. KV is **not** created here — the ids are already in the TOML, and a _new_ namespace needs a human to paste its id                          |
| B5  | `npm run cf:check` again                                                                                                                                                                                                                             | no diffs, exit 0                                                                                                                                                                                  |
| B6  | five secrets per environment: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `TURNSTILE_SECRET_KEY`, `FCM_SERVICE_ACCOUNT`, `AD_VIEWER_KEY_SECRET`, each via `npx wrangler secret put "<name>" --config workers/wrangler.toml --env production` | five `Success` lines. `--config workers/wrangler.toml` is mandatory (there is no root config); repeat with `--env staging` using the staging project's keys                                       |
| B7  | `npx wrangler secret list --config workers/wrangler.toml --env production`                                                                                                                                                                           | the five names present. Values are write-only, so this is as far as verification goes from a terminal                                                                                             |
| B8  | `npm run worker:deploy:production`                                                                                                                                                                                                                   | prints `Deployed kicklive-api … https://kicklive-api-<account>.workers.dev` — **copy that URL**, do not guess a subdomain                                                                         |
| B9  | `curl -fsS https://kicklive-api-<account>.workers.dev/api/health`                                                                                                                                                                                    | `{"status":"healthy",…}` and the `project_ref` inside must be `xvksxqrmdbbinlrjctri`                                                                                                              |

Two of B6 change what the app can do and fail silently: no `TURNSTILE_SECRET_KEY` ⇒ the bot check on sign-up and the
write routes is _skipped_; no `FCM_SERVICE_ACCOUNT` ⇒ push uses the mock transport and every counter looks healthy.
Set both, or write down that you did not.

## C · Supabase production project: one paste, one diagnostic, one admin

| #   | action                                                                                                                                                   | proof                                                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Supabase → **production** project → SQL Editor → New query → paste the **entire** `supabase/SETUP.sql` → Run                                             | it prints `1 / 10: …` … `10 / 10: …` and stops at the first error, naming its own section. Re-pasting is the fix for a half-applied run — it is create-or-replace throughout, never a rollback |
| C2  | In the same editor, paste `supabase/DB_CHECK.sql` → Run                                                                                                  | every row `status = pass` (an `n/a` row is fine: that object legitimately does not exist in this build). A `fail` row's `do_next` names the file                                               |
| C3  | Sign up in the app (or Auth → Users → Add user), then `select count(1) from auth.users u left join public.profiles p on p.id = u.id where p.id is null;` | `0`. A non-zero count means the trigger did not land, i.e. C1 did not run in _this_ project                                                                                                    |
| C4  | Open `CREATE_ADMIN_PROFILE.sql`, set **one** of `p_email` / `p_user_id` (type the address, never paste it), paste the whole file, Run                    | a `NOTICE: admin granted to …` and a `next_step` row. It refuses with a named reason when the bundle is missing, when both inputs are set, or when the address is wearing markdown brackets    |
| C5  | Sign in as that account in the app                                                                                                                       | the admin desk opens. From now on role changes go through `public.kicklive_set_user_role()` (audited, last-admin-guarded) — never re-run C4 for a normal promotion                             |
| C6  | Delete `CREATE_ADMIN_PROFILE.sql` from your working copy                                                                                                 | it cannot mint an admin untouched, which is why it is safe in the repo and unsafe in a clipboard                                                                                               |

## D · GitHub: the two environments CI needs

| #   | action                                                                                                                                                             | proof                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| D1  | `gh api repos/g2code331/kick_live-main/environments/staging -X PUT -f wait_timer=0`                                                                                | `{"name":"staging",…}` (this repo has only ever had `production`)                                                            |
| D2  | the same for `production`                                                                                                                                          | `{"name":"production",…}`                                                                                                    |
| D3  | staging secrets: `gh secret set CLOUDFLARE_API_TOKEN --env staging --body …`, then `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_DB_PASSWORD`, `SUPABASE_STAGING_PROJECT_REF` | `gh api …/environments/staging/secrets` lists all four names                                                                 |
| D4  | production secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_DB_PASSWORD`                                                                        | the same for `production`                                                                                                    |
| D5  | staging **variable** (not a secret): `gh api repos/…/environments/staging/variables -X POST -f name=STAGING_WEB_URL -f value=https://<staging pages url>`          | the `verify` job of `full-stack.yml` reads it; without it the post-deploy health check is skipped and staging ships unproven |
| D6  | Settings → Environments → production → **Required reviewers** = yourself                                                                                           | a dispatch now waits for a click — the only thing between a mistyped input and a live deploy                                 |
| D7  | the workflow files are installed and committed (`.github/workflows/full-stack.yml`, `.github/workflows/deploy-web.yml`)                                            | `npm run ci:check` is quiet and `gh api repos/…/actions/workflows` lists `full-stack.yml`                                    |

## E · Deploy production and prove it

| #   | action                                                                                                                                                                                         | proof                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| E1  | push to `main`                                                                                                                                                                                 | `gh run list --workflow=full-stack.yml --limit 1` → success, including `migrate` and `verify`                                   |
| E2  | `gh workflow run full-stack.yml -f deploy_production=true` (or Actions → Run workflow)                                                                                                         | it waits for D6's review, then `deploy-production` goes green                                                                   |
| E3  | `npm run web:env && npm run build:web:production && npx wrangler pages deploy dist/web --project-name kicklive-web --branch main`                                                              | the build **refuses** if `.env.production` is missing or stale; the deploy prints a `*.kicklive-web.pages.dev` URL              |
| E4  | `bash scripts/ci/probe-deploy.sh https://kicklive-web.pages.dev`                                                                                                                               | `PASS` (deep links served, a missing hashed asset is a real 404, JS MIME type, no path traversal)                               |
| E5  | open the site → sign up → edit the profile → save                                                                                                                                              | it saves. `permission denied for table profiles` here means the app is talking to a project that never got C1                   |
| E6  | sign in as the admin; `curl -fsS https://kicklive-api-<account>.workers.dev/api/health`                                                                                                        | healthy, `project_ref` = `xvksxqrmdbbinlrjctri`                                                                                 |
| E7  | rehearse rollback while it is still cheap: `npx wrangler pages rollback <previous id> --project-name kicklive-web` and `npx wrangler rollback --config workers/wrangler.toml --env production` | both succeed. Frontend and API roll back independently; the database never needs a rollback because the migrations are additive |

## What "done" means, and what this file cannot prove

Done = A2 green, B9 healthy against the production ref, C2 all `pass`, C5 the admin desk opens, D7 listed, and
E4/E5/E6 pass.

Not provable from a terminal, and therefore never claimed here: that a secret's **value** is right, that Cloudflare
DNS points at the Pages project, that the domain's TLS is issued, and that a push notification reached a device. Each
has a step above that a human checks in a dashboard (B7, E3, E6, and the FCM note under B6).

```bash
# the one command, on any day you are not sure:
npm run preflight:production
```
