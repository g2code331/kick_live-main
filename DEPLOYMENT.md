# 🚀 Deploying KickLive's web app

**The web host is Cloudflare Pages. The API is the same repo's Cloudflare Worker. Supabase is the
database and auth provider.** One zone, three moving parts:

```
browser ──▶ Cloudflare Pages  (static bundle: dist/web + the SPA fallback function)
        ──▶ /api/* on the same origin ──▶ Cloudflare Worker (workers/, env staging|production)
                                      ──▶ Supabase (Postgres + RLS + GoTrue)
```

Vercel is no longer part of the production architecture (retired 2026-09-12; `vercel.json` and `.vercel/`
are deleted, and `public/functions/[[catchall]].js` + `public/_routes.json` + `public/_headers` now carry
the rewrite/cache contract the old `vercel.json` encoded).

## One-time per environment

For a fresh setup, follow [`docs/SETUP_WALKTHROUGH.md`](docs/SETUP_WALKTHROUGH.md) instead: same content, numbered so the order of
operations is unambiguous. This page is the reference for each part.

1. `npm run ci:install` — the four workflows in `ci/workflows/` are the source of truth and `.github/workflows/` is the copy
   GitHub executes; if the installed *Deploy web* still names Vercel, that is drift and your pushes deploy the old job.
2. Cloudflare resources for the Worker — queues, R2 buckets, the `RATE_LIMIT_KV` namespaces — per
   `docs/ENVIRONMENT_SETUP.md` §1. The KV ids are already in `workers/wrangler.toml`.
3. The database: paste `supabase/SETUP.sql` into the **staging** project's SQL editor, then the same file
   into **production**. One file, ten sections, idempotent — it is the only SQL a project needs
   (see `supabase/README.md` for why the old root files are gone).
4. Pages projects (wrangler can create them, but the dashboard is equivalent):
   ```bash
   npx wrangler pages project create kicklive-web         --production-branch main
   npx wrangler pages project create kicklive-web-staging --production-branch main
   ```
5. Custom domains — Pages → project → Settings → Functions/(domains) → *Set up a custom domain*:
   `kicklive.football` + `www` on production, `staging.kicklive.football` on the staging project. The zone
   is already on Cloudflare, so DNS records are created automatically. **Add `/api/*` as a Worker route**
   on each hostname (Workers & Pages → `kicklive-api` → Routes → `kicklive.football/api/*` etc.) — that is
   what makes `/api` same-origin for the Pages app and removes any need for a CORS wildcard.
6. GitHub: Settings → Environments → create `production` and `staging` (and `preview` if you want
   dispatch-previews); in each, secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the pair for _that_
   Supabase project), `CLOUDFLARE_API_TOKEN` (scope: `Cloudflare Pages:Edit`), `CLOUDFLARE_ACCOUNT_ID`.

## Deploy (CI — the normal path)

Push to `main`, or Actions → *Deploy web* → Run workflow (`preview` | `staging` | `production`).
The workflow builds `dist/web` with the environment's two `VITE_` secrets, runs
`scripts/verify-packaging.mjs`, uploads, and `probe-deploy.sh` re-asserts the contract (shell for routes,
404 for missing hashed assets, JS MIME type, no traversal) **against the live URL** — a green
`Deploy web` means all of that, not just "the upload finished".

## Deploy (manual, e.g. first time or emergency)

```bash
npm run build:web
npx wrangler pages deploy dist/web --project-name kicklive-web --branch main        # production
npx wrangler pages deploy dist/web --project-name kicklive-web-staging --branch main # staging
bash scripts/ci/probe-deploy.sh https://kicklive-web.pages.dev                       # contract, not vibes
```

## Roll the frontend back

```bash
npx wrangler pages deployment list --project-name kicklive-web       # find the last good deployment
npx wrangler pages rollback <DEPLOYMENT_ID> --project-name kicklive-web
```

Pages keeps every deployment addressable, so rollback is instant and the bundle version the header shows
(`x-kicklive-bundle`) matches the `VERSION` of the commit you rolled back to. The Worker is independent —
a frontend rollback never touches the API or the database.

## Verify what is deployed

`docs/DEPLOYMENT_VERIFICATION.md` is the 16-check post-deploy checklist (routes, assets, health, auth,
live room, realtime + fallbacks, PWA, service worker, admin protection, CORS, and the two
"staging must not be production" cross-checks), with the exact command for each.
