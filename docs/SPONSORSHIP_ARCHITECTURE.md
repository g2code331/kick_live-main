# Phase 8 — Sponsorship: architecture, decisions and status

Sponsorship is **rights, not delivery**. Phase 7 answers "what should appear in this slot for this
request"; Phase 8 answers "who is entitled to appear on this competition, and until when". A sponsor
badge does not rotate, is not auctioned, and does not depend on a targeting rule — it is a contractual
placement, and the whole design below follows from that one sentence.

Status line, before anything else: the code and the migration are committed, the gates are green
**except** that this environment has no Postgres, so `scripts/check-sql.mjs` (which is where the
sponsorship flow actually _runs_) was skipped rather than passed. §15 says exactly what that means and
what to run. Read that before believing any sentence below about the SQL working.

---

## 1. What exists today, and what was reused rather than rebuilt

- **Five tables** — `sponsors`, `sponsorship_packages`, `sponsorships`, `sponsorship_status_transitions`,
  `sponsorship_config` — and **28 functions**, all in
  `supabase/migrations/20260914120000_phase8_sponsorship.sql`. Additive only: no `drop table`, no
  `delete`, no touching a column another phase owns. The migration is `create or replace` throughout and
  re-runs cleanly (`check-sql.mjs --fresh` applies it twice).
- **Phase 6's media plane** does the bytes. Sponsorship adds no bucket, no upload route, no size
  sniffing and no key rules of its own — it adds two functions that _reserve_ and _attach_ inside
  Phase 6's pipeline (§10).
- **Phase 7's URL rule** is inherited rather than re-derived (§7).
- **Phase 5's queue** is _not_ used. A sponsorship never notifies anybody, and the seam for that
  (`auto_flight`) is deliberately left as a comment rather than a half-wired job (§17).
- The frontend gets one query spec, two components and one admin screen. It gets no Supabase client, no
  second source of truth about visibility, and no sponsor names (§12).

## 2. The two planes, and why they do not merge

The temptation in a codebase that already has `advertisers`, `ad_campaigns` and `ad_placements` is to add
a `kind = 'sponsor'` to the campaign table and save a migration. It was refused, for reasons that all
show up as columns:

|                                      | advertising (Phase 7)         | sponsorship (this phase)                    |
| ------------------------------------ | ----------------------------- | ------------------------------------------- |
| decided per                          | request                       | agreement                                   |
| selection                            | rotation + targeting          | fixed order, no randomness                  |
| who pays                             | auction/day-part, counted     | contract, invoiced off-platform             |
| can a stranger influence the counter | no (HMAC viewer key, deduped) | n/a — there is no counter here              |
| failure that matters                 | a served ad nobody wanted     | a badge shown after the deal ended          |
| cache                                | must not be cached long       | one fixed projection, cacheable for minutes |

They share exactly two things, both of them explicit: the word "sponsor" in prose, and
`sponsorships.advertisement_campaign_id`, a foreign key that lets a sponsorship _optionally_ generate an
ad campaign later. No route in this phase reads or writes an ad table.

## 3. Schema, and what each part is for

- **`sponsors`** — the partner. `slug` (immutable, §6), `display_name`, `legal_name`, `description`,
  `website_url` (https, §7), a contact block (`contact_name/email/phone`, `contact_consent_at`), brand
  fields (`brand_colour` as `#rrggbb`, `on_dark`), `status` (`draft|approved|suspended|archived`),
  `approved_by`/`approved_at` (written only by the status door), the two derived
  `logo_url`/`banner_url`, the money block (`value_amount/currency/basis`, `invoice_reference`,
  `renewal_terms`, `advance_paid`, `postpaid`, `billing_period`) and `internal_notes`.
- **`sponsorship_packages`** — the rate card. Six rows seeded, each with a unique `code`, `label`,
  `kind`, `tier`, `exclusivity`, `entitlements jsonb` (closed key set, §4), `allowed_target_kinds`,
  `max_per_target`, `default_priority`, `price_*`, `sort_order`, `is_active`. Packages are _configuration_
  rather than a table per target kind, which is what makes a new kind of deal a row instead of a release.
- **`sponsorships`** — the agreement, and the interesting decision of the phase. It is keyed
  `(target_kind, target_id text)` rather than by six nullable foreign keys, and `kicklive_sponsor_target_exists`
  is what gives that pair meaning: `competition|season|team|match` must be a numeric id **and** a real row;
  `award|event` is a slug (`^[a-z0-9][a-z0-9._-]{1,63}$`) because whoever creates an award is its owner.
  One table, one set of triggers, one index, and a target kind added later costs a `case` arm in one
  function. The cost is honest and it is recorded here: `target_id` is `text`, so a bad id is refused in
  SQL rather than by a foreign key, and `scripts/sql-flow.mjs` is the thing that proves the check works.
  It also carries the display fields a _placement_ needs (`attribution`, `naming_override`,
  `logo_variant`, `background_colour`, `link_url`, `priority`, `display_order`), the per-agreement
  overrides of the two asset ids, `status`, `is_active`, and its own money block.
- **`sponsorship_status_transitions`** — the arc table, two arcs in one (`kind ∈ sponsor|sponsorship`).
  Read by the desk to decide what to offer; enforced by the trigger that refuses an arc not in it.
  `archived` is terminal, so a deleted-on-paper agreement cannot be resurrected by a lucky click.
- **`sponsorship_config`** — one row: the epoch, plus `band_max_age_seconds` and
  `band_max_entries`. Single-row config is the Phase 4 pattern, and its only job is to be small enough to
  bump inside the transaction that changed a band (§11).

No policies anywhere, on purpose, and for the Phase 7 reason: a read grant under RLS with no policy is a
door that answers zero rows and reads like an app bug. Every access goes through a function that checks
who is calling, and **no client role holds a table privilege** (asserted by a unit test, not by hope).

## 4. Eligibility: the one function that decides visibility

`kicklive_sponsorship_for(p_target_kind, p_target_id, p_limit)` is the only public read, and it is the
only thing in the system that decides whether a sponsor is visible. A sponsor appears when all of these
hold in one query:

1. `sponsorships.is_active` **and** `status = 'active'` — the switch and the paperwork, deliberately two
   columns (§8 of the desk's UX: "hide it this fortnight" is not "this is over");
2. `sponsors.status = 'approved'` and not suspended;
3. `sponsorship_packages.is_active`;
4. `current_date between starts_at and coalesce(ends_at, 'infinity')` — the window, checked against the
   database's date and not the caller's;
5. the entitlements document is well-formed (six `immutable` validators, one per family of rules, so a
   bad document cannot be saved at all rather than caught on read).

An earlier draft had the Worker re-check some of this after the query. That is how two answers to the same
question get made, and the second one always loses. Now the route projects, sorts and truncates, and
decides nothing.

`kicklive_sponsorship_explain(p_target_kind, p_target_id)` runs the **same** predicates and answers why a
sponsorship did or did not make it, per row. The desk's preview panel is driven by that function, so "why
is nobody showing on this match?" has one answer rather than an explanation in two places.

## 5. Ordering, caps, and the absence of bidding

Order is `priority, display_order, starts_at desc, id`. There is no `random()`, no rotation ticket and no
weight — a rotated sponsor band is how a paid title placement becomes an accident. Caps are refusals with
names, not silent truncation:

- `EXCLUSIVITY_TAKEN` — a package with `exclusivity` cannot be sold twice for the same target while
  another active agreement holds it;
- `PACKAGE_LIMIT_FOR_TARGET` — `max_per_target`;
- a `double_title` count that is not zero is a **migration-time failure**: the `-- 13 · verification`
  block runs after the guards and raises if the seeded data violates its own rules, so a bad install
  cannot land quietly.

`p_limit` is clamped to 24 in SQL, and a per-target `row_number()` applies the cap inside the window
function when several targets are asked for at once (the preview endpoint takes 1–50 ids). A client asking
for 10 000 badges gets 24 and a `200`, not a `500`: a limit is a fact about the page, not a promise from
the caller.

## 6. Immutability, and what "immutable" means here

`slug` and `package.code` are guarded by triggers that refuse an update even to `service_role`, because a
slug is a URL and a code is what a spreadsheet in a finance folder says. The refusal is a named
`SLUG_IMMUTABLE` error with the field named, so the form can say "the identifier cannot change; create a
new package to retire this one" instead of showing a spinner that never finishes.

What is _not_ immutable: `display_name`, prices, entitlements, priority. Those are the desk correcting
itself, and the audit trail for them is `sponsorship_status_transitions` for the states that matter plus
`updated_at`/`updated_by` for the rest. A phase that froze every column would not be safer, it would
just be used less.

## 7. URLs and links: who owns the rule

A sponsor's `website_url` and each placement's `link_url` become an `href` on a page a child reads. That
is a security boundary, and it is owned in exactly one place per layer:

- **In SQL**: `kicklive_sponsor_https_ok(p_url)` — which is a thin, deliberately named wrapper that
  delegates to **Phase 7's `kicklive_ad_http_url_ok`**. It refuses `javascript:`, `data:`,
  protocol-relative `//host`, a URL with no host, a second colon, `..` in the path, and
  `https://kicklive.football@evil.test/` (the credential-in-authority trick, which the ad flow test
  covers and the sponsorship flow re-cites in §15's note). Re-deriving a weaker regex here would have
  been the classic way for two "same" rules to diverge; one owner and one delegating caller is why the
  divergence cannot start.
- **On write**: the save refuses an http URL with `HTTPS_URL_WITH_HOST_REQUIRED` — it does not "fix" it to
  https, because silently changing what a sponsor asked for is how a legal objection turns up three
  months later.
- **On read**: the projection emits `href` and `rel` only if the stored value still passes the same test.
  Rows saved before this migration, or imported from a spreadsheet, are treated as untrusted rather than
  assumed clean.
- **In the browser**: `SponsorBadge` renders `href` when it is there and adds `sponsored` to `rel`
  regardless. A paid placement that is not marked as one is a problem for the sponsor, not just for us.

`brand_colour` gets the same treatment one size down: `HEX_COLOUR_REQUIRED` refuses `green`, because a
colour that is not a hex triple becomes a CSS injection surface the moment someone pastes
`red; background-image: url(...)`.

## 8. Money, contacts, and what the rate card may say

The desk sees the money block and the contact block: `invoice_reference`, `value_amount`, `renewal_terms`,
`contact_email` and friends are all on `sponsors`, and `GET /sponsorship/admin/sponsors` returns them
with `private, no-store`.

The public never does, and this is enforced twice:

- `kicklive_sponsor_package_card` — the published rate card — selects code, label, description, kind,
  tier, exclusivity, allowed kinds and entitlements. The `price_*` columns are **not in its select list**,
  so they are unreachable rather than filtered. A published card says what a package promises, not what
  it costs: the price of a season partnership is a negotiation, and printing it on a page is a business
  decision somebody should have to make deliberately.
- `kicklive_sponsorship_for`'s projection is an explicit `jsonb_build_object` list, never `to_jsonb(row)`.
  The comment inside the function says why in one line, and `tests/unit/phase8-sponsorship.test.ts`
  asserts both directions: that the SQL text does not contain a contact or money column at all, and that
  the frontend's `SponsorBandEntry` type has no key the projection does not send. A stray
  `to_jsonb(sp)` in a later edit therefore fails a test rather than shipping.

Contacts are normalised, not trusted: `lower(btrim(contact_email))` on write, so the desk cannot hold two
records for `ADS@FLOW.EXAMPLE ` and `ads@flow.example`.

## 9. Privileges: what the Worker calls as, and why not the service key

This is the part of the phase most likely to be "simplified" back into a bug, so it is written down in
full.

Every sponsorship route calls Postgres **as the caller**:

```
const client = ctx.principal.token ? supabaseAsUser(ctx, token) : supabaseAnon(ctx);
```

and not `supabaseAdmin`. The reason is a fact about hosted Supabase rather than a preference:
`services/supabase.ts` builds a PostgREST request whose only credential is
`authorization: Bearer <key>`. With the **service-role** key there is no user subject at all —
`auth.uid()` is `NULL`, so `is_admin()` is false, and every function in this file that decides the caller
from the JWT answers `ADMIN_ONLY` forever. A service client is not "the trusted backend" to Postgres; it
is a stranger with a strong key.

So:

- the admin surface is granted to **`authenticated`** and nobody else, and the Worker forwards the signed-in
  admin's own token. Granting to `authenticated` is **not** a widening: an anonymous caller still has no
  `execute`, a signed-in fan still trips `is_admin()`, the capability matrix refuses before a request is
  even built, and no client role holds a table privilege.
- the public surface is exactly **three** anon-executable functions — `kicklive_sponsorship_for`,
  `kicklive_sponsorship_epoch`, `kicklive_sponsor_package_card` — each with its own fixed projection. The
  grant loop enumerates them by name in one `if`, and a unit test asserts the list is exactly those three,
  so adding a fourth is a deliberate edit in two places.
- `kicklive_sponsorship_touch_epoch` and `kicklive_asset_url_for_asset(bigint)` are **service-role only**.
  The first is excluded from the loop by name (its only caller is another definer function in the same
  file, and it writes the cache version); the second had to be revoked **by name** — the loop reaches
  functions through `like 'kicklive_sponsor%'`, and `kicklive_asset_url_for_asset` does not match it. It
  had kept Phase 6's `execute(public)` grant, i.e. any stranger could have used a definer function that
  turns an asset id into a stored object key as an oracle for other people's uploads. A grant loop's
  pattern is its entire scope, and matching the pattern is not the same as being covered.
- `is_admin()`, `is_admin_or_media()` and `touch_updated_at()` are granted to `service_role` here, because a
  `security definer` function runs as its owner and the owner's role must be able to execute what it calls.

**Phase 7's defect, recorded rather than quietly inherited**: `workers/src/routes/ads.ts` builds its
staff writes with `asCaller = false`, which routes them through `supabaseAdmin`, while
`kicklive_ad_save_*` and `kicklive_ad_explain` gate on `is_admin()`. In a real deployment those admin
writes answer `ADMIN_ONLY`; nothing caught it because the Worker tests stub `fetch` and the ad flow calls
SQL directly. The fix is additive (grant those functions to `authenticated`, flip only those route calls;
maintenance, queue and cron paths keep the service client because they legitimately have no user token)
and it belongs to a maintenance pass, not to this phase. Phase 8 does not copy the defect, and this
paragraph is the reason the difference in the two files looks intentional — it is.

## 10. Media: reserve, publish, attach

One upload, three steps, in this order, and the order is the point:

1. **`kicklive_sponsor_reserve_asset`** — checks the caller is an admin, the sponsor exists, the slot is
   `logo|banner`, the content type is png/jpeg/webp/gif (never SVG, at any size, for any role), the size is
   inside the per-slot cap (5 MiB logo, 10 MiB banner — a wide banner is the one asset a sponsor reliably
   sends that is bigger than a crest), derives the key `sponsors/<uuid>/<slot>/v<n>-<sha8>.<ext>`, and
   writes the `media_assets` row as `uploading`. If an object with the same digest is already `ready` for
   that slot it answers "reuse", and the Worker skips the write.
2. **`publishAsset`** (Phase 6's, unmodified) — put the bytes, `head` them back, mark the row `ready`.
3. **`kicklive_sponsor_attach_asset`** — the **only** writer of `logo_url`/`banner_url`. It refuses an
   asset that was not reserved for _this_ sponsor, and refuses one that is not `ready`/`uploading`, so a
   URL can never point at somebody else's object or at a half-written one.

`sponsors` is therefore **registry-only** in `mediaPolicy.ts`: it is in `MEDIA_KINDS` (an asset row must be
able to name its entity) and **not** in `UPLOADABLE_KINDS` (`POST /media/uploads` refuses it), and its
`urlColumn` is `""` — the type-level statement that the generic publish path has nothing to repoint.
`kicklive_asset_url_column` in the Phase 6 migration deliberately has no `sponsors` arm for the same
reason. A test asserts all four of those facts against both artifacts.

An admin save that _typed_ a branding URL is refused with `BRANDING_IS_UPLOADED_NOT_TYPED` rather than
ignored. Ignoring it would have been worse: the desk reads `ok: true`, the badge does not change, and the
reason is sitting three tables away in a bucket listing.

## 11. Caching: an epoch, an ETag, and no purge

A sponsor band is the most cacheable thing in the app and the most embarrassing to serve stale. The
design keeps both promises without a CDN API:

- the read returns `max-age` from `sponsorship_config.band_max_age_seconds` (120 by default), so the TTL is
  a row the desk can change rather than a redeploy;
- the `ETag` is `"s<epoch>-<kind>-<id>"`, and a matching `If-None-Match` answers `304` **before** any SQL
  runs — a conditional request from a fan costs nothing;
- any viewer-visible write bumps `sponsorship_config.epoch` **in the same transaction** as the change, so
  the next request gets a fresh answer immediately. `maxAge` in the response is
  `min(band_max_age_seconds, FRESHNESS.page)`, and the client re-primes its own cache with that TTL;
- `vary: Accept-Encoding` and `x-sponsorship-epoch` ride on public responses; admin responses are
  `private, no-store`, because they carry emails and money;
- **nothing here purges a Fastly/Cloudflare cache**, and that is not an oversight: an image at a
  versioned, immutable key never needs purging (§10), and a band's staleness window is bounded by an epoch
  the writer controls. The one thing that would need a purge is a _retract_, and a retract is
  `status = 'suspended'`, which bumps the epoch — an eager invalidation is a nice-to-have and is listed as
  not done in §17 rather than pretended about.

Invalidations on the client are tag-based (`sponsors`, `sponsorship:<kind>:<id>`) and one function does
them: `invalidateSponsorship(target?)`. Both the desk's saves and the branding upload call it, which is
why a page open in another tab stops showing a sponsorship the moment it is switched off.

## 12. The desk and the pages it feeds

One query spec (`sponsorBand` in `src/lib/data/sponsorship.ts`, `defineQuery` like every other read), two
components, two hosts, one admin screen:

- **`SponsorBadge`** — one sponsor: artwork if there is artwork, `display_name` as a wordmark if not
  (an empty box reads as a broken image; a sponsor with no uploaded mark still holds the rights). Sizes
  `sm|md|lg`, brand colour honoured, `rel` includes `sponsored`. **No sponsor names appear in the file** —
  a `case "betway"` is how a phase like this quietly dies, because adding a partner stops being a row in a
  table and becomes a deploy. Enforced by a test that scans the component for identity branches and for a
  list of plausible brand names.
- **`SponsorBand`** — takes a target and nothing else. `row` for a match header, `wall` for a page whose
  subject _is_ the partnership. Order is the server's. When there is nothing to show it renders **no
  container at all**: no skeleton, no bordered box, no "No sponsors yet". A competition nobody has
  sponsored should look exactly like a page with no sponsorship feature, because the feature is the
  exception and not the layout.
- **Expiry is checked in the browser too** (`isExpired`, in `src/lib/sponsorship/display.ts`). Not because
  the server is untrusted — it checks `current_date > ends_at` itself — but because a response cached for
  two minutes can straddle midnight in a timezone neither side agreed on, and "expired sponsorships must
  not display as active" is a promise to a reader. A promise you keep does not depend on whose cache it
  was. The rule lives in a `.ts` module rather than in the component so it can be unit-tested without
  compiling JSX; the component re-exports it, because that is where a reader expects to find it.
- **Hosts** — `MatchDetails` gets the match band plus a `wall` for its competition, `TeamProfile` gets the
  team band. That is the whole rollout for now: two pages that a fan is already on. Adding a page is one
  element, and nothing needs to know a sponsor exists.
- **`SponsorshipManager`** (Admin Portal → _Sponsorship_) — three desks (partners, packages, assignments),
  each with a status arc row that offers only the transitions `useTransitions(kind)` returned, an
  eligibility preview panel fed by `POST /sponsorship/admin/preview`, and a branding uploader per partner
  that speaks to `uploadSponsorBranding` (progress, cancel, retry, and field-level errors, because a
  refused `NUMBER_REQUIRED` should land on the box that caused it). The desk never sends `status`,
  `approved_by` or a branding URL: those controls do not exist in the form, because the route would refuse
  them and a form with a dead checkbox is worse than a form without one.

## 13. Retention, expiry, and the maintenance door

- `kicklive_sponsorship_expire_due(p_limit)` moves active/paused agreements whose `ends_at < current_date`
  to `completed`, clears `is_active`, writes the transition rows with `reason = 'auto-expired'` and bumps
  the epoch. It is **safe to call twice** (idempotent, and it selects its own work with
  `for update skip locked`), which is what lets it be a cron. Nothing calls it automatically in this
  phase: `POST /sponsorship/admin/maintenance` is the door, and Phase 9's scheduled job is where the
  cadence belongs (it takes `auto_flight` as a reserved no-op so that wiring it later is one argument).
- Rows are **never deleted**. Archiving is this system's delete, and it is what lets a report answer "who
  sponsored the 2026 final" in 2028.
- `kicklive_sponsorship_diagnostics()` answers counts by status, held/expiring within 14 days,
  per-target top bands, orphans (an agreement whose sponsor was archived), double titles and the epoch —
  the numbers a desk needs and nothing a stranger can probe. `GET /sponsorship/admin/diagnostics` is
  gated by `system.diagnostics`, not by the sponsorship capability, because it is operator tooling.
- Retention of _band reads_ is a non-issue (no event log is written for a badge). Where a record of an
  action must exist, it is the transition row, and it is written in the same transaction as the change it
  describes.

## 14. Security: the threat model for a desk that holds contracts

| Threat                                                  | Where it is refused                                                        | Named refusal                        |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| A stranger reads a sponsor's contact or a price         | the projection is an explicit column list; the tables have no client grant | n/a — unreachable                    |
| A signed-in fan reaches the desk                        | capability matrix, then `is_admin()` in SQL                                | `403 FORBIDDEN/ADMIN_ONLY`           |
| A fan approves themselves as a sponsor                  | `status` refused by every writer                                           | `STATUS_VIA_SET_STATUS_ONLY`         |
| An admin forges who approved whom                       | `approved_by`/`approved_at` written only from `auth.uid()`                 | `APPROVAL_IS_NOT_EDITABLE`           |
| Somebody types a branding URL                           | save refuses; only `attach_asset` writes                                   | `BRANDING_IS_UPLOADED_NOT_TYPED`     |
| Somebody points a logo at another sponsor's asset       | `attach_asset` checks the reservation's sponsor                            | `ASSET_NOT_RESERVED`                 |
| A `javascript:` link reaches a match page               | §7, on write and on read                                                   | `HTTPS_URL_WITH_HOST_REQUIRED`       |
| A smuggled CSS colour                                   | hex-only CHECK                                                             | `HEX_COLOUR_REQUIRED`                |
| A client invents a field and it is quietly dropped      | `assertOnlyDeclared` at the edge, per-writer key list                      | `UNKNOWN_FIELD` + the allowed list   |
| A save silently ignores a field that has its own door   | refused rather than ignored                                                | `DISPLAY_SWITCH_VIA_SET_STATUS_ONLY` |
| A target that does not exist gets a badge               | `kicklive_sponsor_target_exists` before insert _and_ in the trigger        | `TARGET_NOT_FOUND`                   |
| A package is sold against a kind it was not drafted for | `allowed_target_kinds`                                                     | `KIND_NOT_IN_PACKAGE`                |
| Two exclusive deals for one target                      | exclusivity guard                                                          | `EXCLUSIVITY_TAKEN`                  |
| A cached band outlives a suspension                     | epoch in the ETag, bumped in the write                                     | n/a — next request is fresh          |
| A `500` leaks a stack trace                             | envelope mapping in `refuse()`, `detail` only outside production           | n/a                                  |

Two of those rows deserve a sentence, because both were found by _this_ phase's tests rather than by
design review. `UNKNOWN_FIELD` exists because a dropped `packageId` reads exactly like a saved record: the
worker's declared-field list and the function's consumed-field list are asserted against each other in
`tests/unit/phase8-sponsorship.test.ts`, in both directions. `DISPLAY_SWITCH_VIA_SET_STATUS_ONLY` exists
because the create form _did_ send `isActive`, the route _did_ declare it, the function never read it, and
the desk would have looked like it had hidden a sponsorship while the band kept showing it. The save now
refuses it, the form no longer sends it, and `scripts/sql-flow.mjs` executes the refusal.

## 15. Testing: what runs where, and what does not run here

- **`scripts/sql-flow.mjs` → `runSponsorshipFlow`** (~70 assertions, run by `scripts/check-sql.mjs
--dsn … [--fresh]`) — the only place the SQL is _executed_: creation as a draft, email normalisation,
  the four refusals above, the slug immutability, exclusivity and per-target limits, the date-window and
  `2026-02-30` cases, the transition arcs (an absent transition row is the prohibition), activation
  flipping the display switch, band content and ordering, `explain`, the reserve → attach pair including
  the "asset belongs to somebody else" refusal, the epoch bump, and `expire_due`. The flow seeds its own
  data and cleans up after itself, so it never reads ambient rows.
- **`tests/unit/phase8-sponsorship.test.ts`** — 25 cases (27 executed, three of them table-driven), and
  they are the cross-artifact assertions the flow cannot make: route key lists vs. the SQL's consumed and
  refused fields; the projection carrying no contact or money column and the frontend type mirroring it;
  the grant matrix (exactly three anon functions, `touch_epoch` excluded by name,
  `kicklive_asset_url_for_asset` revoked from `public/anon/authenticated` and granted to `service_role`);
  the media seam on both sides; the fifteen routes' capability/cache/rate-limit shape; every
  client-side endpoint resolving to a declared route; the components carrying no brand names; and the
  expiry rule executed against fixed dates.
- **Not present, and listed so it is not mistaken for a gap in the code**: there is no
  `tests/integration/sponsorship-api.test.ts`. The ad-facing `fetch` fakes would earn their keep for one
  assertion in particular — that staff calls carry the caller's bearer token rather than the service key
  (§9) — and that is a real follow-up, sized at "one more harness like `media-upload.test.ts`".
- **What did not run in the session that wrote §9's `isActive` refusal and the `-- 13` verification
  edits: anything needing Postgres.** There is no `initdb`, no `psql` and no container runtime in this
  sandbox, so `check-sql.mjs` skipped. The gates that did run: `npx tsc -p tsconfig.workers.json
--noEmit` clean, `tsc -p tsconfig.json --noEmit` clean, `node scripts/run-tests.mjs unit` 517/517,
  `node scripts/worker-routes.mjs --check` 88/88, `node scripts/gates.mjs` with the SQL job skipped and
  the packaging tiers skipped. **Before this phase is believed, run:**

  ```
  NODE_PATH=/tmp/pg/node_modules node scripts/check-sql.mjs \
    --dsn "postgres://kicklive@127.0.0.1:55432/kicklive_scratch" --fresh
  ```

  It must print `ok fresh: recreated database kicklive_scratch`, apply all seven migrations twice, and end
  with both flows `ALL PASS`. If `runSponsorshipFlow` fails on the new refusal, the failure is the fix
  being wrong and not the test being over-strict.

## 16. Manual setup, in the order that works

1. Apply `supabase/migrations/20260914120000_phase8_sponsorship.sql` to **staging** (it is
   `create or replace`-only; the sole DDL is five `create table if not exists` plus their indexes/triggers,
   and it re-widens `media_assets_kind_check` to admit `sponsors`).
2. Confirm the six seeded packages, then edit the prices on staging to whatever the rate card says.
   Do not skip this: the seeds are placeholders for shape, and the numbers are a business fact.
3. Apply to production, then run `GET /api/sponsorship?kind=competition&id=1` and expect `200` with
   `{"ok":true,"sponsors":[]}`, `etag`, and `cache-control: public, max-age=120`.
4. Sign in as an admin, open **Admin Portal → Sponsorship**, create one partner, upload its logo, approve
   it, sell it a package against a competition you can see, and check the badge on the match page with
   devtools open: the request should carry `authorization` and the response `x-sponsorship-epoch`.
5. Only now create the cron: `POST /api/sponsorship/admin/maintenance` hourly (or a scheduled Worker
   `scheduled` handler once Phase 9's job runner exists). Until something calls it, expiries happen on the
   desk and on read, which is correct but manual.

No new secret, queue or bucket is required by this phase — R2 and its three buckets come from Phase 6, and
the sponsor rows live in the same database as every other row.

## 17. What is deliberately not done

Not "later", and not "small follow-ups": the things a reviewer should know are missing.

- **No billing.** Money columns exist so the desk can record a contract, and `advance_paid` /
  `postpaid` / `billing_period` exist so an invoice can be reconciled against them by a human. There is no
  ledger, no tax handling, no PDF, no integration with anything, and `value_amount` is not a number any
  client can read publicly.
- **No `auto_flight`.** The argument is accepted and ignored. Wiring a sponsorship to generate an ad
  campaign means deciding budget, flight dates and which slot, and that is a Phase 9/10 conversation with
  the ad tables' owner, not a bolt-on here.
- **No sponsor self-service.** There is no role for "a partner editing their own logo". A sponsor's asset
  is uploaded by staff; a portal for partners is a capability (`sponsor.self.manage`), a role, and its own
  authorization function — three things this phase would have had to fake.
- **No impression counting on badges.** That is Phase 7's machinery (`ad_events`) with a `sponsors` target
  kind added, and the seam is the campaign id. Counting badges here would mean a second, worse analytics
  table.
- **No CDN purge integration**, for the reason in §11, and no invalidation API — a suspension is visible on
  the next request because the epoch moved, not because something was flushed.
- **No eager re-validation** of a band when a sponsor is suspended (the client refetches on its own
  `FRESHNESS.page` timer or on a tag invalidation in the tab that made the change).
- **No test of the Worker's caller-token choice** beyond the code review and the unit assertions about the
  route table; see §15 for what to add.
- **`includeExpired`, `q`, `offset` on the admin list** are accepted by the route and passed through to SQL,
  but the desk does not expose a filter UI; a sponsor with 60 agreements will page manually.
- **No band on `SeasonProfile`, `NewsArticle`, or an awards page**, because `award`/`event` targets exist in
  SQL without a page to hang a band on yet. The kinds are supported; the hosts are two.

## 18. One-paragraph summary for the release note

Sponsorship is now data rather than markup: five tables and twenty-eight functions hold partners, a rate
card, agreements against six kinds of target, the arcs a status can walk, and a single-row epoch; one
function decides who is visible and one projection is the only thing a stranger can read, so a contact
address and a price are unreachable rather than filtered. Placement order is contractual — no rotation,
no bidding, and exclusivity as a named refusal — artwork rides Phase 6's reserve → publish → attach pipeline
under a registry-only `sponsors` kind, the band is cacheable for a TTL the database owns and made stale by
an epoch the same transaction bumps, and the desk (three lists, real status arcs, an eligibility preview
that runs the read's own predicates, and a progress-reporting uploader) is the only place any of it is
edited. Expired sponsorships do not display — enforced in SQL, on read, and again in the component. What is
missing is stated in §17 (no billing, no partner self-service, no `auto_flight`), and one gate did not run
here: this sandbox has no Postgres, so `check-sql.mjs` must be executed before the migration is trusted
(§15).
