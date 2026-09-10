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
git add .github/workflows && git commit -m "ci: install workflows"
```

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
# Queues — three per environment (producer, consumer, dead-letter)
npx wrangler queues create kicklive-notifications-staging
npx wrangler queues create kicklive-ad-events-staging
npx wrangler queues create kicklive-notifications-failed-staging
npx wrangler queues create kicklive-notifications
npx wrangler queues create kicklive-ad-events
npx wrangler queues create kicklive-notifications-failed

# R2 — one bucket per environment
npx wrangler r2 bucket create kicklive-media-staging
npx wrangler r2 bucket create kicklive-media

# KV — the rate-limit namespace. This is REQUIRED for rate limiting to mean what it says:
# `[[env.staging.kv_namespaces]]` and `[[env.production.kv_namespaces]]` are commented out in
# workers/wrangler.toml (lines ~195 and ~293) because the id is only knowable after creation.
npx wrangler kv namespace create RATE_LIMIT_KV --env staging      # copy the returned id
npx wrangler kv namespace create RATE_LIMIT_KV --env production    # copy the returned id
# → uncomment both blocks in workers/wrangler.toml and paste the ids
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
3. SQL Editor: run `KICKLIVE_FINAL_SCHEMA.sql`, then each file in `supabase/migrations/` **in filename order**
   (base + 9). Stop at the first error — every phase migration ends with a `do $verify$` block that raises
   rather than installing quietly. **Never** run `SUPABASE_NEW_PROJECT_SETUP.sql` or
   `SUPABASE_COMPLETE_SCHEMA.sql`; both are banner-labelled superseded and both are weaker than what Phase 1
   hardened. (`supabase db push` is the CLI equivalent.)
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

| name                       | required | where it goes                             | what reads it                            | if unset/falsy                                                                                                                                     |
| -------------------------- | -------- | ----------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`        | **yes**  | `.env.local`, CI secret, Vercel           | `src/lib/supabase.ts`                    | the SPA refuses to boot                                                                                                                            |
| `VITE_SUPABASE_ANON_KEY`   | **yes**  | same                                      | same                                     | refuses to boot; and it **must** be the key whose `ref` claim matches the URL                                                                      |
| `VITE_API_BASE_URL`        | no       | same                                      | `src/lib/api/client.ts`                  | empty = same-origin `/api`, which is correct for the Vite proxy and for a shared zone. A non-local origin in a dev build is refused (see next row) |
| `VITE_API_ALLOW_REMOTE`    | no       | dev only                                  | same guard                               | `1` is the only way to point a dev build at a remote Worker. Set it deliberately, never by copy-paste                                              |
| `VITE_UPDATE_MANIFEST_URL` | no       | desktop/PWA only                          | the updater (`docs/RELEASE-PIPELINE.md`) | update checks are disabled; the app still runs                                                                                                     |
| `VITE_UPDATE_CHANNEL`      | no       | desktop/PWA only                          | same                                     | defaults to `stable`                                                                                                                               |
| `TURNSTILE_SITE_KEY`       | no       | CI (it is public, but keep it out of git) | signup/write forms                       | the widget is not rendered, and the Worker's skip in §3.5 makes it moot — set both together or neither                                             |

There is no `VITE_SUPABASE_SERVICE_ROLE_KEY`, and there never will be: the source scan fails the build on a
JWT-shaped literal in shipped source, and `supabaseAdmin()` exists only under `workers/`.

### 4.2 Worker — plain `[vars]` (visible in the deployed config; **never** put a secret here)

| name                                  | required        | default if unset                  | notes                                                                                                                                               |
| ------------------------------------- | --------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                        | **yes**         | — (`requireEnv` throws)           | `services/supabase.ts`; the Worker talks REST to this origin                                                                                        |
| `SUPABASE_PROJECT_REF`                | recommended     | ref parsed from the URL           | the mismatch guard. Set it explicitly per environment — it is the cheapest way to prove a deploy points where you think it does                     |
| `SUPABASE_ANON_KEY`                   | **yes**         | — (required for `supabaseAsUser`) | user-token calls: `supabaseAsUser(env, token)` sends _your_ key + _their_ JWT so RLS applies                                                        |
| `ALLOWED_ORIGINS`                     | **yes** in prod | dev origins only                  | comma-separated exact origins. `*` is rejected by `env.ts`; a `null` origin is refused by middleware                                                |
| `APP_ENV`                             | recommended     | `development`                     | `development\|staging\|production`. Drives `isProduction()`, `/api/health`'s echo, log/detail policy. **There is no `ENVIRONMENT` var**             |
| `NOTIFICATION_QUEUE_NAME`             | if push         | consumer refuses the batch        | must equal the queue name in the binding blocks                                                                                                     |
| `AD_EVENTS_QUEUE_NAME`                | if ads          | same                              | same                                                                                                                                                |
| `FCM_PROJECT_ID`                      | if push         | mock transport                    | not a secret                                                                                                                                        |
| `NOTIFICATIONS_MAX_AUDIENCE`          | no              | built-in cap                      | an audience above it is **refused**, not truncated                                                                                                  |
| `NOTIFICATIONS_REMINDER_LEAD_MINUTES` | no              | `0` = reminders off               | minutes before kick-off                                                                                                                             |
| `FCM_TIMEOUT_MS`                      | no              | built-in                          | bounds one HTTP send so a hang cannot eat the queue's visibility window                                                                             |
| `NOTIFICATIONS_LINK_BASE`             | no              | request origin                    | needed only when a tap may land outside the SPA's own origin                                                                                        |
| `MEDIA_MAX_BYTES`                     | no              | `26214400`                        | ⚠ named environments do **not** inherit top-level `[vars]`: if you want a different ceiling for staging/prod, put it in `[env.production.vars]` too |
| `LOG_MODE`                            | no              | `errors`                          | `off\|errors\|slow\|all`. Phase 9's structured logs; the field set is closed, so this only changes volume                                           |

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

# 3. web → Vercel/static host with the four VITE_ vars set
npm run build:web        # then the host's deploy, or `vercel deploy --prod`
#    a build with a mismatched URL/key pair fails here, on purpose

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
