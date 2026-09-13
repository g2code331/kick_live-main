# KickLive release pipeline

Everything that stands between `git tag v1.2.3` and a user installing something. Written for the
person who has to debug it at 23:00, so each section names the file that implements it and the log
line it emits.

Two surfaces ship from one build graph:

| surface         | what a user gets                                             | how it updates                                                               | who owns the update decision                                                      |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| desktop (Linux) | `kicklive_<ver>_amd64.deb`, `KickLive-<ver>-x86_64.AppImage` | a JSON manifest from GitHub Releases → download → verify → `apt-get install` | Electron **main** process (`desktop/src/main.ts` → `shared/update-controller.ts`) |
| web / PWA       | the built `dist/web` bundle behind any static host           | `sw.js` sees a new `version.json`/manifest → "reload to update"              | the renderer (`src/lib/updates.ts` → same controller)                             |

Both surfaces use **one** policy implementation (`shared/update-manifest.ts::decideUpdate`) and
**one** branding/version source of truth, so "the desktop says an update exists" and "the web says
an update exists" cannot drift apart.

---

## 0. One-time bootstrap (why CI files live in `ci/workflows/`)

`.github/workflows/**` cannot be written by this repo's automation token — pushes touching that path
are rejected by a server-side hook, and the Actions API returns 403 for the token in `gh auth`. So
the workflows are **source** in `ci/workflows/` and **generated** into `.github/workflows/`:

```bash
npm ci
npm run ci:install         # copies ci/workflows/*.yml → .github/workflows/
git add .github/workflows && git commit -m "ci: install workflows" && git push
```

A fresh clone has CI files only after that step (`.github/workflows/` is git-ignored precisely so
the copy is never committed twice and never silently diverges). `npm run ci:check` fails if the two
directories disagree, and `npm run verify` includes that check plus a YAML parse of every workflow.

If you can grant the bot `Actions: write`, delete the ignore entry and commit `ci/workflows/` as the
canonical location with a symlink-free copy step; nothing else changes.

---

## 1. Job / artifact map

| workflow         | trigger                   | job                | produces / asserts                                                                                                                                        | artifacts uploaded                                                                      |
| ---------------- | ------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `ci.yml`         | PR, push `main`, dispatch | `quality`          | typecheck (both tsconfigs), 221 tests, prettier, `verify` (17 checks), manifest samples                                                                   | —                                                                                       |
|                  |                           | `web`              | `npm run build` (web + renderer + desktop bundles), tier-A layout tests, live curl probe of the static server                                             | `kicklive-web-dist`, `kicklive-renderer-dist`                                           |
|                  |                           | `desktop`          | `setup-linux-tools.sh`, `package:linux`, `verify:full` (tiers B+C), `desktop-smoke.sh`                                                                    | `kicklive-deb`, `kicklive-appimage`, `kicklive-packaging-report`, `kicklive-smoke-logs` |
| `release.yml`    | `v*` tag, dispatch        | `preflight`        | version/tag agreement, **secrets audit**, gates 1/4/5, gate 6 rehearsal                                                                                   | —                                                                                       |
|                  |                           | `desktop` (×2)     | electron-builder for `x64` and `arm64`, full layout tests, xvfb smoke (x64 only)                                                                          | `desktop-x64`, `desktop-arm64`                                                          |
|                  |                           | `web`              | `build:web` with real Supabase env, `verify-packaging`, `version.json` assertion                                                                          | `web-bundle`                                                                            |
|                  |                           | `release`          | **manifest built from the real artifact bytes**, validated, GitHub Release, published-manifest + sha256 re-verification                                   | `release-manifests`                                                                     |
| `deploy-web.yml` | push `main`, dispatch     | `build` → `deploy` | builds `dist/web`, Cloudflare Pages preview/staging/production (`wrangler pages deploy`), then `probe-deploy.sh` against the live URL                     | `web-deploy-bundle`                                                                     |
| `nightly.yml`    | 03:30 UTC                 | `gates`            | clean `npm ci`, `node scripts/gates.mjs` (all six), real packaging, xvfb smoke, **installs the .deb with dpkg and uninstalls it**, live-feed client check | `nightly-smoke-logs`                                                                    |

Artifact naming is fixed by `electron-builder.yml`'s `linux.artifactName`:
`kicklive_${version}_${arch}.deb`, `KickLive-${version}-${arch}.AppImage`.

Downloading them:

```bash
gh run download <runId> -n kicklive-deb                      # CI run artifacts
gh run download <runId> -n kicklive-smoke-logs
gh release download v1.2.3 -p '*_amd64.deb' -D .             # published releases
gh release download v1.2.3 -p 'kicklive-update-stable.json' -D .
```

## 2. Version and branding lockstep

`VERSION` (repo root) is canonical. `scripts/version.mjs check` fails unless every dependent agrees:

```
VERSION → package.json .version → dist/web/version.json → dist/web/sw.js (built comment)
        → package-lock.json root .version → renderer build define __APP_VERSION__
        → index.html <meta name="kicklive:version"> (stamped at runtime, tag presence asserted)
```

`scripts/branding.mjs check` derives the same way from `shared/branding.ts` (single brand object):
`packaging/linux/kicklive.desktop`, `public/site.webmanifest`, `packaging/icons/<S>x<S>.png`
(16…512, generated from `public/kicklive-icon.png` with per-row PNG filter selection), and asserts
the CSP, the `StartupWMClass`, and that no `src="/…"` absolute asset URL exists anywhere in `src/`
(absolute URLs resolve to the filesystem root under `file://` and break the desktop build).

`scripts/brand-assets.mjs` (`npm run brand:assets`, `brand:assets:check`) owns the _other_ half of the same
directory: the sizes a browser loads (`public/brand/*.png`, and `public/favicon.svg` rebuilt from them). It
uses the same codec as `branding.mjs` — `scripts/lib/png.mjs`, which gained colour-type selection and Paeth
filtering for the job — and it never edits a master, so the two scripts write disjoint files. Gate 5 runs the
`--check`, and `scripts/bundle-budget.mjs` gates the built bundle's fan-visible bytes from inside
`npm run build:web`.

`check` is read-only (what CI runs); `write` regenerates. Both are idempotent — gate 5 hashes all
generated files before and after a `write` and requires byte-identical output.

```bash
npm run version:write -- patch   # bump everywhere
npm run branding:write           # regenerate icons/manifest/desktop entry
```

## 3. Build graph

| script                         | what it does                                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-web.mjs`        | Vite JS API + `@vite-pwa` build, then `emitBuildManifest()` → `dist/web/kicklive-build-manifest.json`; fails if `index.html` or `sw.js` is missing                                                                                                                  |
| `vite.renderer.config.ts`      | the desktop renderer into `renderer/dist` with `base: './'` (relative asset URLs, required by `file://`)                                                                                                                                                            |
| `scripts/build-desktop.mjs`    | esbuild → `build/electron/{main,preload}.cjs` (CJS, `electron` external, `__BUILD_VERSION__` defined), writes `build-info.json`, then `verifyBundle()` asserts the bundle still requires electron, contains no ESM statement, and no `import.meta.dirname` survived |
| `scripts/package-linux.mjs`    | `electron-builder --linux` → `release/`, writes `artifacts.json` + `checksums.json` (sha256 of every artifact), then `verify-packaging --require-full`                                                                                                              |
| `scripts/verify-packaging.mjs` | tiers A/B/C (below) → `release/packaging-report.json`                                                                                                                                                                                                               |

## 4. Static file server (`server/static-server.ts`, `server/mime.ts`)

Serves `dist/web` for self-hosting **and** is embedded in the Electron main process as the load
fallback. The three rules the spec demands, and how they are enforced:

1. **Path traversal.** Rejected _before_ filesystem access, in layers: raw `..`, `%2e`, `%252e`
   (double-encoded), `%c0%ae` (overlong UTF-8), `%2f`/`%5c`, backslashes, NUL bytes, control chars,
   and any path that decodes to more than one round. Then `path.resolve` + a containment check, then
   `fs.realpathSync` + a second containment check so a symlink out of the root is refused
   (`403 escapes-root`). Dotfiles are `404 dotfile`, never `403`, to avoid confirming existence.
2. **Missing assets are 404s, not the app shell.** A request whose path has an _asset_ extension
   (`.js .mjs .css .png .webmanifest …`, shared with the service worker via `isAssetExtension`)
   returns `404` + `X-KickLive-Reason: missing-asset` and a `text/plain` body. Only extensionless
   navigation routes fall back to `index.html`, and those carry `X-KickLive-App-Shell: 1` so you can
   tell a shell-served page from a real file in the logs. Cloudflare Pages implements the same rule with
   `public/functions/[[catchall]].js` + `public/_routes.json` (extensionless → shell, dotted misses → 404, `/assets/*` never enters the function).
3. **MIME types.** `.js/.mjs → text/javascript; charset=utf-8` (ES modules are _refused_ by the
   browser without a JS type), `.webmanifest → application/manifest+json`, `.wasm →
application/wasm`, `.svg → image/svg+xml`, unknown → `application/octet-stream` (never HTML),
   plus `X-Content-Type-Options: nosniff`. Types come from `server/mime.ts`, not from node's map.

Also: ETag/`If-None-Match` → 304, `HEAD` returns headers with `Content-Length`, hashed assets are
`public, max-age=31536000, immutable` while `index.html`/`sw.js`/`version.json`/`site.webmanifest`
are `public, max-age=0, must-revalidate`, `Host` is validated (`loopback` by default,
`--allow-any-host` to opt out), non-GET → `405 Allow: GET, HEAD`, and a CSP header (`--no-csp` to
disable while debugging).

```bash
node server/cli.ts --root dist/web --port 5174        # exit 1 if the root or index.html is missing
node scripts/run-tests.mjs integration                # 54 tests, half of them raw-socket traversal
```

## 5. The renderer load ladder (`shared/renderer-load.ts`)

`desktop/src/main.ts` builds a plan and walks it; the log vocabulary is the contract that
`scripts/verify-packaging.mjs`, `scripts/smoke-desktop.mjs` and `scripts/ci/desktop-smoke.sh` grep,
so changing a word here changes three other places — they are asserted together.

```
[kicklive:renderer] LOADED source=<target> attempt=<n>/<total>
[kicklive:renderer] LOAD_FAILED attempt=<n>/<total> source=<target> error="<msg>" retryInMs=<d>
[kicklive:renderer] RETRY attempt=<n+1>/<total> inMs=<d>
[kicklive:renderer] FALLBACK_ACTIVE source=<target> attempt=<n>/<total>
[kicklive:renderer] EXHAUSTED attempts=<total> lastError="<msg>"
[kicklive:renderer] DIAGNOSTIC <key>=<value>
```

Order: `file://<resources>/renderer/dist/index.html` (4 attempts, backoff 250/500/1000 ms) →
embedded loopback HTTP server serving the same tree → built-in diagnostic page. The diagnostic page
ships its own `default-src 'none'` CSP, contains no `<script>` and no inline handler, and prints the
root, the expected index, the fallback origin, the log file path and the `KICKLIVE_RENDERER_ROOT`
escape hatch.

Knobs (all env, all read by `desktop/src/main.ts`):

| knob                                     | meaning                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `KICKLIVE_RENDERER_ROOT`                 | override the renderer directory (dev, or an operator with a broken install) |
| `KICKLIVE_LOAD_ATTEMPTS`                 | attempts per source, clamped 1…6                                            |
| `KICKLIVE_SMOKE`                         | `1` → run the DOM probe after load and `app.exit(0/3/4)`                    |
| `KICKLIVE_SMOKE_BAD_LOAD`                | `1` → force the primary path to a nonexistent file (proves the fallback)    |
| `KICKLIVE_NO_HTTP_FALLBACK`              | `1` → skip the embedded server (tests exhaustion)                           |
| `KICKLIVE_HTTP_PORT`                     | pin the fallback port (0 = ephemeral)                                       |
| `KICKLIVE_LOG_FILE`                      | `0` disables the file log (stderr only)                                     |
| `KICKLIVE_VERBOSE` / `KICKLIVE_DEVTOOLS` | extra diagnostics                                                           |

## 6. The updates contract (`shared/update-manifest.ts` and friends)

### Manifest schema (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "product": "kicklive",
  "channel": "stable",
  "version": "1.2.3",
  "releasedAt": "2026-09-01T12:00:00.000Z",
  "notes": "≤4000 chars",
  "notesUrl": "https://…",
  "mandatoryBelow": "1.1.0",
  "minSupportedVersion": "1.0.0",
  "platforms": {
    "linux_x64": { "kind": "deb", "fileName": "kicklive_1.2.3_amd64.deb", "url": "https://…", "sha256": "64 hex", "size": 123456, "minGlibc": "2.28" }
  },
  "web": { "version": "1.2.3", "swUrl": "/sw.js", "precache": ["/"] }
}
```

The validator is hand-written (no dependency, because the renderer bundle must not grow for this)
and returns `{ ok:false, errors:[{path,code,message}] }` listing **every** problem at once. Rules:
`product` must be exactly `kicklive` (a foreign feed must never be able to push an update);
`url` must be `https:` unless the caller opts into `allowInsecureUrls` (local dev feed + tests);
`fileName` must equal the URL basename and be one safe path segment; `sha256` 64 lowercase hex;
`size` a positive safe integer; unknown top-level fields are rejected **except** `x*` extension keys
(`xGitHubRun` etc.), which are ignored for forward compatibility; at least one platform.

Feed URLs (overridable by `KICKLIVE_UPDATE_MANIFEST_URL` / `VITE_UPDATE_MANIFEST_URL`):

- stable: `https://github.com/g2code331/kick_live-main/releases/latest/download/kicklive-update-stable.json`
- beta: `…/releases/download/update-channel-beta/kicklive-update-beta.json` (moving git tag)

### Behaviour as implemented (this is the table the app actually exhibits)

| situation                                         | desktop surface                                                                                                                                                                      | web / PWA surface                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| manifest newer than installed                     | `state=available reason=update-available`, header control shows a download icon, dialog once per open                                                                                | same, action is **reload** (activate waiting SW)                                                                          |
| manifest equal or older                           | `state=up-to-date reason=current-is-newest` / `never-downgrade`; **never** offered                                                                                                   | same (`web.version` is compared for this surface)                                                                         |
| snoozed (12 h default)                            | `state=available`, `reason=snoozed`, `prompt=false`; persisted per candidate version in `userData/settings.json`                                                                     | **snooze is not applied** (`snoozedFor()` returns false for `surface==="pwa"`): a bundle swap is not a disruptive install |
| `mandatoryBelow` (or below `minSupportedVersion`) | `mandatory=true`, snooze ignored, dialog cannot be dismissed for 12 h                                                                                                                | same, but "install" is "reload"                                                                                           |
| feed unreachable / offline                        | `state=unknown reason=manifest-unreachable`, header shows `unknown` + last-seen timestamp, **never** "up to date"                                                                    | same                                                                                                                      |
| manifest present but invalid                      | `state=error reason=manifest-invalid` with the schema errors attached; logged, not dialogged                                                                                         | same                                                                                                                      |
| no platform entry for this arch                   | `state=error reason=platform-missing` (detail names the platform id)                                                                                                                 | n/a (`web` block instead)                                                                                                 |
| wrong channel (beta client, stable feed)          | `state=error reason=channel-mismatch`                                                                                                                                                | same                                                                                                                      |
| artifact checksum/size mismatch after download    | `verifyDownloadedArtifact` refuses; `REFUSE_INSTALL reason=checksum-mismatch`; staged `.part` deleted; **no installer is ever spawned**                                              | n/a (the service worker's cache is not a code path)                                                                       |
| "install" pressed on desktop                      | default `applyMode:"manual"` → download + verify + **print** `pkexec env DEBIAN_FRONTEND=noninteractive apt-get install -y <file>`; `KICKLIVE_UPDATE_APPLY=system` runs that command | `reload()` → `waiting SW claim + location.reload()`                                                                       |
| prompt frequency                                  | at most **one automatic prompt per app open** (in-memory latch; a restart may prompt again — the snooze is what silences it)                                                         | same latch, same rule                                                                                                     |
| no feed configured                                | header control **still renders** with `data-state="unknown"` `data-feed-configured="false"`                                                                                          | same                                                                                                                      |
| storage unreadable / corrupt                      | logged `STORE_READ_FAILED` / `STORE_WRITE_FAILED`, check proceeds from empty store                                                                                                   | same (a corrupt `localStorage` blob is treated as empty)                                                                  |

Log vocabulary (both surfaces, prefix `[kicklive:updates]`):

```
CHECKED reason=<startup|manual|focus> surface=<desktop|pwa> state=… reason=… candidate=… [mandatory=true] [lastSeen=…] prompt=…
SNOOZED version=… until=…
REFUSE_INSTALL reason=… detail="…"
DOWNLOAD_START url=… file=… expectedBytes=…
DOWNLOAD_VERIFIED file=… sha256=… bytes=…
STAGED_FOR_USER command="pkexec env … apt-get install -y …"
INSTALL_HANDOFF kind=deb command="…" / INSTALL_OK version=… / INSTALL_FAILED code=… detail="…"
STORE_READ_FAILED / STORE_WRITE_FAILED detail="…"
```

Update _state_ persistence: desktop = `userData/settings.json` (`updates` sub-object, 0600,
atomic rename, corrupt file preserved as `settings.json.corrupt-<ts>`); web = `localStorage`
key `kicklive.updates.v1`. Same `UpdateStore` shape (`lastSeen`, `lastCheckAt`, `lastOutcome`,
`snoozedUntil`, `schemaVersion: 1`).

### Desktop↔renderer IPC (privileged side only)

`desktop/src/preload.ts` exposes `window.kicklive` (`contextIsolation`, no `nodeIntegration`,
`sandbox: true`, deny-all permission handler). Methods: `getVersion`, `getInfo`,
`checkForUpdates`, `startupUpdateState`, `snoozeUpdate`, `installUpdate`, `openExternal`,
`restart`, `getSettings`, `setSnooze`, `onUpdateEvent`. The renderer never touches `fs`/`child_process`.

## 7. Packaging (`electron-builder.yml`, `packaging/`)

`files:` packs exactly `package.json`, `build/electron/**`, `renderer/dist/**` (no `node_modules` —
the app has zero runtime deps in the asar), `asar: true`, `asarUnpack: renderer/dist/assets/**`
(the embedded HTTP fallback reads those bytes directly; asar's shim would otherwise answer a
`fs.readFile` with the packed copy — both work, unpacked keeps the server out of the archive path).

Verified against `node_modules/app-builder-lib` rather than guessed:

- The `.desktop` file is **generated by electron-builder** from `linux.desktop.entry` + these
  fields, so `packaging/linux/kicklive.desktop` (generated by `scripts/branding.mjs`) is asserted
  key-by-key against the file inside the `.deb` by tier C, including `StartupWMClass=kicklive`
  (taken from `package.json.desktopName` minus `.desktop`) and `MimeType=x-scheme-handler/kicklive`
  (auto-derived from `protocols.schemes`).
- `syncDesktopName: true` keeps `Name=` in sync with the locale entries.
- Icons land in `usr/share/icons/hicolor/<S>x<S>/apps/kicklive.png`; tier C reads each PNG header
  and asserts the dimensions match the directory it was installed into.
- `deb.depends` is overridden with the **t64** package names (Ubuntu 24.04 renamed
  `libasound2 → libasound2t64` etc.), and `deb.recommends: []` drops the default
  `libappindicator3-1`, which does not exist on 24.04 and made `dpkg -i` fail.
- The deb is built by **fpm**; electron-builder only templates `afterInstall`/`afterRemove`, so the
  upgrade hook is wired via `deb.fpm: ["--after-upgrade=packaging/hooks/after-upgrade.sh"]`.
  Hooks are lodash-templated with `${executable}` / `${sanitizedProductName}` — that is why they are
  `.sh` files with `${...}` placeholders and why `homepage` must be set in `package.json`.
- `packaging/hooks/after-install.sh` wires `/usr/bin/kicklive` through `update-alternatives`, makes
  `chrome-sandbox` setuid **only when unprivileged user namespaces are unavailable**, refreshes the
  desktop/mime/icon caches, and exits 1 if the payload is incomplete. `after-remove.sh` undoes the
  symlink/alternative and refreshes caches, never touching `~/.config/kicklive`.
  All three hooks are `bash -n`'d by `verify.mjs` and `verify-packaging.mjs` (tier A4), and required
  to start with a bash shebang, forbid CRLF, and forbid `set -e`.

Layout test tiers (`scripts/verify-packaging.mjs`):

| tier | needs                    | asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | only the build output    | renderer/dist present + relative URLs + `type="module"` + every referenced asset resolvable + no `sw.js` in the renderer + version meta present; `dist/web` has `sw.js`/`version.json` and a `site.webmanifest` identical to source; esbuild bundles contain the load-ladder + updates vocabulary and `setDesktopName`; every repo `.sh` passes `bash -n`; branding + version lockstep; **synthetic `asar pack --unpack` with the real `@electron/asar`** then `asar list --is-pack`, `extractFile` of `main.cjs`/`index.html`/`package.json`, in-asar version == `VERSION`, main entry resolvable, no runtime deps |
| B    | `release/linux-unpacked` | ELF magic on the binary, `resources/app.asar` present, `chrome-sandbox` mode, unpacked assets on disk, `asar list` of the real archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C    | `release/*.deb`          | `dpkg-deb -f` fields (Version, Architecture, Depends with t64 names, no Recommends), `-c` listing `/opt/KickLive/kicklive` + hicolor icons + `.desktop`, `-x` extraction then **key-by-key comparison of the installed `.desktop` against the generated one**, `-e` control files `bash -n`'d, `checksums.json` covering every artifact                                                                                                                                                                                                                                                                             |

`--require-full` (used by `package:linux` and the desktop job) turns a missing tier B/C into a
failure, so CI can never "pass" without ever having looked at a `.deb`.

## 8. Secrets

`node scripts/check-secrets.mjs --job=<job>` runs in every job that consumes secrets. Missing
**required** secrets are `::error::` and fail the job; optional ones are `::warning::` and a line in
the job summary. `KICKLIVE_ALLOW_MISSING_SECRETS=1` downgrades required to warning for rehearsals.

| secret                   | required            | used by                        | what the run looks like when it is missing                                                                                                                                                                                                                          |
| ------------------------ | ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`      | yes (build jobs)    | web, desktop, release, deploy  | **no error from GitHub** — `${{ secrets.X }}` renders empty, Vite inlines the fallback URL baked in `src/lib/supabase.ts`, and the app ships pointed at the wrong project. `check-secrets.mjs` fails the job instead: `::error::secret VITE_SUPABASE_URL is unset`. |
| `VITE_SUPABASE_ANON_KEY` | yes (build jobs)    | same                           | same shape; symptom is an empty schedule board. Note the key and URL in that file disagree in the checked-in fallbacks — set both secrets and stop relying on the fallback.                                                                                         |
| `CLOUDFLARE_API_TOKEN`   | no (deploy-web)     | deploy-web                     | the deploy step prints `::error::CLOUDFLARE_API_TOKEN is not set: the web deploy cannot run. Configure it under Settings → Environments` and exits 1; `build` still produces `web-deploy-bundle`                                                                    |
| `CLOUDFLARE_ACCOUNT_ID`  | no (deploy-web)     | deploy-web                     | as above, naming that secret                                                                                                                                                                                                                                        |
| ~~`VERCEL_*`~~           | —                   | —                              | removed with the Vercel host on 2026-09-12; Pages needs only the two secrets above                                                                                                                                                                                  |
| `GITHUB_TOKEN`           | provided by Actions | release (assets + channel tag) | `release.yml` needs `permissions: contents: write`; without it `gh release create` fails with `HTTP 403: Resource not accessible by integration`                                                                                                                    |

No secret is needed for the update feed: the manifest and the artifacts are **public release assets**,
so the desktop client works for anyone who can reach `github.com`.

```bash
gh secret set VITE_SUPABASE_URL --repo g2code331/kick_live-main < url.txt
gh secret set VITE_SUPABASE_ANON_KEY --repo g2code331/kick_live-main < key.txt
```

## 9. Cutting a release

```bash
# 1. bump (writes VERSION, package.json, lockfile root, version.json dependents)
npm run version:write -- patch && npm run branding:write && npm run format
npm run gates                         # 19 pass, 0 fail locally; gate 6 needs the commit
git commit -am "release: KickLive v1.2.3" && git push origin main

# 2. tag → release.yml does everything else
git tag v1.2.3 && git push origin v1.2.3

# 3. watch it
gh run watch                              # or: gh run list --workflow=Release
gh release view v1.2.3                      # assets incl. kicklive-update-stable.json
```

Beta channel instead of stable (same artifacts, different feed):

```bash
gh workflow run release.yml -f version=1.2.4-beta.1 -f channel=beta
# the beta job re-points the moving tag: git tag -f update-channel-beta <sha> && git push -f origin refs/tags/update-channel-beta
```

Promote beta → stable (no rebuild; the manifest is re-published against the _existing_ assets):

```bash
npm run update-manifest -- promote --tag v1.2.4-beta.1 --channel stable --dry-run   # shows commands
```

## 10. Rolling back a bad manifest

The manifest is the only stateful thing here, and it is **immutable per release**, so a rollback never
requires rebuilding binaries. Stable clients read `releases/latest/download/kicklive-update-stable.json`:

```bash
# 1. re-publish the previous release's manifest over the latest release's asset (this is the rollback)
npm run update-manifest -- rollback --to v1.2.2
#   = gh release download v1.2.2 -p kicklive-update-stable.json -D <tmp>
#     gh release upload latest <tmp>/kicklive-update-stable.json --clobber

# 2. confirm what clients will read
curl -fsSL https://github.com/g2code331/kick_live-main/releases/latest/download/kicklive-update-stable.json |
  node scripts/update-manifest.mjs validate -
```

Properties that make this safe, and their limits:

- The published URL is not cached (`no-store` on release-asset redirects), so clients pick the
  rollback up on their next check.
- A client already on the newer version sees `state=up-to-date reason=never-downgrade` and is not
  nagged; it is never offered the older package.
- A client that already installed the bad build is **not** auto-downgraded (by design: never
  downgrade). Fix that user by installing the good `.deb` by hand:
  `sudo dpkg -i kicklive_1.2.2_amd64.deb && sudo apt-get install -f -y`.
- To stop the bleeding _before_ the rollback lands, publish a manifest whose `version` equals the
  current stable version: every client then reports `up-to-date` and stops prompting.
- Beta: `git tag -f update-channel-beta v1.2.1 && git push -f origin refs/tags/update-channel-beta`.

## 11. Verifying locally (everything that does not need GitHub)

```bash
npm run typecheck          # both tsconfigs
npm test                   # 152 unit + 54 integration (real sockets, real files)
npm run format:check
npm run verify             # 17 checks: branding, version, hooks, yaml, Pages contract, lockfile, manifest templates
npm run build              # web + renderer + desktop bundles
npm run verify:packaging   # tier A (45 checks incl. a real asar pack/list/extract)
node scripts/gates.mjs     # the §7 gate run with the table below
```

Requires a display + network, so usually only CI runs these:

```bash
npm run package:linux -- --require-full   # electron-builder: needs the Electron dist zip + fpm
bash scripts/ci/desktop-smoke.sh          # xvfb-run of the built binary, happy + broken load path
node scripts/gates.mjs --only=6           # clean-clone rehearsal (needs a committed tree)
```

## 12. Known gaps

- **No ESLint config exists in this repo**, so "lint" in the gate list means prettier only. Adding
  `eslint.config.js` is enough for `npm run gates` to pick it up (gate 1 enables it automatically).
- `update-channel-beta` is a plain git tag. It is not protected, and `releases/download/<tag>/…`
  assets attached to it must be re-uploaded by hand if you ever move it to a _draft_ release.
- The macOS/Windows blocks in the schema (`darwin_arm64`, `win32_x64`) exist for the _contract_ only;
  no job builds them, and no signing/notarization is configured. `verify-packaging` never expects them.
- The manifest is unsigned. Clients trust `sha256` + `https` from GitHub; a compromise of the release
  assets is not mitigated (no minisign/Ed25519). If that matters, extend the schema with
  `signature` and verify in `shared/update-manifest.ts` — the type already rejects unknown fields, so
  the schema change is a deliberate edit, not an accident.
- ~~`public/kicklive-icon.png` is 2.34 MiB and is served on first paint~~ — fixed in Phase 4: the masters
  stay (they are `branding.mjs`'s inputs) and nothing a browser loads references them any more; the sizes the
  UI draws are derived by `npm run brand:assets` into `public/brand/`, gated by `brand:assets:check` in
  gate 5. `branding check` now distinguishes "heavy and referenced" from "heavy and unreferenced" rather than
  inferring it from size, and the two remaining facts it reports are that 5.5 MB of master artwork still
  ships inside `public/` (moving it out is a packaging decision, recorded in `docs/PHASE4_DATA_ARCHITECTURE.md`
  §7.3) and that WebP/AVIF were unavailable in a pure-JS sandbox.
- The stale root `repomix-output.xml` and the `.replit` duplicate of the Supabase pair were deleted and
  gitignored on 2026-09-13; nothing in this pipeline ever read them, which is exactly why they drifted.

## 13. Run summary as measured locally (2026-09-09, node v22.22.3, linux/x64)

`node scripts/gates.mjs` — 19 pass, 0 fail, 4 skip in 52.2 s:

| gate | check                                                        | status | note                                                                 |
| ---- | ------------------------------------------------------------ | ------ | -------------------------------------------------------------------- |
| 1    | typecheck (web+shared) / (scripts+server+desktop)            | pass   | tsc -p tsconfig.json, tsconfig.node.json                             |
| 1    | unit tests / integration tests                               | pass   | 152 + 54 tests, 0 failures                                           |
| 1    | format (prettier)                                            | pass   | `.prettierrc` printWidth 200; pre-existing app code is ignored       |
| 1    | lint (eslint)                                                | skip   | no eslint config in the repo                                         |
| 2    | build:renderer / build:web / build:desktop                   | pass   | `dist/web` 7.5 MB, `renderer/dist` 7.5 MB, `build/electron` 88 KB    |
| 2    | verify:packaging tier A                                      | pass   | 45 checks, incl. synthetic asar via `@electron/asar`                 |
| 2    | verify:packaging tier B/C                                    | skip   | no `.deb` here: needs the Electron dist zip + fpm (CI `desktop` job) |
| 3    | xvfb smoke of the built binary                               | skip   | electron runtime not downloadable in this sandbox (CI `desktop` job) |
| 4    | update contract tests + manifest schema (both samples)       | pass   | policy, prompt latch, snooze, checksum refusal, ladder, MIME         |
| 5    | branding check, version lockstep, `verify` (17), idempotence | pass   | 11 generated files byte-identical after `write`                      |
| 6    | clean clone → `npm ci` → `build:web` → serve                 | skip   | needs a committed tree; ran for real after the release commit        |

Sizes above are from local `dist/`/`build/` output, **not** from a CI run; there were no CI runs to
measure (see `§0`: the token cannot write `.github/workflows`, and the Actions API 403s), so no
`gh run` URLs exist yet and the numbers for `.deb`/`.AppImage` sizes are not known.

### 13.1 Added to gate 1 by Phase 1 (and one correction to the table above)

| gate | check                                         | why it exists                                                                                                                                |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | typecheck (workers skeleton)                  | `tsc -p tsconfig.workers.json` — `workers/` is code, so it typechecks or the gate fails                                                      |
| 1    | no hardcoded backend config in shipped source | `node scripts/check-secrets.mjs --scan-only`; planted-probe covered by `tests/unit/phase1-security.test.ts`                                  |
| 1    | unit tests                                    | 179 now: the Phase 1 file pins the security invariants (config resolution, capability matrix, no client role writes, additive migration SQL) |

The `format (prettier)` row above is a correction, not an addition: the step ran
`npx --no prettier --check .`, and `npx` does not treat `--no <bin>` as "use the local package" — it
resolved something else, printed binary junk from `public/*.png`, and exited 0. **That step was a false
pass for the whole of Phase 0.** Gate 1 now invokes `node_modules/prettier/bin/prettier.cjs` directly,
which immediately found three real formatting defects. `scripts/package-linux.mjs` still calls
electron-builder through the same `npx --no` form: left alone deliberately, because packaging cannot be
exercised in this sandbox and its result is post-verified by artifact existence — fix it in a branch
where CI can prove the `.deb` still comes out. The same class of bug (a gate that passes by running
nothing) is what `§12`'s "no tests found is a hard failure" rule exists to catch; the prettier step
slipped through it because prettier _did_ run, on the wrong input.

## 14. Troubleshooting

| symptom                                                | first thing to look at                                                                                                                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| window paints the diagnostic page                      | `~/.config/kicklive/logs/main-YYYYMMDD.log`, grep `[kicklive:renderer]`; `EXHAUSTED` means both sources failed → check `asarUnpack` and `renderer/dist` in the asar: `npx asar list release/linux-unpacked/resources/app.asar \| head` |
| "Failed to load module script" in the renderer console | the asset was served without a JS MIME type — `curl -sI …/assets/x.js \| grep -i content-type`                                                                                                                                         |
| deep link 404s on the deployed web build               | host-level SPA fallback missing (`public/functions/[[catchall]].js` + `_routes.json` are the contract; a different host needs the same dotted-path exclusion)                                                                          |
| `dpkg -i` fails with "unmet dependencies"              | t64 renames: compare `dpkg-deb -f release/kicklive_*.deb Depends` with `packaging/../electron-builder.yml`                                                                                                                             |
| `dpkg -i` warns about `chrome-sandbox`                 | the setuid helper: after-install only sets it when unprivileged userns is unavailable; run `unshare --user true` to see which branch you are in                                                                                        |
| header control stuck on `unknown`                      | feed unreachable or misconfigured: `curl -fsSL <manifest-url>`; `data-feed-configured="false"` in the DOM means the URL never got resolved                                                                                             |
| an update prompts after a rollback                     | expected once per app open; snooze it or publish a manifest whose version equals the installed one                                                                                                                                     |
| `npm run ci:check` fails after editing a workflow      | you edited `.github/workflows/…` instead of `ci/workflows/…`; or run `npm run ci:install` and commit that copy                                                                                                                         |
