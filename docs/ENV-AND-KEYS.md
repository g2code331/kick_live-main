# Where every key and `.env` file lives (the short, literal version)

`docs/ENVIRONMENT_SETUP.md` is the reference for all of it. This page answers one question only: **which file do I create, where,
and what goes in it.** Nothing here is optional-by-taste: a missing row is either a feature that silently runs in mock mode, or a
boot that refuses to happen.

## The four files, and who reads them

| file                    | in git?           | who creates it                            | read by                                      | holds                                                              |
| ----------------------- | ----------------- | ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `.env.example`          | **yes** (source)  | nobody — it is the template               | nobody at runtime                            | the list of what the browser build may know                        |
| `.env.local`            | no (`.gitignore`) | **you**, by copying the template          | Vite (`npm run dev`) and `npm run build:web` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`                      |
| `workers/.dev.vars`     | no (`.gitignore`) | **you**, from `workers/.dev.vars.example` | `wrangler dev` only (local Worker)           | the staging keys of the Worker, for local testing                  |
| `workers/wrangler.toml` | **yes**           | already written                           | `wrangler deploy`                            | non-secret variables (`[vars]`), per environment — **never a key** |

Cloudflare secrets and GitHub secrets are not files: they live on those platforms (steps below).

## 1 · `.env.local` — what the browser build needs

```bash
cp .env.example .env.local
```

Then fill two values. Both come from **one** Supabase project — project → Project Settings → API → _Project URL_ and
_Project anon key_ (`sb_publishable_…` works too). The staging project for this repo is `fnefpcjeebawsebxjhcf`, production is
`xvksxqrmdbbinlrjctri`.

```bash
VITE_SUPABASE_URL=https://fnefpcjeebawsebxjhcf.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ…
VITE_API_BASE_URL=
```

Rules that are worth knowing before you fight them:

- `VITE_API_BASE_URL` stays **empty**. Empty means the app calls `/api` on its own origin, which is what the Vite proxy answers
  (→ the local Worker on `127.0.0.1:8787`) and what Cloudflare answers in production. Point it at a remote Worker only with
  `VITE_API_ALLOW_REMOTE=1`, deliberately, or the boot guard refuses to start.
- URL and key must be from the **same project**: `src/lib/supabase.ts` decodes the key's `ref` claim and refuses to boot on a
  mismatch. That guard exists because this repo once shipped a production URL with a staging key.
- Anything named `VITE_*` is compiled into the bundle, i.e. public. Never a `service_role` key, never an FCM JSON, never a
  Turnstile secret key — the source scan (`node scripts/check-secrets.mjs`) fails the build if one appears in the tree.
- No restart shortcut: Vite reads `.env.local` at start, so after an edit, restart `npm run dev`.

## 2 · `workers/.dev.vars` — only for running the Worker locally

```bash
cp workers/.dev.vars.example workers/.dev.vars
```

The values you need for a laptop that talks to **staging**:

```bash
SUPABASE_URL=https://fnefpcjeebawsebxjhcf.supabase.co
SUPABASE_PROJECT_REF=fnefpcjeebawsebxjhcf
SUPABASE_ANON_KEY=<the same anon key as above>
SUPABASE_SERVICE_ROLE_KEY=<Project Settings → API → service_role>
SUPABASE_JWT_SECRET=<Project Settings → API → JWT Secret>
ALLOWED_ORIGINS=http://localhost:5000,http://127.0.0.1:5000,http://localhost:5173,http://127.0.0.1:5173
```

Without it, `wrangler dev` boots and every route that needs the database returns a "missing required configuration" error — which
is the intended loud failure, not a broken Worker. Everything else may stay unset and degrades as documented (`LOG_MODE=errors`,
Turnstile check skipped, mock push transport, default media ceiling). Queues, the Durable Object and R2 are emulated locally under
`.wrangler/state`, so a laptop needs **no Cloudflare resources at all** to develop.

Note the asymmetry: `.dev.vars` holds staging's service-role key, so it is git-ignored and it is never the file a deploy reads.
Production gets its secrets from `wrangler secret put`, per environment.

## 3 · Firebase (FCM) — what you get, and where each half goes

The database and the Worker talk to FCM directly; there is no Firebase SDK in the browser and no VAPID key. You need three things
from the **Firebase console** (console.firebase.google.com → your project → ⚙ Project settings):

| what                                                             | where                                                                                           | how the app learns it                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Project id (the string in the console URL, e.g. `kicklive-push`) | `workers/wrangler.toml` → `[env.production.vars]` **and** `[env.staging.vars]`                  | `FCM_PROJECT_ID` (a var, not a secret)     |
| The downloaded service-account JSON                              | `npx wrangler secret put FCM_SERVICE_ACCOUNT --env production` (and `--env staging`)            | `FCM_SERVICE_ACCOUNT` (secret only)        |
| For a laptop, both lines above                                   | instead: the same two entries in `workers/.dev.vars` (git-ignored, read only by `wrangler dev`) | nothing — that file never reaches a deploy |

Then, in the **Google Cloud** console for that same project (APIs & Services → Library), enable **Firebase Cloud Messaging API
(V1)**. Without it every send answers `403 PERMISSION_DENIED`, and the Worker's queue path will look like a push bug rather than a
disabled API.

And the three rules that make this safe:

- Nothing named `VITE_FIREBASE_*` exists in this project, and no Firebase SDK is loaded in the browser. The push path is
  `client → /api → Worker → FCM REST`; the browser holds a device token, not a Firebase config. So there is no Firebase key to put
  in `.env.local` — writing one there does nothing, and the absence of one is not a bug.

- The JSON never enters the repository, `.env.local`, `wrangler.toml`, or any `VITE_*` variable. `check-secrets.mjs` fails the
  build on a `"type": "service_account"` document, a PEM header, or a `firebase-adminsdk-…@` client email anywhere in the tree.
- Leaving `FCM_PROJECT_ID` **and** `FCM_SERVICE_ACCOUNT` unset is a supported state: `transportFor()` returns the mock transport, so
  jobs are still created, fanned out, recorded and counted. It is exactly right on a laptop, and it is the reason a green local run
  is not proof a notification reached a device. On staging/production both must be set or nothing leaves the account.

`FCM_TIMEOUT_MS` bounds one HTTP send so a hung Google endpoint cannot eat the queue's visibility window; leave it unset.

## 4 · The rest of the Cloudflare secret list (one command each, per environment)

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging     # then --env production, with that project's key
npx wrangler secret put SUPABASE_JWT_SECRET --env staging
npx wrangler secret put TURNSTILE_SECRET_KEY --env staging          # unset = the bot check is skipped (fine locally, not in prod)
npx wrangler secret put AD_VIEWER_KEY_SECRET --env staging          # unset = derived from SUPABASE_JWT_SECRET (works, couples rotations)
npx wrangler secret put FCM_SERVICE_ACCOUNT --env staging            # only if push must really leave the account
npx wrangler secret list --env production                            # must show all of them
```

`TURNSTILE_SITE_KEY` is the browser half of Turnstile and goes in the SPA build env (GitHub environment, or `.env.local` locally) —
public by design, harmless there, and it must be the widget paired with the Worker's secret or one half verifies nothing.

## 5 · "Did it take?" — three checks that answer it

```bash
node scripts/check-secrets.mjs            # → "All required secrets present."  (--json for the machine-readable table)
curl -s http://127.0.0.1:8787/api/health     # local Worker: {"status":"healthy","environment":"staging",…}
curl -s https://<your-pages-url>/api/health  # deployed: same shape, and the right "env" value
```

Then, only if FCM is configured: send a test push to one real device and confirm `notifications/devices` counted a registered
token. A mock transport reports success for exactly the same call, which is why the count — not the green checkmark — is the proof.
