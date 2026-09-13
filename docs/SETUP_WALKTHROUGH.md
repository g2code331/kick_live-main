# Kick Live — setup walkthrough (follow top to bottom, once)

This is the short path. `docs/ENVIRONMENT_SETUP.md` explains every variable and why it exists; `DEPLOYMENT_CHECKLIST.md` is the audit
list; `docs/DEPLOYMENT_VERIFICATION.md` is the proof after you deploy. This file is only the order of operations. Do not skip ahead:
each step's output is the input to the next.

Architecture in one line: **Cloudflare Pages hosts the web app, a Cloudflare Worker is the API, Supabase is the database and auth.**
One Cloudflare account, one Supabase project per environment. There is no Vercel step and there never will be again —
`vercel.json` was deleted on 2026-09-12.

Two environments, always: **staging first, production second**. Everything below is done twice, staging then production, and
`SETUP.sql`/the Worker/Pages all take an environment name.

## 0 · What is already done (do not redo it)

| thing                                                                  | status                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Supabase projects                                                      | both exist — staging `fnefpcjeebawsebxjhcf`, production `xvksxqrmdbbinlrjctri`                     |
| Cloudflare KV `RATE_LIMIT_KV` (both envs)                              | created 2026-09-10, ids already wired in `workers/wrangler.toml`                                   |
| Worker names (`kicklive-api`, `kicklive-api-staging`) and all `[vars]` | already in `workers/wrangler.toml`, per environment, with the right `SUPABASE_PROJECT_REF` per env |
| Queues, R2 buckets, Worker secrets, Pages projects, GitHub env vars    | **not done** — that is steps 2, 4 and 5                                                            |
| Database schema                                                        | **not applied** — that is step 3                                                                   |

If you are on a fresh clone instead, the "already done" rows still hold: the KV ids and the per-env vars are committed in the TOML.

## 1 · Get the code and prove the checkout

```bash
git clone https://github.com/g2code331/kick_live-main.git && cd kick_live-main   # or: git checkout main && git pull
git rev-parse --abbrev-ref HEAD          # want: main
npm ci
npm run test:unit && npm run test:integration && npm run typecheck && npm run format:check
npm run ci:install                       # copies ci/workflows/ -> .github/workflows/ (the install target is gitignored by choice)
# It prints a name for every workflow it rewrote; from a main that predates the Pages migration it rewrites two, because the
# installed *Deploy web* still contains the retired Vercel step. The installed copies ARE tracked on main (my branch cannot push
# changes to that path - GitHub refuses a token without the `workflows` permission), so commit the repair and push it yourself:
git add -f .github/workflows && git commit -m "ci: install workflows (Pages deploy, no Vercel step)"
npm run gates                            # everything green, or you are not holding the code you think you are
node scripts/install-ts-loader.mjs       # exit 0 = package.json already carries the TS loader flag (it does on main)
```

`npm run ci:install` above is not decoration: the workflow GitHub actually executes is the copy under `.github/workflows/`, so
until it is refreshed your pushes still deploy through the old Vercel job (the _Deploy web_ run will fail on `VERCEL_TOKEN` being
unset — that is the drift, not a broken workflow). The test suite reports the mismatch as a warning naming this command rather than
as a failure, precisely because the repair cannot ride on a pushed branch.

Node ≥ 22.22.2 from Nodejs.org (`nvm install --lts` if your distro ships a repackaged one) removes the only environment-specific
foot-gun this repo has: PNG byte-comparison in `npm run brand:assets:check` and `.ts` entry points both depend on a stock build.

## 2 · Cloudflare: log in, then create the six missing resources

```bash
npx wrangler login                       # browser consent; pick the account that owns kicklive.football
npx wrangler whoami
```

Queues — **one name per command** (`wrangler queues create` takes a single positional argument):

```bash
npx wrangler queues create kicklive-notifications-staging
npx wrangler queues create kicklive-ad-events-staging
npx wrangler queues create kicklive-notifications-failed-staging
npx wrangler queues create kicklive-notifications
npx wrangler queues create kicklive-ad-events
npx wrangler queues create kicklive-notifications-failed
```

R2 — the first call fails with `Please enable R2 through the Cloudflare Dashboard [code: 10042]` until you click **Enable** once at
dash.cloudflare.com → R2 (a payment method must be on file even for the free tier). Then:

```bash
npx wrangler r2 bucket create kicklive-media-staging
npx wrangler r2 bucket create kicklive-media
npx wrangler r2 bucket list               # want: both, plus nothing else needed
```

KV already exists — do **not** create a third namespace; the ids in the TOML are the ones the tests pin.

## 3 · Database: one file per project, plus an admin row

Supabase dashboard → pick **staging** → SQL Editor → New query → paste the **entire** `supabase/SETUP.sql` → Run. It is
~13,800 lines and prints `1 / 10: …` … `10 / 10: …` as it goes; it stops at the first error and that error names its own section.
Then do the same in the **production** project. Nothing else runs: `SETUP.sql` is `KICKLIVE_FINAL_SCHEMA.sql` + the nine
`supabase/migrations/*.sql` in apply order, generated by `npm run sql:bundle` (`npm run sql:bundle:check` proves it is current).

In each project, after you have signed up once in the app (or created the user in Auth → Users):

```sql
-- CREATE_ADMIN_PROFILE.sql is intentionally NOT in SETUP.sql: it names a real user.
-- Read it, replace the email placeholder with that user's auth uid/email, run it once.
```

Optional belt-and-braces (proves the same thing a real paste proves, without a paste):

```bash
npm i --no-save pg
node scripts/check-sql.mjs --dsn "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" --allow-any-database
#  never --fresh against a live project: that flag recreates a scratch database
```

Expected: `ok … runFlow / runSponsorshipFlow / runObservabilityFlow ALL PASS`. A `SKIP` is not a pass — it means `pg` is missing or
the DSN was rejected.

## 4 · Worker: secrets, dry-run, deploy

The variables are already in `workers/wrangler.toml`; only the five secrets are per-machine, because they are per Supabase project:

```bash
for s in SUPABASE_SERVICE_ROLE_KEY SUPABASE_JWT_SECRET TURNSTILE_SECRET_KEY FCM_SERVICE_ACCOUNT AD_VIEWER_KEY_SECRET; do
  npx wrangler secret put "$s" --env staging
done
# repeat with --env production, using the PRODUCTION project's keys. Copy-paste of the wrong pair is the #1 incident in this repo's history.

npx wrangler deploy --config workers/wrangler.toml --env staging --dry-run --outdir /tmp/wd      # want: exit 0, no warnings
npx wrangler deploy --config workers/wrangler.toml --env production --dry-run --outdir /tmp/wd
npm run worker:deploy:staging && npm run worker:deploy:production                                  # real deploys
```

`FCM_SERVICE_ACCOUNT` / `FCM_PROJECT_ID`: only if push must actually leave the account. Firebase console → any project → Project
settings → Service accounts → Generate new private key; the project id in that file is `FCM_PROJECT_ID` (a var, not a secret), the
whole JSON is `FCM_SERVICE_ACCOUNT` (one `secret put`). Enable **Firebase Cloud Messaging API (V1)** in the Google Cloud console for
that project or every send returns 403. Leave both unset and delivery silently uses the mock transport — fine on a laptop, and the
reason a green local run is not proof a push arrived. `TURNSTILE_SECRET_KEY` unset means the bot check is skipped: fine locally,
not in production.

Then prove it answers:

```bash
curl -s https://kicklive-api.<your-subdomain>.workers.dev/api/health          # {"ok":true,"env":"staging",…} for the staging worker
npx wrangler secret list --config workers/wrangler.toml --env production       # all five names present
```

## 5 · Pages: create the two projects, give CI the keys, deploy

```bash
npx wrangler pages project create kicklive-web --production-branch main
npx wrangler pages project create kicklive-web-staging --production-branch main
```

Deploy from your laptop now (one command, and you get a URL immediately). Staging is a separate **project**, not a separate branch —
same as the CI workflow does it:

```bash
VITE_SUPABASE_URL=https://fnefpcjeebawsebxjhcf.supabase.co VITE_SUPABASE_ANON_KEY=<staging anon key> npm run build:web
npx wrangler pages deploy dist/web --project-name kicklive-web-staging --branch main
npm run build:web        # plain, reads .env.local: must hold the PRODUCTION pair
npx wrangler pages deploy dist/web --project-name kicklive-web --branch main
```

**`https://kicklive-web.pages.dev` (and `-staging`) exists only after this first deploy** — before it the domain 404s and that is
correct. Then `bash scripts/ci/probe-deploy.sh https://kicklive-web.pages.dev` must print PASS (routes served, missing hashed asset
still a real 404, JS MIME type, no path traversal).

To make every future push deploy itself, create **GitHub → repository → Settings → Environments → `production` and `staging`**, and in
each one add all four (production values in production, staging values in staging — the _Deploy web_ workflow reads its `VITE_*`
pair from the environment, which is what makes a cross-wired deploy impossible by copy-paste):

| name                     | value                                                      |
| ------------------------ | ---------------------------------------------------------- |
| `VITE_SUPABASE_URL`      | that environment's Supabase project URL                    |
| `VITE_SUPABASE_ANON_KEY` | that project's anon/publishable key                        |
| `CLOUDFLARE_API_TOKEN`   | a token with **Cloudflare Pages:Edit** + **Zone:Read**     |
| `CLOUDFLARE_ACCOUNT_ID`  | dash.cloudflare.com → your account → Account ID (plain id) |

Note this is a GitHub **Environment secret**, not the old `.env`-in-repo habit. `.env.local` locally, copied from `.env.example`, is
still how `npm run dev` gets its pair.

Once those four exist per environment, the _Deploy web_ workflow does step 5's deploy for you: it runs on every push to `main` that
touches anything but `docs/`/`*.md`, and on **Actions → Deploy web → Run workflow → environment** (that picker is how you deploy
`staging` and `preview`, since a push only ever means production). Until the secrets exist, the workflow fails fast with
`::error::CLOUDFLARE_API_TOKEN is not set` — which is the intended message, not a broken workflow.

## 6 · Wire the domains (only if the Pages deploy above worked)

In Cloudflare, on the zone that owns `kicklive.football`:

1. Workers & Pages → `kicklive-web` → Custom domains → add `kicklive.football` and `www.kicklive.football`; `kicklive-web-staging`
   gets `staging.kicklive.football`. If DNS for the zone is hosted elsewhere, add the CNAMEs there first — Pages will otherwise sit
   on "pending DNS" forever.
2. Workers & Pages → `kicklive-api` → Settings → Domains & Routes → route `kicklive.football/api/*` (and the staging equivalent) to
   the Worker. Keep the `[[env.*.routes]]` blocks in `workers/wrangler.toml` commented out; routing the zone's `/api/*` is done once,
   in the dashboard, and the app talks to same-origin `/api` so there is no CORS wildcard to configure.
3. Confirm `ALLOWED_ORIGINS` in each env block already lists exactly the domains from (1) — it does, and a stale entry there is the
   most common reason a browser gets `403` while `curl` works.

## 7 · Prove the deployed thing works (staging, then production)

Run `docs/DEPLOYMENT_VERIFICATION.md` — 16 numbered checks, one command each, against
`https://staging.kicklive.football` first and `https://kicklive.football` second. The four that no automated test can reach, do by
hand in staging before production: one media upload lands in R2, one live match streams over a websocket (then flip the tab offline
and watch it replay and catch up), one real push to one device twice for the same match (dedupe), and one `:17` cron run where
`metric_daily` grew while `metric_rollups` did not.

## 8 · If a step fails

| symptom                                                       | cause, in the order it is actually likely                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deep link 404s / a stale asset returns HTML                   | the Pages contract files did not ship: `dist/web` must contain `functions/[[catchall]].js`, `_routes.json`, `_headers` — `npm run verify` checks this pre-build |
| app boots against the wrong data                              | the `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` pair in that environment belongs to the other project — the boot guard says so in the console                  |
| `relation "public.profiles" does not exist` while pasting SQL | you pasted an old copy: tables must be created before the `LANGUAGE sql` helpers read them. `npm run sql:bundle:check` and re-paste                             |
| `SKIP` from `check-sql`                                       | `npm i --no-save pg` missing, a literal `<placeholder>` DSN, or no `--allow-any-database` for Supabase                                                          |
| queue depth climbs, nothing errors                            | queue name in `[vars]` and in the binding blocks disagree — rename in **both**                                                                                  |
| every authenticated route 401                                 | `SUPABASE_JWT_SECRET` absent or from the other project                                                                                                          |
| `wrangler` says a binding does not exist                      | step 2 resources were created in a different account than `whoami` shows                                                                                        |

## 9 · Roll back (each half rolls back on its own; the database never needs a rollback)

```bash
npx wrangler pages deployment list --project-name kicklive-web
npx wrangler pages rollback <DEPLOYMENT_ID> --project-name kicklive-web      # frontend, one command, instant
npx wrangler rollback --config workers/wrangler.toml --env production         # API, to the previous Worker version
```

Migrations are additive-only, so no rollback in this file ever requires restoring data. Frontend and API are independent deploys:
rolling the frontend back never touches the Worker, and vice versa.
