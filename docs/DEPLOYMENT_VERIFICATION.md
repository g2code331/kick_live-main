# Deployed-build verification — the 16 checks

Run these **after** a deploy; they prove the deployed system, which nothing in the repo can reach from a
checkout. `W=https://kicklive.football` (use `https://staging.kicklive.football` for the staging column).
Checks marked **[CI]** are already asserted by the *Deploy web* workflow's post-deploy probe or by
`npm run gates`; the rest are one-command manual. `docs/ENVIRONMENT_SETUP.md` §5 is the deploy order;
this file is the proof-of-success.

| # | check | command / action | expect |
| - | ----- | ---------------- | ------ |
| 1 | Direct route navigation | `curl -s -o /dev/null -w '%{http_code} %{content_type}' $W/team/4` | `200 text/html…` — Pages serves the shell for extensionless routes (the catch-all function; **[CI]** for `/`) |
| 2 | The build being served is the build you shipped | `curl -s $W/ \| grep -o 'kicklive:version" content="[^"]*"'` and `curl -sI $W/ \| grep -i x-kicklive-app-shell` | version equals `cat VERSION` on the deployed commit; shell responses carry `x-kicklive-app-shell: 1` **[CI]** |
| 3 | Assets load — and missing ones stay 404 | probe does both: hashed asset `200 text/javascript` + `immutable`; `/assets/kicklive-does-not-exist-00000000.js` → `404`, never HTML **[CI]** | `bash scripts/ci/probe-deploy.sh $W` → `PASS` |
| 4 | API health | `curl -si $W/api/health` | `200`, body `"ok":true` with the right `"env"`, and header `x-ratelimit-store: kv` — the KV binding's canary |
| 5 | Authentication | Sign in in the browser; then `curl -s $W/api/me -H "Authorization: Bearer <access token>"` | anonymous → `401 AUTHENTICATION_ERROR`; valid token → `200` with `role`/`capabilities` |
| 6 | Public match data | `curl -s "$W/api/matches?limit=5"` | `200`, ≤5 bounded rows, columns as `src/lib/data` expects — no service key involved |
| 7 | Live match page connects | open a live fixture in the browser; DevTools → Network → WS | the socket upgrades (`101`) and frames tick; `npx wrangler tail --env production` shows `match_room` join logs |
| 8 | Realtime behaves | make an admin clock/event change on that fixture while watching | the fan view updates without reload; `wrangler tail` shows the DO broadcast |
| 9 | Fallback polling/SSE | with the match page open, DevTools → Network → set "Offline" for ~10 s, restore | status line degrades to stale, then **replays** and catches up; no double-applied events (the sequence cursor is what #9 tests) |
| 10 | PWA installability | Chrome → address bar install icon (or DevTools → Application → Manifest) | manifest parses, icons resolve, install prompt offered |
| 11 | Service worker registers | DevTools → Application → Service workers | scope `/`, state activated; `curl -sI $W/sw.js` → `200` + `cache-control: no-store` (**[CI]**: probe checks `200`) |
| 12 | Admin surface protected | `curl -s -o /dev/null -w '%{http_code}' $W/api/admin/users` (anon) and with a **fan** token | `401` anon; `403` fan; `200` admin — role comes from the profile row, never the request |
| 13 | Authenticated API calls | with an admin token, one privileged write (e.g. a role change to yourself is refused, a team edit applies) | envelope `{ok:true,…}`; Monitoring panel shows a new audit row |
| 14 | CORS rejects strangers | `curl -sI -H 'Origin: https://evil.example' $W/api/health \| grep -i access-control` | **no** `access-control-allow-origin` line for strangers; the configured origin sees itself back **[CI-adjacent]**: `phase2` tests pin this at unit level |
| 15 | Production does not point at staging | `curl -s $W/ \| grep -c fnefpcjeebawsebxjhcf` (plus: Cloudflare dashboard → `kicklive-api` → production variables → `SUPABASE_URL`) | **0** in the bundle; variables name the `xvksxqrmdbbinlrjctri` project |
| 16 | Staging does not point at production | same two greps against `staging.kicklive.football`, reversed | **0** hits for `xvksxqrmdbbinlrjctri` there; staging shows `fnefpcjeebawsebxjhcf` |

## Why #15/#16 are numbered last but feared most

The TOML, the GitHub environments, and the Supabase editor each hold one half of the URL/ref/key triple —
the mix-up happens between them, not inside any one. Two defences ship in the code (`src/lib/env.ts`
refuses to boot the SPA on a URL/key pair mismatch; `workers/src/services/supabase.ts` refuses a
`SUPABASE_PROJECT_REF` disagreement), and checks 15–16 are the human belt over those suspenders. After
any environment-secret edit, re-run both.

## Roll back the frontend

```bash
npx wrangler pages deployment list --project-name kicklive-web      # ids are addressable forever
npx wrangler pages rollback <DEPLOYMENT_ID> --project-name kicklive-web
```

Then re-run checks 1–3 against the rolled-back URL. The Worker has its own `npx wrangler rollback --env …`
and the database migrations are additive-only, so no check in this file ever requires a data restore.
