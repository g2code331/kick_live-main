# Production deep dive — what stands between KickLive and a public launch

Audit date: **2026-10-10**. Branch: `arena/01a0a709-kick-live-main` at `8b3abf1`.

This document is a point-in-time audit. Every claim below is tagged with how it was established:

- **[ran]** — a command or check was executed in this audit and its output is recorded.
- **[read]** — established by reading the code, config, or a workflow run's metadata.
- **[sourced]** — an external platform or legal requirement, checked against web sources on the audit date. Confirm
  against the primary document before acting on it.
- **[unverified]** — could not be checked from the sandbox. Each one has a named check.

It complements `docs/GO_LIVE.md` (the runbook) and `npm run preflight:production` (the repo gate). It does not replace
either. Where it disagrees with them, this document says so.

---

## 1. Verdict

**Not ready for a public production launch.** The repository's own gates are green on the arena tip, but they measure
the repo, not the business. The blockers fall into five groups:

1. **The deploy pipeline on `main` is red**, and the production Worker runs base-era code.
2. **Store compliance** — Android cannot be uploaded to Google Play in its current form, and both stores require
   account deletion, which does not exist.
3. **Legal** — no privacy policy, terms, or support pages; and Ghana's Data Protection Act requires DPC registration
   before personal data is processed.
4. **Security** — the sign-up path has no bot check, the web host sends no security headers, and four high-severity
   advisories come in through a dependency added in this branch.
5. **Operations** — no backups, no external error tracking, and migrations `phase14`–`phase17` are not confirmed on
   the live database.

The good news: most of the engineering is in place. The gap is mostly configuration, store paperwork, two missing
product features (account deletion, report/block), and one deploy break that a merge fixes.

---

## 2. What was run, and what came back

| Check                                                         | Result                                                                                              | Source       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------ |
| `npm ci`                                                      | 594 packages installed                                                                              | [ran]        |
| `npm run preflight:production`                                | **17/21 green, 0 red, 4 need an operator**. The live-database check is skipped without `--dsn`      | [ran]        |
| `npm run verify`                                              | 22/22 checks passed                                                                                 | [ran]        |
| `npm run web:env:check`                                       | `.env.staging`, `.env.production`, `.env.mobile` all `current`                                      | [ran]        |
| `npm run sql:bundle:check`                                    | `SETUP.sql is current (17 sections)`                                                                | [ran]        |
| `npm run sql:run` (PGlite, real Postgres engine)              | 933 statements, **0 failures**                                                                      | [ran]        |
| `npm run db:check`                                            | every row `pass` or `n/a`                                                                           | [ran]        |
| `npm run typecheck` on the **arena tip**                      | exit 0                                                                                              | [ran]        |
| `npm run typecheck` on **`main` (`6a5038f`)**                 | **exit 2**: 4 errors (`crypto`, `CustomEvent`, `import.meta.env` ×2) — the break fixed by `8b3abf1` | [ran]        |
| `npm run gates -- --skip=6` on the arena tip                  | **22 pass, 0 fail, 4 skip** (each skip is covered by a named CI job)                                | [ran]        |
| `npm audit --omit=dev`                                        | **4 high**, all in `firebase` → `@firebase/firestore` → `@grpc/grpc-js` (pinned `~1.9.0`)           | [ran]        |
| `probe-deploy.sh` against a local SPA host serving `dist/web` | **PASS** — the artifact satisfies the Pages contract                                                | [ran]        |
| `probe-deploy.sh` against `kicklive-web-staging.pages.dev`    | cannot run from sandbox (TLS to `pages.dev` blocked)                                                | [ran]        |
| `npm run cf:check` (no Cloudflare credentials)                | reports all 10 resources `MISSING` — see §5.4, this is a **defect**, not evidence                   | [ran]        |
| `GET /api/health` on production and staging                   | both healthy; both report **`version: 0.1.0-phase2`, 101 routes declared, 87 implemented**          | [ran]        |
| `gh run list` on `main`                                       | the latest push-to-`main` runs of Full stack, CI, and Deploy web are **failure**                    | [ran]        |
| `gh api …/actions/runs/…/jobs` (failing steps)                | named below in §3                                                                                   | [ran]        |
| `GET https://kicklive.football/`                              | could not be fetched from the sandbox                                                               | [unverified] |

---

## 3. The deploy pipeline on `main` is red

`origin/main` is `6a5038f` — a merge that includes `e67911a` (device management) but not `8b3abf1` (push opt-in).
Three workflows failed on that push [ran]:

| Workflow       | Failing job / step                                            | Cause established                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full stack** | `Gates (typecheck, unit, integration, verify, worker routes)` | Typecheck. Reproduced on `main`: the latent `crypto` / `import.meta.env` break fixed by `8b3abf1`. **This blocks the staging deploy.**                                                                |
| **CI**         | `Typecheck (renderer+shared, scripts+server+desktop)`         | Same typecheck break. Reproduced.                                                                                                                                                                     |
| **Deploy web** | `Post-deploy probe` after `Pages deploy (staging)`            | **Not reproduced.** The artifact passes the probe locally. The Actions log is in blob storage the sandbox cannot reach. Earlier runs of this workflow alternate pass/fail, so transient is plausible. |

What this means in practice:

- **Staging and production are one deploy behind `main`.** The last _successful_ push-to-`main` deploy built
  `7c2bb17` on 2026-09-18, and that commit declares **101 routes** [ran]. Both Workers report 101, which is exactly what
  that commit and the base `34e407b` declare. The change that added messaging — `/messages/*` (six routes) and
  `POST /admin/notifications/direct` — arrived on `main` with the merge `6a5038f`, and **that is the push that failed**.
  So these endpoints exist in `main` but are **not deployed anywhere**, and the Messages screen and the admin
  direct-send screen would call endpoints that do not exist in production.
- **`Build mobile` passed** on the same push.
- A `v1.0.1` tag exists on the remote (`c4a9bb6`), but its release run failed at _"Verify the built bundle answers over
  the hardened server"_, no release was published, and `VERSION` still reads `1.0.0` [ran]. The stray tag should be
  deleted or the release re-cut properly.

**Actions**

1. Merge `arena/01a0a709-kick-live-main` into `main` (your step). This alone clears the typecheck break in both Full
   stack and CI. The gates were run on the arena tip and pass.
2. Re-run `deploy-web` once. If the probe fails again, open the run page in the Actions UI and read the failing check —
   it is the only place the detail is visible from outside the sandbox.
3. Delete the stray `v1.0.1` tag, or cut a real `1.0.1` with `VERSION` bumped.

---

## 4. Production data plane

### 4.1 Worker

- **Production has not been deployed from current code.** It declares 101 routes; `main` declares 108 [ran]. Deploy with
  `npm run worker:deploy:production` after the merge in §3, then confirm `GET /api/health` reports `108` declared and the
  `project_ref` is `xvksxqrmdbbinlrjctri`.
- **14 declared routes return `501 NOT_IMPLEMENTED`** [ran]. None of them are called by the shipped SPA [read], but
  they are part of the declared API contract and `docs/` treats them as real:
  - `POST /auth/sign-up` (described as the Turnstile-gated sign-up route — see §5.1)
  - `POST /auth/access-requests`, `GET/POST /admin/access-requests…`, `POST /admin/users/:id/role`, `GET /admin/audit`
  - `GET /matches`, `GET /teams`, `PATCH /teams/:id`, `POST /players`
  - `GET /media/feed`, `POST /media`, `POST /media/:id/publish`, `DELETE /media/:id`

  **Action:** either implement these or delete them from `workers/src/router.ts`. Declared-but-dead routes make the API
  look more complete than it is.

- **The version string is hardcoded** as `0.1.0-phase2` in the health response, while the app is `1.0.0`. Cosmetic, but
  it is the first thing an on-call person sees.
- **Production route is commented out** in `workers/wrangler.toml` (`[[env.production.routes]]`). That is correct _if_
  the zone route is attached in the dashboard, which is a separate manual step — see §4.3.

### 4.2 Database

- **Migrations `phase14`–`phase17` must be confirmed on the live database.** They are in the bundle [read] and the bundle
  executes cleanly on PGlite [ran], but PGlite is not PostgREST and not your live project. Preflight skips the live check
  without `--dsn`. Treat them as **not applied** until `npm run preflight:production -- --dsn="…"` and
  `supabase/DB_CHECK.sql` say otherwise.
- **Backups are not configured, and nothing in the repository does them.** `RELEASE_CHECKLIST.md` §12 says so
  explicitly. Enable Supabase PITR (a paid-plan feature — check your plan) or schedule `pg_dump` off-box, then restore
  once into a scratch project. An untested backup is a hypothesis.
- **Browser-direct writes are the main security surface.** `supabase.from('teams'|'players').insert/update/delete` is
  called from `TeamOwnerPortal.tsx` and the admin screens [read]. This is the accepted architecture (finding F-10 in
  `docs/SECURITY_AUDIT_PHASE1.md`, deferred). It is safe only if RLS is right. The RLS checks in `DB_CHECK.sql` pass [ran],
  but **an independent RLS review is the single most valuable pre-launch security task**, and it is not in the repo.

### 4.3 Web host and routing

- **The `/api/*` zone route is a manual step that `GO_LIVE.md` does not list.** The production web build uses
  same-origin `/api` (`VITE_API_BASE_URL` is empty in `.env.production`) [read]. That only works if the custom domain
  routes `kicklive.football/api/*` to the `kicklive-api` Worker. `DEPLOYMENT.md` describes it; `GO_LIVE.md` does not.
  Alternatively set `API_ORIGIN` on the Pages project, which `public/_worker.js` honours. Pick one, and add it to the
  runbook.
- **`public/_headers` sends no security headers** [read]. It has cache rules and `Service-Worker-Allowed` only. There is
  no `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` or
  `Referrer-Policy`. The local SPA host sets a CSP (`csp=true` in its startup log [ran]), so the production host and the
  local host differ. **Action:** add the headers to `public/_headers`, and add an assertion to `probe-deploy.sh` so the
  gap cannot reopen.
- **`kicklive.football` could not be reached from the sandbox** [unverified]. Check DNS, TLS, and that `/` serves the app.

### 4.4 Cloudflare resources

- The config names 10 resources across staging and production: 2 KV namespaces, 2 R2 buckets (`kicklive-media`,
  `kicklive-media-staging`), 6 queues. Your note says the R2 buckets and KV namespaces already exist.
- **`npm run cf:check` cannot tell "exists" from "could not check"** [read + ran]. In `scripts/provision-cloudflare.mjs`,
  `exists()` returns `ok = r.code === 0 && <name matched>`, so any wrangler failure (no token, wrong account, a token
  without list scope, a network error) becomes `MISSING`. Run unauthenticated, it reported all 10 as missing, which is
  not evidence of anything. `--apply` would then attempt to create resources that already exist. GO_LIVE step **B5**
  ("no diffs, exit 0") can pass for the wrong reason.
  **Action:** make the check three-state (`present` / `absent` / `unverified`). Only `absent` may trigger `--apply`.
  `unverified` must fail `--check` with a clear message. Add unit tests with a fake wrangler for each of the three cases.
  This is also the standing requirement from your earlier instructions.

---

## 5. Security

### 5.1 Sign-up has no bot check on the path users actually take — **critical**

- The Worker's `POST /auth/sign-up` is Turnstile-gated, but it is **not implemented** (501) [ran].
- The real sign-up calls **`supabase.auth.signUp` directly** from `AuthContext.tsx:166` [read].
- The SPA contains **no Turnstile widget and no `captchaToken`** [read — the only `turnstile` mention in `src/` is a
  comment in `src/lib/env.ts`].
- `RELEASE_CHECKLIST.md` line 266 says "the auth exchange routes are Turnstile-guarded where configured." That is true of
  a route nobody calls. **Sign-up is unguarded.** Finding F-15 in the security audit is still open in practice.

**Fix (recommended):** Supabase Auth supports CAPTCHA verification on sign-up. Enable Turnstile under
Auth → Attack protection with the same Turnstile secret, add the widget to `SignupPage`, and pass the token as
`captchaToken` in `signUp`. This keeps the Supabase-direct architecture and closes the path in one place. Then verify
it: a sign-up without a token must be rejected by Supabase. **Do not** rely on the Worker route, which is not wired.

### 5.2 Dependency advisories — high

- `npm audit --omit=dev`: **4 high**, all via `firebase` → `@firebase/firestore` → `@grpc/grpc-js` (pinned `~1.9.0`;
  advisories cover `<=1.13.5`) [ran].
- **This came from this branch** (`firebase@12.19.0`, added last turn). `npm audit`'s suggested fix is a breaking
  downgrade to `firebase@9.14.0` — do not take it.
- The app imports only `firebase/app` and `firebase/messaging` [read: `src/lib/push/index.ts:79-80`]. Neither depends on
  Firestore [ran: `npm view @firebase/messaging` and `@firebase/app` list no Firestore]. **Fix:** import
  `@firebase/app` and `@firebase/messaging` directly, drop the umbrella `firebase` package, rebuild, re-run `npm audit`,
  and run the push test suite.

### 5.3 Other security items

- **`TeamOwnerPortal.tsx` hotlinks `https://via.placeholder.com`** for image fallbacks [read]. It is a third-party request
  from a production page and a reliability dependency. Replace it with a bundled placeholder.
- **Browser console logging:** 21 `console.log` calls in `src/` [ran]. Route them through `src/lib/log.ts`, which is
  quiet in production.
- **`ALLOWED_ORIGINS` includes `https://localhost`** in production [read]. That is needed for the Android WebView and is
  documented as such. Keep it, but know why it is there.
- **Secrets:** `FCM_SERVICE_ACCOUNT` is reported as set (your confirmation). The Worker secrets
  (`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `TURNSTILE_SECRET_KEY`, `AD_VIEWER_KEY_SECRET`) and the GitHub
  environment secrets are **write-only and cannot be verified from here** [unverified]. `npx wrangler secret list` shows
  names, not values.

---

## 6. Compliance and legal

### 6.1 Account deletion — **blocker for both stores**

- **No account-deletion path exists** [ran: no route, RPC, or migration; `ProfilePage` offers only Sign Out and
  device revocation].
- **Apple** requires in-app account deletion for any app that supports account creation. Deletion must remove the
  account and its personal data; deactivation is not sufficient [sourced: Apple guideline 5.1.1(v)].
- **Google Play** requires in-app deletion **and** a public web link where a user can request deletion without the app,
  declared in the Data safety form [sourced: Google Play User Data policy]. Freezing or disabling an account does not count.

**Action:** build deletion as a server-side function (service-role, not browser-side), covering `profiles`, the user's
`notification_devices` (push tokens), `notification_preferences`, `message_threads` / `messages` they own, and
`notification_deliveries` addressed to them. Uploaded media must be handled too (see §6.3). Confirm the full list
against the schema before building. Decide and
document what is retained and why (fraud, legal). Expose it in Profile → Security & Privacy, and publish a matching web
page that works without the app.

### 6.2 Pages that do not exist — **blocker**

There is no route for `/privacy`, `/terms`, or `/support` [ran: `src/App.tsx` routes]. Both stores require a privacy
policy URL. The Play listing also needs the web deletion link from §6.1. Minimum set:

- Privacy policy — what is collected (email, username, phone, device push tokens, messages to staff, ad-event analytics),
  why, retention, third parties (Supabase, Cloudflare, Google FCM), user rights, deletion, and contact.
- Terms of service, including the acceptable-use rules that the report/block feature in §6.3 enforces.
- A support contact that is monitored. None exists in the app today.

### 6.3 User-generated content: report and block — **likely blocker**

- Messaging is staff-to-user only, not user-to-user [read: phase 15 header]. That lowers the risk.
- **But users can publish content that other users see**: team owners upload club and player images through
  `EntityImageUploader` (used in `TeamDashboard`, `TeamSquadDashboard`, `PlayerCreator`) [read]. There is **no report
  or block mechanism anywhere** [ran].
- Apple's guideline 1.2 requires, for apps with user-generated content, a way to report content and users and to block
  abusive users, and timely action on reports [sourced; read the guideline text — third-party summaries are not
  authoritative]. Google Play's UGC policy has an equivalent requirement.

**Action:** add report on any user-uploaded public image and on team/player content, a block action where it applies,
and an admin queue to act on reports. Even a minimal version (report → admin queue → hide) is the defensible baseline.

### 6.4 Ghana — Data Protection Act, 2012 (Act 843)

- Section 27(1) and 53: a data controller **must register with the Data Protection Commission before processing
  personal data**, and processing without registration is an offence [sourced: ghalii.org, Act 843]. Registration is valid
  for two years.
- The DPC announced a full enforcement drive in 2026 [sourced: GhanaWeb, Jan 2026].
- The app processes personal data of Ghanaian users (the operator is in Accra), so registration applies. **This is an
  action for you or your counsel, not for code.** Register the controller, record the purposes in the register, and keep
  the certificate. The privacy policy in §6.2 should match the registration.

### 6.5 Payments

- No in-app payments exist. Sponsorship is "contract, invoiced off-platform" [read: `docs/SPONSORSHIP_ARCHITECTURE.md`].
  There is no card-data or PCI scope in the app. Confirm this stays true before adding any checkout.

---

## 7. Mobile release

### 7.1 Android — **blocker for Google Play**

| Item                      | Current                                                                                                                                                            | Requirement / why it matters                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `targetSdkVersion`        | **34** [read: `android/variables.gradle`]                                                                                                                          | **New apps and updates must target API 36 from 2026-08-31** [sourced]. Existing apps below 35 stop being shown to new users on newer Android. A reported extension to 2026-11-01 must be requested in Play Console — do not rely on it. |
| `compileSdkVersion`       | **34**                                                                                                                                                             | Must move with target.                                                                                                                                                                                                                  |
| Build toolchain           | AGP **8.2.1**, Gradle **8.2.1**, Capacitor **6.2.2** [read]                                                                                                        | These predate API 36. Expect AGP and Gradle upgrades at minimum, and probably a Capacitor 7 migration. **Verify by building**; this is the largest mobile task.                                                                         |
| Artifact                  | The release job builds an **APK** [read: `ci/workflows/build-mobile.yml`]                                                                                          | Play requires an **Android App Bundle (AAB)** for new apps [sourced]. Add `bundleRelease`.                                                                                                                                              |
| `versionCode`             | hardcoded **`1`**, `versionName "1.0"` [read]                                                                                                                      | Each Play upload needs a higher `versionCode`. Derive both from `VERSION` (1.0.0 → versionName `1.0.0`, code from a monotonic counter).                                                                                                 |
| Signing                   | **No `signingConfigs` block** [read]. Signing relies on `-Pandroid.injected.signing.*` flags.                                                                      | Declare an explicit `signingConfigs.release` that reads env vars, so signing does not depend on injected flags. Verify with a tag dry run.                                                                                              |
| Silent debug-key fallback | On tag builds without the keystore secret, the job runs `assembleRelease \|\| assembleDebug`, which can ship a **debug-signed** artifact with a green check [read] | Make missing signing a hard failure on tag builds.                                                                                                                                                                                      |
| `google-services.json`    | Not in repo (expected — it is a per-project file)                                                                                                                  | Needed for FCM on Android. Plugin application is conditional, so the build succeeds without it [read].                                                                                                                                  |
| Keystore                  | Your note says it is done                                                                                                                                          | [unverified] — confirm the secrets exist in the `production` environment.                                                                                                                                                               |

v1.0.0's GitHub release contains `kicklive-1.0.0.apk`, which is **not** a Play-uploadable artifact.

### 7.2 iOS — **blocker for App Store**

- Apple requires builds uploaded to App Store Connect to use **Xcode 26 and the iOS 26 SDK** from **2026-04-28**
  [sourced]. The workflow runs on `macos-latest`, which must be checked to ship Xcode 26.
- The workflow **builds with signing disabled** and produces an unsigned `.app` [read]. A distributable IPA needs an
  Apple Developer Program membership (annual fee), a distribution certificate, a provisioning profile, and an App Store
  Connect app record. None are in place [unverified].
- `CURRENT_PROJECT_VERSION = 1` and `MARKETING_VERSION = 1.0` [read]. Bump the build number per upload.
- No `PrivacyInfo.xcprivacy` in `ios/App/App` [ran]. Capacitor plugins ship their own manifests; **confirm with an
  archive validation in Xcode** that the aggregate manifest is complete, since a missing manifest is an upload rejection.
- Account deletion (§6.1) and report/block (§6.3) apply to iOS as well.

### 7.3 Desktop

- The Windows `.exe` is **unsigned** (no code-signing certificate). SmartScreen will warn. The auto-updater still checks
  SHA-256, so integrity holds. This is documented and is a product decision, not a blocker, unless desktop is a launch
  target.

---

## 8. Observability and operations

- **Internal observability is strong** — `/api/observability/*`, the admin Monitoring page, and rollup tables [read].
  Alerts are computed at read time and **nothing delivers them**. Someone has to be looking at the page.
- **No external error tracking.** There is no Sentry-class service in the code [ran]. Browser exceptions are not
  reported anywhere.
- **Uptime monitoring** on `https://kicklive.football` and on `/api/health` is not configured [read — not in the repo].
- **Log drain** for Worker stdout is listed as `REQUIRES CONFIGURATION` in `RELEASE_CHECKLIST.md` §9.
- **Supabase email:** the built-in mailer is for development and rate-limited. Configure custom SMTP, the Site URL, and
  redirect URLs before launch, or confirmation and reset emails will fail silently under load [sourced: Supabase docs —
  verify the current limits in your dashboard].
- **Rollback** is documented and rehearsable (`GO_LIVE.md` E7). Rehearse it once before launch, not during an incident.

---

## 9. Repository hygiene

- **Six root-level directories `1/` … `6/` are PostgreSQL/PGlite data directories** (`PG_VERSION`, `base/`, `pg_wal/`),
  **984 tracked files each, about 439 MB total** [ran]. They are in the base commit `34e407b`, so they are in `main`.
  They bloat every clone and may contain data. Nothing in the code references them by name [ran]. **Action:** remove them
  from the index and add a `.gitignore` rule. Rewriting history to shrink the repo is a separate decision with
  coordination costs — ask before doing it.
- **`KICKLIVE_FINAL_SCHEMA.sql`, `SUPABASE_*.sql`-style files at the root** and several overlapping deployment docs
  (`DEPLOYMENT.md`, `DEPLOYMENT_GUIDE.md`, `DEPLOYMENT_CHECKLIST.md`, `docs/GO_LIVE.md`). The checklist says never paste the
  root schema files. Keep one source of truth and delete the rest, so nobody pastes the wrong one into production.
- **Route/doc drift:** `RELEASE_CHECKLIST.md` says the sign-up route is Turnstile-guarded. It is not wired (§5.1). Audit
  the claims in that document against the code before using it as evidence.

---

## 10. Things already solid (keep them)

These were checked this audit, not assumed:

- Repository gates: `verify` 22/22, `gates` 22 pass / 0 fail, typecheck clean on the arena tip, 768 tests passing.
- SQL: the bundle executes on a real Postgres engine with 0 failures; `DB_CHECK.sql` passes; the bundle is current.
- Project identity: staging and production are two different Supabase projects, pinned by ref in the build and the Worker.
- Privilege model: `role` cannot be self-set; role changes go through an audited, last-admin-guarded RPC; RLS is enabled
  on every privileged table.
- CORS is an explicit allowlist; `*` is rejected at startup.
- No mock or demo data fallback in the data layer [read].
- No payments in-app, so no card-data scope.
- The deploy workflows are protected: production needs an explicit dispatch input, and `preflight:production` checks for it.

---

## 11. Sequenced plan

**Phase 0 — make the pipeline true (now)**

1. Merge the arena branch into `main`. Confirm Full stack, CI, and Deploy web go green.
2. Re-run the staging deploy. If the probe fails again, read the Actions log in the UI.
3. Delete the stray `v1.0.1` tag.
4. Confirm `migrations 14–17` on the live database: `npm run preflight:production -- --dsn="…"`, then `DB_CHECK.sql`.
5. Deploy the production Worker from current `main`; confirm 108 routes and the correct `project_ref`.
6. Add the `/api/*` zone route (or `API_ORIGIN`) and add it to `GO_LIVE.md`.
7. Enable Supabase PITR (or off-box `pg_dump`), and restore once into a scratch project.

**Phase 1 — compliance (required before any public launch)**

8. Privacy policy, terms, and a monitored support contact, as public pages.
9. Account deletion: in-app and a public web link, with server-side erasure and a documented retention exception.
10. Report and block on user-generated public content, with an admin queue.
11. Ghana DPC registration (your or counsel's action).

**Phase 2 — security hardening**

12. Wire Turnstile into Supabase Auth sign-up (§5.1). Verify that a sign-up without a token is rejected.
13. Add security headers to `public/_headers` and assert them in `probe-deploy.sh`.
14. Replace `firebase` with `@firebase/app` + `@firebase/messaging`; re-audit to zero high.
15. Commission an independent RLS review of every table the browser writes to.
16. Remove `via.placeholder.com`; route the 21 `console.log` calls through `log.ts`.

**Phase 3 — mobile release**

17. Android: target and compile API 36; upgrade AGP, Gradle, and probably Capacitor; `bundleRelease`; `versionCode` from
    the version source; explicit `signingConfigs`; make missing signing fail on tag builds; Play Console setup, Data
    safety form, and the web deletion link.
18. iOS: Apple Developer enrolment; Xcode 26 on the runner; signing; App Store Connect record; `PrivacyInfo` validation.

**Phase 4 — operations**

19. External error tracking; uptime monitors on the web host and `/api/health`; a log drain.
20. Custom SMTP and Supabase auth URL configuration.
21. One rehearsed rollback (Pages and Worker) and one restore.

**Repo hygiene (any time, low risk, mostly parallel)**

22. Remove root-level `1/`–`6/`; fix `cf:check` to three-state; implement or delete the 14 `501` routes; set the version
    string from `VERSION`; consolidate the deployment documents.

---

## 12. Launch gate — what "ready" means

Ready when **all** of these are true, each with its proof:

- [ ] `main` is green on Full stack, CI, and Deploy web (proof: `gh run list --branch main`).
- [ ] Production Worker reports 108 routes and the production `project_ref` (proof: `GET /api/health`).
- [ ] Migrations 14–17 and `SETUP.sql` confirmed on the production database (proof: `--dsn` preflight and `DB_CHECK.sql`).
- [ ] `cf:check --check` exits 0 with every resource `present`, not `unverified` (proof: the three-state output).
- [ ] Sign-up without a Turnstile token is rejected (proof: a direct `signUp` call with no `captchaToken` fails).
- [ ] Account deletion works in-app and from the public web link, and removes the data (proof: a test account is erased).
- [ ] Privacy policy, terms, and support pages are live and linked from the app and the store listing.
- [ ] Report and block work on public user content (proof: a report reaches the admin queue and hides the content).
- [ ] Security headers present on the production host (proof: `probe-deploy.sh` asserts them).
- [ ] `npm audit --omit=dev` shows zero high or critical.
- [ ] Android AAB with `targetSdkVersion` 36 uploads to a Play internal track (proof: Play Console accepts it).
- [ ] iOS build uploads to App Store Connect (proof: upload accepted with Xcode 26).
- [ ] Backup restore rehearsed into a scratch project (proof: a restored project passes `DB_CHECK.sql`).
- [ ] DPC registration certificate held (proof: the certificate, filed by you or counsel).

---

## 13. Not verified in this audit

- Whether `kicklive.football` resolves, serves over TLS, and routes `/api/*` to the Worker.
- Whether migrations `phase14`–`phase17` and `SETUP.sql` are applied to the production database.
- The cause of the staging Pages probe failure on `main` (the Actions log is not reachable from the sandbox).
- Whether the GitHub environment secrets and Worker secrets are set, beyond `FCM_SERVICE_ACCOUNT` (confirmed by you).
- Whether the Cloudflare R2 buckets and KV namespaces exist (your report says they do; `cf:check` cannot confirm it — §4.4).
- Supabase dashboard settings: email confirmation, SMTP, redirect URLs, CAPTCHA, PITR status, plan.
- The current Google Play extension terms and Apple UGC guideline text — both are summarised here from secondary sources
  and should be read at the primary source before submission.
- Whether the Android keystore secrets are present in the `production` environment.

---

## Appendix — commands to re-run this audit

```bash
npm ci --no-audit --no-fund
npm run preflight:production
npm run verify
npm run web:env:check
npm run sql:bundle:check && npm run sql:run
npm run db:check
npm run typecheck
npm run gates -- --skip=6
npm audit --omit=dev
npm run cf:check                     # trust only after §4.4 is fixed
gh run list --branch main --limit 10
gh api repos/g2code331/kick_live-main/actions/runs/<id>/jobs
curl -fsS https://kicklive-api.g2code332.workers.dev/api/health
```
