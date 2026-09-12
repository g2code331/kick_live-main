# Kick Live — environment setup: every resource, variable and secret

This is the whole configuration surface, in the order that works, for a fresh install or for taking this
repository onto `main`. Nothing here is optional-by-taste: each row is either needed to boot, needed to make a
feature real, or explicitly marked "leave unset" with what happens if you do.

Sources of truth, in case this file and the code disagree (the code wins):

| fact                      | authoritative location                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Worker variables          | `workers/src/env.ts` — the `Env` interface, with a comment per key                                   |
| Worker bindings           | `workers/wrangler.toml` — `[vars]`, `[[r2_buckets]]`, `[[queues.*]]`, `[[durable_objects.bindings]]` |
| What the browser may hold | root `.env.example`, and the boot guard in `src/lib/supabase.ts`                                     |
| Required-vs-optional      | `scripts/check-secrets.mjs` (`node scripts/check-secrets.mjs --json`)                                |
| Local dev file            | `workers/.dev.vars.example` → copy to `workers/.dev.vars` (git-ignored)                              |

---

## 0 · Put the code on `main` (if you are moving it by hand)

```bash
git fetch origin
git checkout main
git merge --ff-only origin/arena/01a08671-kick-live-main || git merge origin/arena/01a08671-kick-live-main
npm ci
npm run typecheck && npm run test:unit && npm run test:integration && npm run format:check
npm run ci:install          # copies ci/*.yml into .github/workflows/ (the repo forbids commits that touch that dir)
git add -f .github/workflows && git commit -m "ci: install workflows"   # -f: the dir is deliberately gitignored
```

### If the checks die with `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"`

Your Node was built without type stripping — a repackaged `nodejs` (Debian/Ubuntu, some distro images, a few
version-manager installs) rather than a Nodejs.org binary. The repository does not need a different Node: every
`node …` npm script runs through `scripts/lib/ts-loader.mjs`, which transpiles the `.ts` sources the checkers read
using the `typescript` package already installed by `npm ci`. Confirm the diagnosis, and check the loader is
present:

```bash
node -p "process.features.typescript"          # false  -> stripping absent;  "strip" -> present (the loader is then a no-op path)
node --import ./scripts/lib/ts-loader.mjs -e "import('workers/src/router.ts').then(m => console.log(m.ROUTES.length))"   # -> 101
```

If you need to run a `node` command directly rather than through `npm run`, pass the same flag:

```bash
NODE_OPTIONS="--import $PWD/scripts/lib/ts-loader.mjs" node scripts/run-tests.mjs unit
```

`package.json` is the only file that carries the flag, and it is the file a local clone most often has its own
opinions about, so it is patched rather than overwritten by a merge:

```bash
node scripts/install-ts-loader.mjs            # report what is missing (exit 1 if anything is)
node scripts/install-ts-loader.mjs --write    # add the flag to every `node …` script, idempotently
```

If you would rather not touch `package.json` at all, one shell variable does the same job for a single run:

```bash
NODE_OPTIONS="--import $PWD/scripts/lib/ts-loader.mjs" npm run test:unit
```

The cleanest fix, if you do not want to carry a loader at all, is a stock Node ≥ 22.22.2. A `v22.22.1` bundled
with `npm 9.2.0` (Node 22 ships npm 10.x) is the signature of a repackaged build, and the `EBADENGINE` warning about
`ini@7.0.0` wanting `^22.22.2` is the same version boundary seen from the other side.

Also worth knowing: `npm ci` on that machine reported 13 vulnerabilities, and `npm audit --omit=dev` reports none
— they are all in the desktop/packaging dev chain (`electron-builder`'s `glob`/`rimraf`/`boolean`), not in
anything the browser or the Worker loads. Do not run `npm audit fix --force`: it breaks pinned versions, and the
pins are load-bearing for the packaging pipeline (`docs/RELEASE-PIPELINE.md`).

Then check the branch actually contains the nine migrations and the two new docs:

```bash
ls supabase/migrations | wc -l          # 9
ls docs/OBSERVABILITY_ARCHITECTURE.md RELEASE_CHECKLIST.md README.md
node scripts/worker-routes.mjs --check  # "README lists all 101 declared routes"
```

---

## 1 · Cloudflare resources (create these before the first deploy)

The Worker's bindings must exist before `wrangler deploy` will upload. Names below are the ones
`workers/wrangler.toml` already declares, so **create them with these exact names** or edit the TOML to match.

```bash
# Queues — three per environment (producer, consumer, dead-letter). One name per command:
# `wrangler queues create` takes a single positional, and a second name on the line is
# rejected with "Unknown arguments" rather than creating anything.
npx wrangler queues create kicklive-notifications-staging
npx wrangler queues create kicklive-ad-events-staging
npx wrangler queues create kicklive-notifications-failed-staging
npx wrangler queues create kicklive-notifications
npx wrangler queues create kicklive-ad-events
npx wrangler queues create kicklive-notifications-failed

# R2 — one bucket per environment. PREREQUISITE: R2 is opt-in per account. The first call fails with
# "Please enable R2 through the Cloudflare Dashboard [code: 10042]" until someone clicks Enable once
# in dash.cloudflare.com → R2; a payment method must be on file even for the free tier.
npx wrangler r2 bucket create kicklive-media-staging
npx wrangler r2 bucket create kicklive-media

# KV — DONE as of 2026-09-10: `staging-RATE_LIMIT_KV` and `production-RATE_LIMIT_KV` exist and
# their ids are wired into `[[env.staging.kv_namespaces]]` / `[[env.production.kv_namespaces]]` in
# workers/wrangler.toml. Keep both blocks active (tests/unit/phase2-api-boundary.test.ts now fails
# if either goes missing or ships a placeholder id): with no binding, rate limiting is
# per-isolate in-memory and the ceilings in middleware/ratelimit.ts read stricter than reality.
# Only recreate on a fresh account, then paste the printed ids into those two blocks:
npx wrangler kv namespace create RATE_LIMIT_KV --env staging
npx wrangler kv namespace create RATE_LIMIT_KV --env production
# (From the repo root these warn "No environment found in configuration with name staging" —
# harmless: the namespace is created regardless, and the warning is about the root directory,
# which has no wrangler.toml; `worker:deploy:*` reads workers/wrangler.toml itself.)
```

Durable Object (`LIVE_MATCH_ROOM`, class `MatchRoom`) and the two cron triggers
(`*/5 * * * *` sweep, `17 * * * *` media/ad/observability maintenance — `MEDIA_SWEEP_CRON` in
`workers/src/services/mediaStore.ts` is the constant that must match the TOML) need no dashboard action: the
first deploy with its `[[env.*.migrations]]` entry creates the class.

If you rename a queue, rename it in **both** places — `[vars].NOTIFICATION_QUEUE_NAME` /
`AD_EVENTS_QUEUE_NAME` (which is what the consumer compares `MessageBatch#queue` against) and the
`[[env.*.queues.*]]` blocks. A mismatch is a queue that is produced to and never consumed, which shows up as
`queue.depth` climbing rather than as an error.

---

## 2 · Supabase (one project per environment)

1. Create the project. Note the **ref** (`https://<ref>.supabase.co`).
2. Settings → API: copy the **publishable/anon key**, the **`service_role` secret key**, and the **JWT Secret**.
   Newer projects also show a `sb_publishable_…` / `sb_secret_…` pair — either form works, but URL and key must
   come from the **same** project: `workers/src/services/supabase.ts` refuses a `SUPABASE_PROJECT_REF`
   mismatch, and `src/lib/supabase.ts` refuses to boot the SPA when the URL's ref and the key's `ref` claim
   disagree (this repo previously shipped a mismatched pair, which is why both guards exist).
3. SQL Editor: paste **`supabase/SETUP.sql`** — the whole database in one file (base schema + the nine
   migrations in apply order, generated by `npm run sql:bundle`; never hand-edit it, edit the sources).
   Stop at the first error — every section ends with a `do $verify$` block that raises rather than installing
   quietly, and each section announces itself (`select N/10: <file>`) so a failed paste names its own section.
   **Never** run `SUPABASE_COMPLETE_SCHEMA.sql` or `SUPABASE_NEW_PROJECT_SETUP.sql`: both were deleted on
   2026-09-12 precisely because they keep getting pasted, and both are weaker than what Phase 1 hardened.
   (`supabase db push` over `supabase/migrations/` is the CLI equivalent for an already-based project.)
4. Auth → URL configuration: Site URL = the web origin, Redirect URLs = `https://<origin>/**` (needed for email
   links; the app's own sign-in is password-based, so this is only for confirmations/recovery).
5. Turnstile (Cloudflare dashboard → Turnstile): create a widget, then pair
   `TURNSTILE_SITE_KEY` (into the SPA build env, harmless — it is public) with `TURNSTILE_SECRET_KEY` (a Worker
   secret). Leaving the secret unset makes `verifyTurnstile()` skip the check: fine on a laptop, **not** fine in
   production, because signup and the write endpoints lose their bot gate.
6. Supabase's own `pg_cron` is **not** used: all scheduled work rides the Worker's cron so one deploy owns both
   the code and the schedule.
7. Backups: enable PITR, or schedule `pg_dump` off-box. Then rehearse one restore into a scratch project and run
   `node scripts/check-sql.mjs --dsn <scratch>` against it — a backup nobody has restored is a hypothesis.

---

## 3 · Firebase Cloud Messaging (only if push should actually leave the account)

1. Firebase Console → Project settings → Cloud Messaging → **service account** → Generate new private key.
   Note the **project id** of _that_ Firebase project: `FCM_PROJECT_ID` is the Cloudflare-side id used to build
   `https://fcm.googleapis.com/v1/projects/<id>/messages:send`. It is not the `projectId` in the SPA's Firebase
   config; those are the same string only when nobody has renamed anything.
2. The JSON file never enters the repository or `wrangler.toml`:

   ```bash
   npx wrangler secret put FCM_SERVICE_ACCOUNT --env production   # paste the file verbatim, one line
   npx wrangler secret put FCM_PROJECT_ID --env production        # not a secret; a var is fine too
   ```

   `check-secrets.mjs` fails the build if a `"type": "service_account"` document, a PEM header, or a
   `firebase-adminsdk-…@` client email appears in the tree — the client email is what identifies the key to
   rotate, so it counts as a secret too.

3. Web push / the SPA's VAPID key is **not** used: delivery is FCM to tokens registered by the mobile/desktop
   clients.
4. Unset both and everything except the wire still runs — `transportFor()` returns the mock transport, jobs are
   created, fanned out, recorded and counted. That is the intended laptop state, and the reason a green local run
   is not proof a push arrived.

---

## 4 · The complete variable table

### 4.1 Browser build (`VITE_*` — compiled into the artifact, therefore public)

| name                       | required | where it goes                                                           | what reads it                            | if unset/falsy                                                                                                                                     |
| -------------------------- | -------- | ----------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`        | **yes**  | `.env.local`, CI secret (per GitHub environment — staging ≠ production) | `src/lib/supabase.ts`                    | the SPA refuses to boot                                                                                                                            |
| `VITE_SUPABASE_ANON_KEY`   | **yes**  | same                                                                    | same                                     | refuses to boot; and it **must** be the key whose `ref` claim matches the URL                                                                      |
| `VITE_API_BASE_URL`        | no       | same                                                                    | `src/lib/api/client.ts`                  | empty = same-origin `/api`, which is correct for the Vite proxy and for a shared zone. A non-local origin in a dev build is refused (see next row) |
| `VITE_API_ALLOW_REMOTE`    | no       | dev only                                                                | same guard                               | `1` is the only way to point a dev build at a remote Worker. Set it deliberately, never by copy-paste                                              |
| `VITE_UPDATE_MANIFEST_URL` | no       | desktop/PWA only                                                        | the updater (`docs/RELEASE-PIPELINE.md`) | update checks are disabled; the app still runs                                                                                                     |
| `VITE_UPDATE_CHANNEL`      | no       | desktop/PWA only                                                        | same                                     | defaults to `stable`                                                                                                                               |
| `TURNSTILE_SITE_KEY`       | no       | CI (it is public, but keep it out of git)                               | signup/write forms                       | the widget is not rendered, and the Worker's skip in §3.5 makes it moot — set both together or neither                                             |

There is no `VITE_SUPABASE_SERVICE_ROLE_KEY`, and there never will be: the source scan fails the build on a
JWT-shaped literal in shipped source, and `supabaseAdmin()` exists only under `workers/`.

### 4.2 Worker — plain `[vars]` (visible in the deployed config; **never** put a secret here)

| name                                  | required        | default if unset                  | notes                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                        | **yes**         | — (`requireEnv` throws)           | `services/supabase.ts`; the Worker talks REST to this origin                                                                                                                                                                                                     |
| `SUPABASE_PROJECT_REF`                | recommended     | ref parsed from the URL           | the mismatch guard. Set it explicitly per environment — it is the cheapest way to prove a deploy points where you think it does                                                                                                                                  |
| `SUPABASE_ANON_KEY`                   | **yes**         | — (required for `supabaseAsUser`) | user-token calls: `supabaseAsUser(env, token)` sends _your_ key + _their_ JWT so RLS applies                                                                                                                                                                     |
| `ALLOWED_ORIGINS`                     | **yes** in prod | dev origins only                  | comma-separated exact origins. `*` is rejected by `env.ts`; a `null` origin is refused by middleware                                                                                                                                                             |
| `APP_ENV`                             | recommended     | `development`                     | `development\|staging\|production`. Drives `isProduction()`, `/api/health`'s echo, log/detail policy. **There is no `ENVIRONMENT` var**                                                                                                                          |
| `NOTIFICATION_QUEUE_NAME`             | if push         | consumer refuses the batch        | must equal the queue name in the binding blocks                                                                                                                                                                                                                  |
| `AD_EVENTS_QUEUE_NAME`                | if ads          | same                              | same                                                                                                                                                                                                                                                             |
| `FCM_PROJECT_ID`                      | if push         | mock transport                    | not a secret                                                                                                                                                                                                                                                     |
| `NOTIFICATIONS_MAX_AUDIENCE`          | no              | built-in cap                      | an audience above it is **refused**, not truncated                                                                                                                                                                                                               |
| `NOTIFICATIONS_REMINDER_LEAD_MINUTES` | no              | `0` = reminders off               | minutes before kick-off                                                                                                                                                                                                                                          |
| `FCM_TIMEOUT_MS`                      | no              | built-in                          | bounds one HTTP send so a hang cannot eat the queue's visibility window                                                                                                                                                                                          |
| `NOTIFICATIONS_LINK_BASE`             | no              | request origin                    | needed only when a tap may land outside the SPA's own origin                                                                                                                                                                                                     |
| `MEDIA_MAX_BYTES`                     | no              | `26214400`                        | Now declared in all three `[vars]` blocks — named environments do **not** inherit top-level `[vars]`, and a missing line is wrangler's "these vars are not on env.staging.vars" warning at every deploy. Change the ceiling per environment, not at the top only |
| `LOG_MODE`                            | no              | `errors`                          | `off\|errors\|slow\|all`. Phase 9's structured logs; the field set is closed, so this only changes volume                                                                                                                                                        |

### 4.3 Worker — secrets (`npx wrangler secret put`, or the dashboard → Settings → Variables → Secrets)

| name                        | required    | set with                                        | consequence of leaving it unset                                                                                                                                                                                                        |
| --------------------------- | ----------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes**     | `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` | `supabaseAdmin()` throws `Worker is missing required configuration`; every queue/cron/maintenance path fails, reads that run as the caller still work                                                                                  |
| `SUPABASE_JWT_SECRET`       | **yes**     | same                                            | `authenticate()` cannot verify any bearer token → every authenticated route returns 401                                                                                                                                                |
| `TURNSTILE_SECRET_KEY`      | prod yes    | same                                            | bot check is skipped (see §3.5)                                                                                                                                                                                                        |
| `FCM_SERVICE_ACCOUNT`       | if push     | same                                            | mock transport; nothing is delivered                                                                                                                                                                                                   |
| `AD_VIEWER_KEY_SECRET`      | recommended | same                                            | the viewer key falls back to being derived from `SUPABASE_JWT_SECRET`, which works but couples two rotations together. Rotating this invalidates every key ever issued — that **is** the "delete this viewer's history" implementation |

### 4.4 Bindings (not variables — declare in `wrangler.toml`, create in §1)

`MEDIA_BUCKET` (R2) · `NOTIFICATION_QUEUE`, `AD_EVENTS_QUEUE` (Queues) ·
`RATE_LIMIT_KV` (KV; **currently commented out in both environments**) · `LIVE_MATCH_ROOM` (Durable Object).

---

## 5 · Deploy order, and the check after each step

```bash
# 1. database — base schema + the nine migrations (or: supabase db push)
node scripts/check-sql.mjs --dsn "postgres://<user>:<pw>@<host>:5432/postgres" --fresh
#    require: "ok fresh: recreated database …", then runFlow, runSponsorshipFlow, runObservabilityFlow, ALL PASS

# 2. Worker → staging, then production
cd workers && npx wrangler deploy --env staging && cd ..
cd workers && npx wrangler deploy --env production && cd ..
curl -s https://<worker-origin>/api/health          # {"ok":true,"env":"production",…}
curl -s https://<worker-origin>/api/observability/health   # status + observedAt + one line per component

# 3. web → Cloudflare Pages (the frontend host lives in the same zone as the Worker).
#    One-time per Pages project (and once more for staging):
npx wrangler pages project create kicklive-web --production-branch main
npx wrangler pages project create kicklive-web-staging --production-branch main
npm run build:web
npx wrangler pages deploy dist/web --project-name kicklive-web --branch main
#    a build with a mismatched URL/key pair fails at boot on purpose (src/lib/env.ts).
#    CI does the same deploy on push to main / workflow_dispatch — DEPLOYMENT.md §"via CI".

# 4. CI secret audit (on the machine that has them exported)
node scripts/check-secrets.mjs          # "All required secrets present."
```

Then the four things no static check can prove, each in staging first:

1. **One upload** — the media desk publishes to R2 and the URL comes back through
   `kicklive_asset_url_for_asset`, not from a public bucket listing.
2. **One live match** — referee desk → kickoff; watch `wrangler tail` for `live.*` metric lines and confirm the
   `MatchRoom` alarm fires and the timer survives a page refresh.
3. **One push** — to a real device, twice for one match (dedupe), and once to a user who disabled that kind.
4. **One maintenance window** — after 17 past the hour, confirm `metric_daily` grew while `metric_rollups` did
   not, and that `observability/diagnostics` reports `audit.appendOnly: true` and `hourlyRows: 0`.

---

## 6 · Local development (the minimum that makes `npm run dev` useful)

```bash
cp .env.example .env.local                       # fill the two VITE_SUPABASE_* values with a DEV project
cp workers/.dev.vars.example workers/.dev.vars   # git-ignored; every secret here must point at STAGING
cd workers && npx wrangler dev                   # :8787
npm run dev                                      # :5173, proxies /api → 8787
```

`workers/.dev.vars` worth having locally: `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`.
Everything else can stay unset and degrades as documented above (mock transport, skipped Turnstile, default
bucket ceiling, `LOG_MODE=errors`). `wrangler dev` gives you local queues/DO/R2 under `.wrangler/state`, so no
Cloudflare resource is needed to develop — but also no real `RATE_LIMIT_KV`, so rate limits are per-isolate
locally as well.

---

## 7 · Verification commands, copy-pasteable

```bash
npm run typecheck                 # both tsconfig projects
npm run test:unit                 # 577 tests — `node --test tests/unit` is not the same thing, it finds nothing
npm run test:integration          # 99 tests
npm run format:check              # one violation fails
npm run gates                     # 21 pass / 1 fail (until ci:install) / 4 skip
npm run worker:routes             # the route catalogue README table vs the router
node scripts/query-audit.mjs      # the performance ratchet; add --write only when you changed a query
node scripts/check-secrets.mjs --json
```

## 8 · What is deliberately NOT configurable

No `ENVIRONMENT` var (use `APP_ENV`). No R2 access key anywhere (the bucket is a binding). No FCM legacy server
key. No `VITE_`-prefixed privileged key. No Supabase `db` direct-connection string in the Worker (everything
goes through PostgREST, so the same RLS applies whether a query comes from a browser or a queue consumer). No
raw request log, and therefore nothing to set retention on outside `observability_config` (`rollup_retention_days`
14, `daily_retention_days` 400, `audit_retention_days` 0 = "we do not prune the audit trail", which is a reviewed
migration, not a job).
