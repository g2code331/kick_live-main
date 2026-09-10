# Phase 6 — Media on R2: architecture, decisions and status

Written alongside the code it describes. Every claim below is one of four things, and each is labelled:

| Label                     | Meaning                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IMPLEMENTED**           | The code exists in this repo and a test in `tests/unit/phase6-media.test.ts` or `tests/integration/media-upload.test.ts` exercises it.                                 |
| **CONFIGURED**            | The configuration is written in this repo (`workers/wrangler.toml`, the migration file) — but it has not been applied to a Cloudflare account or a database from here. |
| **REQUIRES MANUAL SETUP** | Real infrastructure or a decision only the operator can make. Nothing here works until these are done; §16 is the checklist.                                           |
| **NOT YET IMPLEMENTED**   | Deliberately absent, with the reason stated. Not a promise, a gap.                                                                                                     |

Two sentences of context that shape everything else. This project's media has so far been _URL columns_ — eight `*_url` TEXT columns on six tables, one of which (`media.image_url`) was written by a browser-side `supabase.storage.from('media').upload()` in `MediaPublisher.tsx`. There is no image pipeline, no CDN configuration in this repo, and no test that could have told us a bucket policy changed. So Phase 6 was built as a **registry plus a governed write path**, not as a storage client: the URL columns stay, and R2 sits behind the Worker.

---

## 1. What exists today, and what was reused rather than rebuilt

The audit before writing anything (the same discipline as Phases 4 and 5):

| Found                                                                                                        | State before this phase                                                                                                                                                                                                                            | What Phase 6 does with it                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/pages/portals/shared/MediaPublisher.tsx`                                                                | The one real upload path in the app: browser → `supabase.storage.from('media').upload()`, then `getPublicUrl()`, then the URL into `media.image_url`. No progress, no cancel, no dedupe, no registry row. Key `articles/<timestamp>-<random>.png`. | **Rewired**, not replaced: same modal, same layout and classes, now `POST /api/media/uploads` with progress, cancel and retry. The upload runs _after_ the article insert (see §12).                                                                                           |
| `teams.gallery` (jsonb)                                                                                      | Items are `{url, caption}` pasted as external URLs by `TeamOwnerPortal`'s gallery tab. No storage write happens on this path today.                                                                                                                | Left alone. `assetUrl()` resolves an item if it ever holds a managed path, so the day a gallery upload is added it needs no migration.                                                                                                                                         |
| `media.video_url`, `match_events.video_url`                                                                  | Plain URL strings, external links (YouTube etc.).                                                                                                                                                                                                  | Left alone, and R2 stores no video — §6.                                                                                                                                                                                                                                       |
| `profiles.avatar_url`, `players.photo_url`, `teams.logo_url`, `competitions.logo_url`, `team_news.image_url` | Columns exist and are readable. `avatar_url` is selected into the auth profile by `src/contexts/AuthContext.tsx` and **rendered nowhere**; the others are rendered by five components with inline unsplash/placeholder fallbacks.                  | The columns keep their meaning and now also accept `/api/media/assets/<key>`. The five render sites were wrapped in `assetUrl()`. No avatar component exists to wrap, so `users` uploads are accepted by the API with no UI — stated as a gap in §17 rather than papered over. |
| `workers/src/router.ts`                                                                                      | Two declared-but-unbuilt stubs: `POST /uploads/sign` and `GET /uploads/:key`, marked `phase: 4`, both answering 501.                                                                                                                               | **Deleted** and replaced by the nine `/media/*` routes. The signed-upload design is retired, and §3 says why rather than pretending it never was.                                                                                                                              |
| `workers/wrangler.toml`                                                                                      | R2 listed under "PLANNED BINDINGS — deliberately inactive", with the reason: a binding with no code behind it is config theatre.                                                                                                                   | The note now points at the real binding. R2 became active when the code that needs it landed, not before.                                                                                                                                                                      |
| `scripts/check-secrets.mjs`                                                                                  | Detects a hardcoded Supabase URL and any JWT-shaped literal.                                                                                                                                                                                       | Extended with the credential shapes this phase makes plausible: a PEM private key, a service-account JSON, a Supabase PAT, an AWS key id, a legacy FCM server key (§15).                                                                                                       |

Nothing was deleted that was in use. `src/lib/MatchAutomation.ts` (dead in Phase 5) is still dead and still present — its removal is listed in §17 with the reason it did not happen here.

## 2. The one security property that decided the design: no media credential exists

**IMPLEMENTED.** The Worker reaches the bucket through a **binding** (`[[r2_buckets]]` → `env.MEDIA_BUCKET`), never through an access key. That choice is the load-bearing one of the whole phase, because of what it removes:

- there is no `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` to store, rotate, leak into a log, or bake into an artifact;
- a leaked binding is not a credential at all: it only resolves to the one bucket, only from inside this Worker, and it cannot list the account's other buckets;
- `scripts/check-secrets.mjs` gained a rule that fails the build on an AWS key id **and a comment saying that if `MEDIA_ACCESS_KEY` ever appears in this list, the design was abandoned** — the failure mode this phase exists to avoid is a future contributor adding the s3 client "because the presigned flow needs it".

The bucket is also not public-read at the CDN tier in the sense that matters: it is not "public" via an `*.r2.dev` domain (that domain is rate-limited, is not custom-domain capable, and would bypass every visibility rule in §9). All reads go through `GET /api/media/assets/*`.

**CONFIGURED.** `MEDIA_BUCKET` is bound once per environment with three distinct bucket names (`kicklive-media-dev`, `kicklive-media-staging`, `kicklive-media`). Distinct is not cosmetic: `wrangler dev` on a laptop uses the dev bucket, so an experiment can never overwrite a production crest. A shared bucket is a shared outage.

## 3. Why the Worker is in the write path (and why presigned uploads were dropped)

`POST /uploads/sign` was the plan in `docs/PRODUCTION_ARCHITECTURE.md` §"media plane": hand the browser a short-lived R2 PUT with size and MIME bounds. It is a good pattern in general, and it is wrong here, for one reason: **the bounds live in the signature, and the signature is in the client's hands.**

A presigned PUT gives you:

- no registry row, so an object exists with no owner, no version, and no way to answer "who stored this";
- no quota, because the only counter available is bytes the client _declares_;
- no dedupe, so the same crest uploaded forty times is forty objects;
- no format check, so the object is in the bucket before anything sniffs it;
- and no "publish or don't", because the browser writes to its own chosen key and then separately updates the entity row — the two-step that leaves a page pointing at an object a failed request never wrote.

The cost of going through the Worker instead is one extra request per upload and roughly 25 MB of in-flight buffering at the platform limit. In exchange the database chooses the key, the version and the visibility; ownership is decided before a byte moves; and the entity's URL is written by the same function that marks the object ready, in the same transaction. For images that a club uploads once a season, that is the right trade. If a future requirement is "4 GB video from a supporter's phone", the answer is a **resumable/TUS endpoint**, not presigned PUTs, and §17 says so.

## 4. Storage layout: keys, prefixes and what is not addressable

**IMPLEMENTED.** One key shape, assembled by exactly one function on each side of the wire (`public.kicklive_asset_object_key` in SQL, `buildObjectKey` in `workers/src/lib/mediaPolicy.ts` — the two are asserted equal by a test):

```
<entity-kind>/<entity-id>/<variant>/v<version>-<hash8>.<ext>
news/431/original/v3-9f2c1a4d.png
teams/7/original/v1-11111111.png
users/3f2b7a10-9d1e-4f5a-8b6c-1d2e3f4a5b6c/original/v2-abcdef01.jpg
```

The eight legal prefixes are the eight entity kinds: `teams/`, `players/`, `competitions/`, `seasons/`, `news/`, `team_news/`, `matches/`, `users/`. `sponsors/` and `advertisements/` are documented as **reserved** — they are deliberately absent from the database's `entity_kind` CHECK, because a CHECK that permits a kind nothing can authorize is how orphaned objects get made. Phase 7 adds them alongside its own tables with one `alter table … add constraint`.

Rules that follow from the shape:

- **A client never names a key.** It names a `kind` and an `entityId`, and the registry answers with the key. `../` cannot be a kind, and `entityId` must match `[0-9a-fA-F-]{1,64}` — so the traversal vector is not filtered, it is unconstructible (§14).
- **The version is in the key**, which is what makes the cache policy in §10 honest: no two versions ever share a key.
- **The content hash is in the key**, so "the same bytes again" resolves to the same key, which is the dedupe in §12.
- `variant` exists in the schema and the key space (`thumbnail/`, `og/`) and `kicklive_reserve_asset_upload` refuses anything but `original` with `VARIANT_UNSUPPORTED`. Accepting a client-supplied variant now would let a browser claim a slot nothing can fill; derived variants are written by a producer, and that producer is §17's open item.

## 5. What lives in the database versus in object storage

| Question                                             | Answer lives in                                                          | Why                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Does this object exist, and may this session see it? | Postgres (`media_assets.status`, `.visibility`)                          | It is a permission decision, and permissions that are enforced by convention are not enforced.                              |
| Who stored it, for which entity, which version?      | Postgres                                                                 | Audit and restore both read this.                                                                                           |
| Bytes, content type, ETag, range requests            | R2                                                                       | Object storage's whole job.                                                                                                 |
| Width, height, byte size, SHA-256                    | Postgres, written by the Worker after sniffing and hashing               | These are the fields a page needs _without_ fetching the object (layout) and the fields an integrity check needs (see §11). |
| What is the current version for team 7's crest?      | `teams.logo_url` — holding `/api/media/assets/teams/7/original/v3-….png` | Deliberate, and explained next.                                                                                             |
| Cache policy for an object                           | `workers/src/lib/mediaPolicy.ts#cacheControlFor`                         | An HTTP header is a transport decision; there is one owner, and `GET /media/config` quotes the same table.                  |

`media_assets` columns: `entity_kind`, `entity_id`, `bucket`, `object_key` (unique), `variant`, `version`, `content_type`, `byte_size`, `width`, `height`, `sha256`, `etag`, `visibility`, `status`, `alt_text`, `source_url`, `error`, `created_by`, and one timestamp per transition (`created_at`, `updated_at`, `ready_at`, `superseded_at`, `deleted_at`). `media_operations` is insert-only: `reserve`, `finalize`, `failed`, `soft_delete`, `restore`, `purge`, `retention_sweep`, `migration_run`, `migration_attach`, `reconcile`.

`entity_id` is TEXT, and that is a real trade-off worth stating: `teams.id` is a serial integer and `profiles.id` is a uuid, so a polymorphic reference cannot be a foreign key. Referential integrity is instead enforced by the per-kind authorization queries (which all `join`/`exists` against the real row) and by the reconciliation function. The alternative — six nullable FK columns — is not more honest and is much harder to read.

**The URL columns are still the render path.** This is the most consequential decision in the phase, and it was made for the reason Phase 1's doctrine states: do not break what works. ~35 read sites read `logo_url`/`image_url`/`photo_url` today, and some rows hold legacy `https://<ref>.supabase.co/storage/v1/object/public/media/…` URLs while others hold unsplash links. A `media_assets` join on every read would have to reproduce all three behaviours anyway. So:

- new rows write the _relative path_ `/api/media/assets/<key>` into the same column;
- `assetUrl()` (`src/lib/media/assets.ts`) makes it absolute at render time using the same `VITE_API_BASE_URL` as the API client, and passes through anything that is not our prefix;
- a legacy absolute URL is therefore still valid forever, and **storing a relative path is what makes an environment change harmless**: copy a staging row into production and no URL has to be rewritten, because no host is baked into the data.

## 6. The kinds, and what each one is for

`mediaPolicy.ts` and `kicklive_asset_url_column` hold the table; both sides are asserted equal in a test.

| Prefix          | Table          | URL column   | Cap   | Uploadable by a browser | Notes                                                              |
| --------------- | -------------- | ------------ | ----- | ----------------------- | ------------------------------------------------------------------ |
| `teams/`        | `teams`        | `logo_url`   | 5 MB  | yes                     | Crest. Owner is `teams.owner_id`, in SQL.                          |
| `players/`      | `players`      | `photo_url`  | 8 MB  | yes                     | Authorized through the player's club, not through the player.      |
| `competitions/` | `competitions` | `logo_url`   | 5 MB  | yes                     | Staff kind: an upload here is a write to competition-wide content. |
| `seasons/`      | `seasons`      | —            | 5 MB  | no                      | Registry only: `seasons` has no image column today.                |
| `news/`         | `media`        | `image_url`  | 10 MB | yes                     | `media.author_id`, `media` role or admin.                          |
| `team_news/`    | `team_news`    | `image_url`  | 10 MB | yes                     | Authorized through the item's club.                                |
| `matches/`      | `matches`      | —            | 10 MB | no                      | Match media is external links (below).                             |
| `users/`        | `profiles`     | `avatar_url` | 5 MB  | yes                     | `entityId` must be `auth.uid()` — see §9 for why this is _public_. |

**Video: no, and not "not yet".** `media.video_url` and `match_events.video_url` keep holding external links, and the accepted upload types are the four image formats. The reasons, in the order they bite:

1. A 45 MB file turns one upload into a multi-minute synchronous Worker request, and a request that long cannot be made reliable by retrying it;
2. R2 stores the bytes but does not transcode them, and an untranscoded MP4 has no poster frame, no adaptive bitrate and no scrub thumbnails, so the app would have to build all three;
3. YouTube already does all of that for free, and the app already embeds its player.

So storing video would cost egress and complexity and buy a worse player. If this ever changes, the shape is a **separate long-running path** (a `TUS`/multipart resumable upload plus a Stream or Mux transcode dependency), and the registry as designed already accommodates it: `content_type`, `variant` and `status` need no new columns.

## 7. Uploads: the pipeline, in order

```
browser ──POST /api/media/uploads (multipart: file, kind, entityId, alt?) ──▶ Worker
   1. declared size ≤ category cap            (else 413, nothing else runs)
   2. read the bytes; sniff the first block    (else 400 UNSUPPORTED_TYPE / MARKUP_REJECTED)
   3. SHA-256 over the bytes actually read
   4. SELECT kicklive_reserve_asset_upload(...)     ← authorization, quota, dedupe, version, key
   5. media.put(key, bytes, {content-type: sniffed, cache-control: immutable, webSha256})
   6. media.head(key) → size and etag confirm
   7. SELECT kicklive_finalize_asset_upload(id, 'stored', etag, size)  ← publishes: supersedes the old
                                                                                          version and moves
   8. 201 { url, assetId, objectKey, version, bytes, width, height }      the entity's URL column
```

Three properties this order buys, each of which is a test:

- **Nothing is published before it is verified.** The entity row is touched at step 7 and at no earlier point. A refusal at steps 1–3 never reaches the database; a failure at step 5 or 6 closes the reservation as `failed` and leaves the entity's existing image exactly where it was. There is no half-published state to roll back, because there is no window in which one could exist.
- **A retry is safe.** Step 4 is idempotent twice over: the same bytes in the same slot resolve to the same key (→ `skip_upload`, no write), and `kicklive_finalize_asset_upload` on an already-`ready` row returns that row with `idempotent: true` instead of creating a second current version.
- **The size the client claimed is checked against the size the bucket reports** (step 6, and again in SQL as `SIZE_MISMATCH`). A mismatch means the bytes were swapped between sniffing and writing — which is precisely when a quota stops meaning anything — so it is a failure, not a warning.

`webSha256` in the `put` options makes R2 itself reject a write whose bytes do not match the digest the Worker computed, so the integrity check is not only ours.

## 8. The format check, and what it refuses

**IMPLEMENTED** in `workers/src/lib/imageProbe.ts` (no dependency; it reads headers, never pixels).

| Input                                                                       | Outcome                                     | Why it is refused rather than stored                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body starts with `<svg`, `<!doctype`, `<html`, `<?xml`                      | 400 `MARKUP_REJECTED`                       | An SVG is a document that can carry a script, and assets are served from the app's own origin. "Handle SVG carefully" in practice means a sanitiser plus `Content-Disposition` plus a separate origin; refusing it is a decision that cannot be misconfigured later. |
| PNG/JPEG/WebP/GIF magic bytes, **whatever** `Content-Type` or filename said | accepted, stored under the **sniffed** type | A declared type is an opinion. Storing a client's `content_type` is how a stored file becomes a served file with a browser-sniffable type.                                                                                                                           |
| Anything else (a zip, an ico, a plain text file named `.png`)               | 400 `UNSUPPORTED_TYPE`                      | Not in the allowlist of four.                                                                                                                                                                                                                                        |
| Truncated JPEG (`FF D8` and nothing else)                                   | 400 `DIMENSIONS_UNAVAILABLE`                | The type is right but the file is broken; "save it again" is the actionable answer, and a stored file nothing can size is a layout bug on every page that renders it.                                                                                                |
| Declared dimensions above 8192 on a side, or above 40 megapixels            | 400 `TOO_MANY_PIXELS`                       | A 1×1 file may _declare_ 100000×100000. The decode happens in the visitor's browser, so the only defence is at write time.                                                                                                                                           |
| `byte_size` above the per-kind cap, or above 25 MB at all                   | 413 `TOO_LARGE`                             | Checked before hashing (cheap for us, and the error names the user's own file rather than a server-side limit); the DB repeats it as a CHECK.                                                                                                                        |

The four accepted types are also the four the app can display everywhere including a PWA on a 2014 Android browser, which is the actual product constraint: PNG for crests with transparency, JPEG/WebP for photos, GIF only because the legacy data already contains some.

## 9. Public and private: how they are separated, and what `private` costs

**IMPLEMENTED**, with one decision that needs stating rather than hiding:

**Every kind this app has today is public.** The reason is a browser fact, not a judgement about privacy: an `<img>` tag sends no `Authorization` header, so an object that is only fetchable with a token cannot be a logo, an avatar or a news photo at all. `kicklive_asset_visibility` returns `'public'` for all eight kinds and says so in a comment.

`profiles.avatar_url` is the closest call and is still public, because the app renders a profile picture next to a public username for anonymous fans — marking the object private would hide a URL from nobody and break the image for everybody.

What is nevertheless built and tested, for the first kind that genuinely cannot be shown to the world (a verification document, a contract scan):

- the read route requires a session for `visibility = 'private'` and then asks **Postgres** (`kicklive_asset_authorized`, evaluated against `auth.uid()`) rather than trusting a Worker-side comparison;
- private responses are `cache-control: private, no-store` — `no-store` rather than `private` because the bytes behind a key may have been replaced since the last load;
- private objects are forgotten 30 days after creation regardless of status, while public ones live until superseded;
- a private object cannot be rendered by `src=`, so a caller must fetch it with a token into an object URL. That is the one line a future avatar-privacy change would have to add to the UI, and it is why the flag is off today rather than "on but unenforced".

Anything not in the registry is a 404, so a leaked key is never a second authentication factor: guessing `news/431/original/v3-9f2c1a4d.png` gets you nothing that `status` does not already permit.

## 10. Reads and caching

**IMPLEMENTED.** `GET /api/media/assets/<key>` is a Worker read-through: it asks the registry (`kicklive_asset_for_key`, which answers only for `ready` and `superseded` rows), fetches the object from the bucket, and returns it with the headers below. A `HEAD` is not special-cased — the platform answers it from the same handler.

| Response                | `cache-control`                                     | Reasoning                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public, versioned key   | `public, max-age=31536000, immutable`               | The key embeds the version _and_ the content hash, so the bytes at that key can never change. This is the whole reason replacement is safe: a new crest is a new key, so no CDN purge and no stale logo is possible. |
| public, unversioned key | `public, max-age=300, stale-while-revalidate=86400` | Only the migration path ever produces these; short-lived, so a key reused outside the rules cannot outlive five minutes of staleness.                                                                                |
| private                 | `private, no-store`                                 | §9.                                                                                                                                                                                                                  |
| error                   | `no-store`                                          | A 404 for an object that is mid-publish must not be cached by a shared cache and served for an hour.                                                                                                                 |

Plus `etag` (from R2, so conditional requests work without reading the object), `accept-ranges: bytes` with real `206`/`content-range` support (a player and a large image both need it), `last-modified` on immutable responses so a shared cache has something to reason about, and `x-asset-visibility` (a debugging affordance: it says only what the key already implies).

`CacheClass` gained a fourth value, `"handler"`. Without it the entry point's `finalise` would overwrite every media response's `cache-control` with `no-store`, because the route table's classes are static and an object's policy is per-object. `finalise` still forces `no-store` when a `handler` route _forgets_ to set a header, so the new class cannot become an excuse for an uncached-by-accident or cached-by-accident response. `tests/unit/phase2-api-boundary.test.ts` and the media tests both pin this.

**Not done, on purpose: image resizing on read.** `docs/PRODUCTION_ARCHITECTURE.md` once imagined "R2 read-through with image resizing". Resizing needs a CPU-heavy dependency (or an Images product entanglement) inside a Worker, and the cheaper answer is what the registry does instead: store the source, and let the client ask for the size it wants via `srcset` with a _derived variant key_ once a producer exists to write it (§17). A crop-on-read endpoint would put an unbounded transform behind a public URL, which is a denial-of-service invitation with a nice interface.

## 11. Quotas, limits and rate control

Three layers, because they protect three different things:

| Layer                | Rule                                                                                                              | Enforced in                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Per file             | `MEDIA_CATEGORIES[kind].maxBytes` (5–10 MB per kind), global ceiling `MEDIA_MAX_BYTES` = 26214400                 | Worker (before hashing) **and** a DB CHECK on `byte_size` |
| Per account per 24 h | `kicklive_upload_quota_bytes(role)`: media 256 MB, team_manager 128 MB, referee 32 MB, fan 16 MB, admin unlimited | SQL, inside the reservation                               |
| Per route            | `POST /media/uploads` is `mutation` (60/min), reads are `public` (600/min), the migration is `admin-blast`        | `middleware/ratelimit.ts`, from the route table           |

Why the daily quota is per _account_ rather than per IP: the abuse that matters is one determined club filling the bucket, and an IP quota would only inconvenience a stadium. The quota counts bytes the account has _stored_ in the window, including superseded and soft-deleted rows, deliberately: "bytes I can still get back" is the resource, and counting only `ready` rows would let an attacker store and delete in a loop.

Why a quota refusal answers **429** and a rejected file answers 400/413: a client that sees 5xx retries, and retrying a file that will never be accepted is a self-inflicted outage. `refusalMessage()` in `routes/media.ts` names the allowance in the message for the same reason.

Admin is unlimited because "admin" here is one person with a checklist, and a quota that trips during a tournament import is a support call, not a protection.

## 12. Idempotency, versions, replacement and restore

`kicklive_reserve_asset_upload` answers `skip_upload` when the bytes are already there twice over: same `object_key` (kind + entity + variant + version + hash8 + ext), or same `(entity_kind, entity_id, variant, sha256)` in a `ready` row. Either way nothing is written, the reservation is closed with `existing`, and the response says `reused: true` — worth surfacing to a user who re-picked the same file and deserves to know the second attempt cost nothing.

Replacement: `create unique index media_assets_one_ready_per_slot_idx on (entity_kind, entity_id, variant) where status = 'ready'` — **at most one current version per slot**, and `finalize` supersedes the previous occupant _before_ flipping the new one, so the index is what makes "concurrent uploads for the same crest" fail loudly rather than silently keeping whichever object landed last.

The superseded object is not deleted, and stays readable at its old key forever (immutable by construction). That is what makes these safe without any coordination: an article published last week still shows the image it was published with; a push payload's link still resolves. `kicklive_restore_asset` puts an old version back as the current one (superseding whatever took the slot), and it is exposed as `POST /api/media/assets/:id/restore` so "undo that" is a button rather than a SQL session.

Delete semantics, because Step 15 asked how deletion avoids becoming irreversible:

| Call                       | Row                                        | Object                                          | Entity column                           |
| -------------------------- | ------------------------------------------ | ----------------------------------------------- | --------------------------------------- |
| `DELETE /media/assets/:id` | `status='deleted'`                         | untouched                                       | cleared if this was the current version |
| `?purge=true` (admin only) | `status='purged'`, key and digest retained | deleted by the Worker **after** the row says so | cleared                                 |
| neither (default, 30 days) | restorable                                 | restorable                                      | —                                       |

Order on purge is deliberate: marking first means a failed object delete leaves a _reportable orphan_ (bucket has bytes the registry says are gone → `reconcile` names the key), whereas deleting first leaves a row claiming bytes that are still there and a broken image nobody can explain. Nothing in SQL deletes an object, and nothing in this phase deletes a row: `purged` is a status, not a `delete`.

The "entity created after the upload" case (Step 19's ordering question) is answered by inverting the old flow rather than adding a cleanup job: `MediaPublisher` now inserts the article first and uploads second, against the id it just got. A publisher who closes the tab mid-upload leaves an article with no image (editable, harmless) instead of an orphan in the bucket with no owner. If the upload fails, the article is published and the modal says so and offers Retry — a half-finished task, not a failed one, and the retry re-attempts the upload without creating a second article.

## 13. Migration from Supabase Storage

**IMPLEMENTED in code; REQUIRES MANUAL SETUP to run** (§16). The plan's rule was "migrate only what is referenced, with a rollback path", and that is what `POST /api/media/migration` does — one entity kind per run, because a first pass that copies everything is a pass nobody runs twice.

For one table, in bounded pages (`gt(id, after) order by id limit 200`, ≤ 64 MB and ≤ 200 objects per run):

1. select `id, <url column>`; keep only rows whose value parses as `https://<SUPABASE_PROJECT_REF>.supabase.co/storage/v1/object/{public,sign}/{media,avatars}/…`. **External links are skipped permanently by that same host check** — unsplash placeholders and YouTube links were never ours to copy, and a migration that "normalises" them breaks them;
2. `kicklive_migration_seen(source_url)` — one cheap lookup, so a re-run does not re-download anything. A row recorded as `failed` is _not_ an answer, which is what makes re-running the recovery step;
3. fetch (unauthenticated: only a public object is fetchable, and a private legacy object is recorded `skipped SOURCE_NOT_PUBLIC` rather than being fetched with a key the Worker will not hold for this);
4. size check, sniff, hash. A non-image becomes `skipped NOT_AN_ACCEPTED_IMAGE` — the legacy bucket can contain anything, and a migration must not be the thing that finally stores an SVG;
5. `put` to the same key space an upload would use (`<kind>/<id>/original/v1-<hash8>.<ext>`), then `kicklive_record_migrated_asset`, which is idempotent on `source_url` and **attaches the entity URL only for a successful copy**;
6. report `{scanned, migrated, skipped, failed, bytesCopied, nextCursor, hasMore, details[]}`.

**Rollback** is a `source_url` lookup, not a restore from backup: every migrated row remembers the exact legacy URL it came from, the legacy object is never deleted by this phase, and the entity column can be set back to it per row (or in bulk from `media_operations`, which recorded `migration_attach` with `{from, to}`). The reverse direction is not automated, because a rollback that runs by itself is how a half-migrated state becomes a permanent one.

What is **not** migrated: `teams.gallery` items (pasted external URLs, not storage objects), `media.video_url` and `match_events.video_url` (external links), and any object in a legacy bucket other than `media`/`avatars`. The migration is also not a one-time data-center move: the URL columns accept external values indefinitely, so a row that never migrated still renders.

`GET /api/media/diagnostics` reports `still_url_pointing_at_storage` per table, which is how "finished" is defined for this section: that count reaching zero, per kind, is the exit criterion.

## 14. Security: the threat model for a media system, and what is actually enforced

| Attack                                                                              | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Where                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Path traversal / key manipulation (`entityId=../../etc/passwd`, `kind=sponsors/..`) | Not constructible: `kind` must be one of eight literals and `entityId` must match `[0-9a-fA-F-]{1,64}`, and the key is assembled by the database from those two components. The read path then applies `isSafeObjectKey` — the database's character set, plus the two things only a _path_ cares about: no dot-segment and no empty segment, because a key is an opaque bucket name but the same string is also a URL tail that proxies and `new URL()` normalise. | `mediaPolicy.ts`, `kicklive_asset_object_key`, `capturedObjectKey` |
| MIME spoof / polyglot                                                               | §8: type comes from bytes, markup is refused before the format table is consulted                                                                                                                                                                                                                                                                                                                                                                                  | `imageProbe.ts`                                                    |
| Stored XSS via SVG                                                                  | SVG is not an accepted type, at any size, for any role                                                                                                                                                                                                                                                                                                                                                                                                             | `ACCEPTED_TYPES`                                                   |
| Unauthenticated write                                                               | The route table requires `profile.read_own`, which the coarse gate turns into 401 before the handler runs; no media write route is reachable anonymously                                                                                                                                                                                                                                                                                                           | `router.ts`                                                        |
| Privilege escalation via upload (a fan writing a competition logo)                  | Per-kind row predicates in `kicklive_reserve_asset_upload`: `can_manage_team(…)` for `teams`/`players`/`team_news`, `media.author_id = auth.uid()` or `is_admin_or_media()` for `news`, `entity_id = auth.uid()` for `users`, `is_admin_or_media()` for the staff kinds. The browser never declares a permission; the capability names "signed in" and the SQL decides.                                                                                            | the migration                                                      |
| Client-chosen identity (`entityId` = another user's uuid for an avatar)             | `NOT_SELF`: `users` requires `p_entity_id = auth.uid()::text` unless admin                                                                                                                                                                                                                                                                                                                                                                                         | the migration                                                      |
| Finalizing somebody else's reservation                                              | `NOT_RESERVER`: finalize and delete both compare `created_by` to `auth.uid()` (admin excepted)                                                                                                                                                                                                                                                                                                                                                                     | the migration                                                      |
| Listing another club's drafts                                                       | `kicklive_entity_assets` applies the same ownership predicate and answers `[]` — an empty list rather than a 403 that can be probed for existence                                                                                                                                                                                                                                                                                                                  | the migration                                                      |
| Direct table access bypassing the functions                                         | `media_assets` and `media_operations` have RLS enabled, **no** policies, no grants to `anon`/`authenticated`, and `service_role` gets `select, insert` only — no `update`/`delete`, so a status transition cannot skip its bookkeeping. The verify block fails the migration if a client role ever holds a table privilege.                                                                                                                                        | the migration                                                      |
| `force row level security` theatre                                                  | Not used, same reasoning as Phase 5 §9.6: no client role has a grant, so the grant set is the enforcement and `force` would only change what a _future_ mistake costs                                                                                                                                                                                                                                                                                              | the migration                                                      |
| SSRF through the migration                                                          | One host, exactly `${SUPABASE_PROJECT_REF}.supabase.co`, https, and two bucket names. A row value cannot aim the Worker anywhere else.                                                                                                                                                                                                                                                                                                                             | `parseLegacyStorageUrl`                                            |
| Credentials in a bundle or a log                                                    | `MEDIA_BUCKET` is a binding, not a secret; `check-secrets` now catches PEM/AWS/service-account shapes; `MEDIA_MAX_BYTES` is a plain var                                                                                                                                                                                                                                                                                                                            | §2, §15                                                            |
| Error messages leaking internals                                                    | Upstream text rides in `ApiError.detail`, which is stripped in production, and the bucket's exception name is logged, not returned                                                                                                                                                                                                                                                                                                                                 | `lib/response.ts`                                                  |

Two things that are **not** protected by anything here, stated plainly: an object's bytes are only as private as this Worker's read route (if someone later binds a public `*.r2.dev` domain or a custom domain straight to the bucket, `visibility='private'` becomes a lie — the config test asserting per-environment buckets is the only tripwire, and it is a weak one); and `alt` text is stored and rendered by components this phase did not audit for injection, so it is length-capped and control-character-free at the boundary but no more sanitised than the article body already is.

## 15. Retention, orphan reconciliation, observability, and the credential hygiene that goes with them

`GET /api/media/diagnostics` (admin) returns counts only — never file contents, never a listing:

```
by_status, by_kind, total_bytes, uploading_over_1h, ready_missing_digest,
still_url_pointing_at_storage{media,team_news,teams,players,competitions,profiles},
operations_last_24h{...}, bucketBound, listed{objects, complete}, reconciliation
```

- **Stale reservations** are the leak every upload system has, so they are named in the schema: an `uploading` row older than 24 h becomes `failed` with `error='RESERVATION_EXPIRED'` — expired, not deleted, because the object may well exist and an unexplained disappearance is worse than a recorded failure.
- **Retention** (`kicklive_sweep_media`, run hourly by cron `17 * * * *` and on demand by `POST /media/sweep`): superseded and soft-deleted objects are purged after 30 days; private objects after 30 days from creation. The function returns the keys, the Worker deletes them, and the whole run is written to `media_operations`. That split — the database decides what is old enough to forget, storage decides what to delete — is why each half can be tested and reasoned about on its own.
- **Orphans** in both directions come from `kicklive_reconcile_assets(liveKeys, prefix)`: the Worker lists the bucket (bounded: 2 000 keys, and `complete: false` is reported when the listing was not exhaustive, so "we checked" is never a lie about a page and a half) and Postgres computes the set difference: objects with no row, and `ready`/`superseded` rows whose object is gone. A `purged` row does not count as missing, and a `skipped` migration row is recorded as `deleted` precisely so it is not counted as an orphan.
- **Logs** carry `requestId` (the same `x-request-id` the client receives) and, for a media action, the `assetId` and the object key. Never a bucket credential, never a signed URL, and no token material of any kind. `GET /media/diagnostics` is `no-store` so a counts snapshot cannot be served to a later visitor.

`scripts/check-secrets.mjs` now also scans `.pem|.key|.p12|.pfx` (they used to slip past the extension filter, which is where a real key actually lives) and rejects: PEM private-key headers, `"type": "service_account"`, `firebase-adminsdk-…@…` client emails, `AKIA…` AWS ids, `sbp_`/`sb_secret_` Supabase tokens, and legacy FCM server keys. Comment lines are exempt for the PEM rule — the repo's own `fcm.ts` documents the PEM format it parses — and that trade-off is written in the scanner rather than left for the next person to rediscover as a "false positive".

## 16. Manual setup, in the order that works

Nothing in §2–§15 reaches a bucket or a database until these are done. They are the phase's blockers, and none of them can be done from this repo.

1. `npx wrangler r2 bucket create kicklive-media-dev` (then `-staging`, then production `kicklive-media`) — three buckets, one per environment.
2. Apply `supabase/migrations/20260912120000_phase6_r2_media.sql` to staging first. Its `$verify$` block raises rather than committing, so a half-applied media schema is not a state this migration can leave behind. Then `notify pgrst` reloads the schema.
3. `npx wrangler deploy` per environment. A deploy where the bucket is missing produces 503 `This deployment has no media bucket bound (MEDIA_BUCKET)`, which is the intended failure, not a bug.
4. Confirm the read path is _not_ a public bucket domain: nothing should be able to fetch `https://pub-<hash>.r2.dev/teams/7/…`. If a custom domain is later put in front of the bucket, §9's private rule stops being true and this line becomes a security finding.
5. Run `POST /api/media/migration?entityKind=teams&dryRun=true`, read the counts, then the same call with `dryRun=false`, and repeat per kind until `still_url_pointing_at_storage` is zero for that kind.
6. Decide, before any user-facing avatar feature, whether the `users` prefix stays public (§9's reasoning) — that decision is cheaper now than after avatars are live.
7. Optional: a `kicklive-media` lifecycle rule (e.g. transition `superseded`/`deleted`-stage objects to cold storage). Nothing in this phase depends on it: the registry, not the bucket's lifecycle, decides when an object is forgotten, and that is what makes retention testable.

## 17. What is deliberately not done here

| Item                                     | Status                                          | Why it is not in Phase 6                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thumbnail / `og:` variants               | **NOT YET IMPLEMENTED**                         | Needs a producer (an image pipeline that writes `teams/7/thumbnail/v1-….png`). The schema, the key space and the refusal (`VARIANT_UNSUPPORTED`) are already in place so it lands without a migration.                              |
| Image resizing on read                   | **NOT YET IMPLEMENTED**                         | §10: an unbounded transform behind a public URL.                                                                                                                                                                                    |
| Video uploads                            | **NOT YET IMPLEMENTED, by decision**            | §6.                                                                                                                                                                                                                                 |
| Avatar UI (`users/` uploads)             | API **IMPLEMENTED**, UI **NOT YET IMPLEMENTED** | No component renders `avatar_url` today; the settings/profile UI work is the unfinished Phase 5 item, and inventing a second avatar widget here would be the duplicate implementation this project has been avoiding since Phase 1. |
| `src/lib/MatchAutomation.ts` deletion    | **NOT DONE**                                    | Still unreferenced from Phase 5's audit. It is a browser-side FCM sender, not media code; deleting it belongs with the settings UI that replaces its purpose.                                                                       |
| Gallery upload (`teams.gallery`)         | **NOT YET IMPLEMENTED**                         | The tab is a URL-paste form today. Making it an upload is a UI feature; the registry accepts `teams/` already, so it is a form change and nothing else.                                                                             |
| `POST /uploads/sign`                     | **DELETED**                                     | §3. A reader of `docs/PRODUCTION_ARCHITECTURE.md` will still find it described there as the plan; that document is history, this one is the present.                                                                                |
| D1 as a media cache                      | **NOT YET IMPLEMENTED**                         | It would be a second copy of the registry with an invalidation problem, and `media_assets` answers every query the app has about media in one index lookup.                                                                         |
| Advertising / sponsorship media          | **OUT OF SCOPE (Phase 7)**                      | The prefixes are reserved and the CHECK constraint is the only thing standing between Phase 7 and a schema edit — which is why they are absent rather than present-but-empty.                                                       |
| Deleting legacy Supabase Storage objects | **NOT DONE, on purpose**                        | They are the rollback path (§13). Deleting them is a separate, reviewed, post-verification step — and until then the storage account's lifecycle policy is the place to expire them, not application code.                          |

## 18. Testing

**Unit** — `tests/unit/phase6-media.test.ts`, 38 tests: the sniffing table (each accepted format, the spoof case, markup, truncation, dimension ceilings, and the digest against an independent implementation), key derivation and `isSafeObjectKey`, the cache-class rules including the `handler`/`finalise` interaction, the policy↔SQL agreement (kind CHECK, URL columns against the schema authority, per-role quotas including the ELSE branch, the byte ceiling against `MEDIA_MAX_BYTES`, the lifecycle status list), every existing column's preservation, the migration read as a document (no destructive statement, RLS posture, the exact client-grant set, `search_path` on every definer, transaction/verify/reload shape), the route table's media entries against `HANDLERS`, the retired-stub absence, the README map, the read route's registry-before-bucket ordering, the no-`supabase.storage`-in-`src/**` census, the credential census over `src`/`pwa`/`shared`, `assetUrl`'s pass-through and empty-value behaviour, this document's own section coverage, and the secret scanner against a fixture tree it builds itself (including that a `.pem` banner is not treated as a comment).

**Integration** — `tests/integration/media-upload.test.ts` drives the **real** `workers/src/index.ts` fetch handler with a `Map`-backed bucket and a fake PostgREST answering the `kicklive_*` RPCs, so route matching (including the wildcard), authentication, the capability matrix, multipart parsing, the error envelope and `finalise`'s cache handling are all in the path. The 30 scenarios are the ones a media bug report names: the happy path and its `201` payload, the sniffed-not-declared type, the markup refusal with no reservation taken, the oversize refusal before hashing, an undeclared `key` field, encoded traversal in the id and in the read path, each refusal's status (`429` quota, `403` club, `400` format) with no write in any of them, `skip_upload` storing nothing, a failed bucket write leaving the entity untouched and the reservation closed, an orphan surviving a refused publish, a 503 that names `MEDIA_BUCKET`, a 401 with no token, the immutable and no-store header pairs, `206` with the right slice, `304`, `404` for an unregistered key, private-object access for owner / stranger / anonymous, a replacement whose previous key still resolves, soft delete versus purge and their ordering, restore, the sweep's "registry first, then delete", and the migration's host allowlist plus its four outcomes.

What is **not provable from a sandbox**, and therefore not claimed: that a real R2 `put` accepts `checksums.webSha256` with the exact semantics assumed here; that a real `[[r2_buckets]]` deploy in each environment binds the bucket named in §2; that `Request.formData()` in the Cloudflare runtime behaves identically to undici's on the multipart edge cases (a part with a `filename` but no content type, an empty file part, a field appearing after the file); that the legacy bucket is in fact public so the migration can read it; and that the migration's SQL executes — the `kicklive_*` functions are validated by reading and by text tests, because there is no Postgres here. Each of those is a line in §16 or a manual check in the deployment PR, and `npx wrangler dev` against a real bucket is the first five minutes of that verification.

---

### One-paragraph summary for the release note

Media is now stored in R2 through a governed path: `POST /api/media/uploads` sniffs the bytes, asks Postgres who may write where, gets back a versioned content-addressed key, writes to the bucket with no credential involved, and publishes only after confirming the object — so an entity's image either moved completely or not at all. The eight `*_url` columns keep their meaning and now also hold relative `/api/media/assets/<key>` paths that resolve against whatever API origin the build was configured with, which is why no row needed migrating and why a legacy unsplash or storage URL still renders. Versions are never overwritten, so replacement needs no cache purge and a previous logo is one `restore` away; deletion is soft by default, purge is admin-only and never deletes the registry row; the hourly sweep expires abandoned reservations and retires objects past their window. The Supabase Storage migration is a bounded, idempotent, dry-run-by-default admin route, and diagnostics reports the one number that says whether the migration is finished. FCM, advertising and a UI redesign are untouched.
