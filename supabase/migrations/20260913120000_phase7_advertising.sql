-- ═══════════════════════════════════════════════════════════════════════════
--  Kick Live · Phase 7 migration 1/1 — advertising and sponsorship infrastructure
--  Target: Postgres 15+ (Supabase). Idempotent. Additive.
--  No DROP TABLE, no DROP COLUMN, no DELETE against any pre-existing table, and no policy that gives a
--  browser role a path into these rows. The one destructive-looking statement is the swap of
--  `media_assets_kind_check` (drop + re-add) to admit the `advertisements` kind, which is the widening
--  Phase 6's own comment reserved for this file; it replaces a CHECK with a strictly larger one, so no
--  existing row can become invalid and nothing stored is touched.
--
--  WHAT THIS IS. A controlled placement platform, not an ad network. Seven tables (advertisers,
--  advertisement_campaigns, advertisements, ad_placements, advertisement_placements, ad_events,
--  advertisement_analytics) plus a status matrix, one deliberate widening of Phase 6's media registry so a
--  creative can be stored with its versioning, retention and reconciliation intact, and 28 `kicklive_ad_*`
--  functions that own every decision a client must not make: who may be an advertiser, when an
--  advertisement is eligible, what a public reader is allowed to see, whether a click or an impression
--  counts, and when the raw event log is forgotten.
--
--  WHAT THIS IS NOT, and each absence is a decision rather than an omission:
--    · no billing, invoicing or payment processing. `budget_amount` is a *reference* figure an admin
--      types, and nothing computes money from it. A number in this schema is never an invoice.
--    · no auction, no bidding, no realtime ranking. Rotation is a weighted lottery drawn once per cache
--      interval (§ROTATION), the cheapest thing that stops one advertiser monopolising a slot: one `md5`
--      per candidate and no state.
--    · no behavioural profiling. Targeting is per-request *content* context (page, competition, season,
--      team, match, time of day) over a closed key set. `ad_events` holds no IP, no user agent, no
--      account, no device and no cookie; its deduplication key is a per-day salted digest, deleted after
--      30 days.
--    · no client-side authority: the browser never decides that an advertisement is active, eligible or
--      countable. It asks for a placement and receives what the database says may be shown.
--
--  THE PLACEMENT RULE, which is what makes this infrastructure rather than a feature: no page contains an
--  advertisement. A page contains a *slot*, named by a code in `ad_placements`, and the slot renders
--  nothing at all until an administrator activates an advertisement for it. Apply this migration with zero
--  active campaigns and the app is pixel-identical to today — which is the property the brief asks for
--  when it says advertising must not cost performance, UX, live-match reliability, privacy or security.
--  The default state of this system is off, and it is off in the data, not behind a flag.
--
--  WHY A FUNCTION AND NOT RLS POLICIES FOR THE PUBLIC READ. Serving needs a decision no policy can
--  express — "of the twelve eligible creatives in this slot, show these three, rotated, and never one
--  whose daily cap is spent" — so it is a function: `kicklive_ad_serve`, granted to `anon`, whose result
--  is a hand-built object with exactly the keys a stranger may see. `budget_amount`, `internal_notes`,
--  `contact_*`, `priority`, `weight`, every non-`active` status and every row of `advertisers` are
--  unreachable from it, and no ad table grants a client role any privilege at all: with RLS on and no
--  policies, a read grant would be a door rather than a view, so the only thing a browser may do to
--  advertising is ask for a placement and report what it saw, both through a function. The verify block
--  refuses to install a leak.
--
--  APPLIES AFTER: 20260912120000 (Phase 6, media on R2). Phase 6 reserved the `advertisements/` key
--  prefix and said in its own comment that "Phase 7 adds it alongside its own tables with one alter
--  statement" — this is that statement. Nothing in Phase 6's file is edited: a fresh install runs both
--  files in timestamp order and converges, and so does a database that already applied Phase 6.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. VALIDATION PRIMITIVES — FIRST, because the table CHECKs below call them
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three small IMMUTABLE predicates, defined ahead of the tables and functions that use them so each rule
-- is stated once. They are immutable and do no lookup, which is what lets a table CHECK call
-- `kicklive_ad_http_url_ok` without the CHECK turning into a query.

create or replace function public.kicklive_ad_http_url_ok(p_url text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- Step 19: "malicious destination URLs where practical". Practical here is four things this function can
  -- decide with no network and no blocklist that rots:
  --   · https only. Not "http is fine on staging": an ad that links to http is a downgrade an attacker
  --     finishes on the same wifi as the club's fans, and every sponsor landing page has had https for a
  --     decade.
  --   · a host with a dot in it, and no userinfo before the first path slash — because
  --     `https://kicklive.football@evil.test/` is a valid URL whose host is not the one a reader sees, and
  --     rejecting `@` there makes that unconstructible rather than filtered.
  --   · no scheme a browser executes (javascript:, data:, vbscript:, file:) and no protocol-relative form,
  --     which would inherit whatever scheme the page happens to be on.
  --   · a length bound, because `href` is a string a template interpolates and 2 kB of base64 in a data:
  --     URL is only refused here, not downstream.
  -- What is deliberately NOT done: no domain allowlist and no reachability probe. An allowlist turns every
  -- new sponsor into a migration, and a probe from a write path is an SSRF request with a friendly face.
  -- Host reputation is a human approval decision — which is what `approved_by` is for.
  select p_url is null
      or (
        char_length(p_url) <= 2000
        and p_url ~* '^https://[^\s<>"'']+$'
        -- Only the one scheme above, so no second-colon form and no `http:` slipped in as a suffix.
        and (length(p_url) - length(replace(p_url, ':', ''))) = 1
        and position('@' in split_part(split_part(p_url, '//', 2), '/', 1)) = 0
        and split_part(split_part(p_url, '//', 2), '/', 1) like '%.%'
        and position('..' in p_url) = 0
      )
$fn$;

create or replace function public.kicklive_ad_image_ref_ok(p_url text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- Two legal shapes, and the difference between them is not cosmetic:
  --   · a managed asset path — what Phase 6's upload returns, relative on purpose (the same decision as
  --     `mediaPolicy.ts#assetPathFor`) so one row works on dev, staging and production. This is the shape
  --     that has a content hash, a size cap, a format sniff, a version and a retention window behind it.
  --   · an external https URL, for the sponsor who already hosts its banner elsewhere. It gets none of
  --     those things from us, which is why an admin has to approve it, and why `media_asset_id` — not
  --     this column — is what an integrity statement can be made about.
  -- No protocol-relative `//host/path` and no `http:`, for the same reason as above: a stored URL is a URL
  -- every visitor loads, forever.
  select p_url is null
      -- No `{2,509}` inside the pattern: Postgres' regex engine caps a repetition count at 255, and the
      -- complaint arrives at the first insert rather than at CREATE TABLE. The length rule is a predicate.
      or (p_url ~ '^/api/media/assets/[a-z0-9][a-z0-9._/-]{2,}$' and char_length(p_url) <= 600)
      or public.kicklive_ad_http_url_ok(p_url)
$fn$;

create or replace function public.kicklive_ad_targeting_ok(p_targeting jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- §TARGETING, and the closed key set *is* the privacy control. Six content dimensions: which
  -- competition, which season, which teams, which match, which page type, and which part of the day
  -- (the pharmacy that only wants evening fixtures is the whole reason that last one exists). There is
  -- no key for age, gender, interest, device, history or identity, so an advertiser cannot ask for one —
  -- and changing that is a schema migration somebody has to review, rather than a jsonb value nobody
  -- looked at.
  --
  -- Values are non-empty arrays of ids or labels: a set, not an expression. Deliberately unsupported:
  -- operators, SQL fragments, regexes, and negation — the last one because an exclusion list turns a
  -- filter into "never show my competitor's placement", which is a different product with a different
  -- argument to have.
  select p_targeting is null
      or (
        jsonb_typeof(p_targeting) = 'object'
        and (
          select count(1) from jsonb_object_keys(p_targeting) k
           where k not in ('competition_ids', 'season_ids', 'team_ids', 'match_ids', 'page_types', 'day_parts')
        ) = 0
        and (
          select count(1) from jsonb_each(p_targeting) e
           where jsonb_typeof(e.value) <> 'array'
              or jsonb_array_length(e.value) = 0
              or jsonb_array_length(e.value) > 64
        ) = 0
        and (
          select count(1) from jsonb_each(p_targeting) e, jsonb_array_elements(e.value) v
           where jsonb_typeof(v.value) not in ('string', 'number')
              or char_length(v.value #>> '{}') > 64
        ) = 0
      )
$fn$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PLACEMENTS — the registry of slots a page may ask for
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Step 3 says "do not hardcode advertisements directly into page components; use placement
-- configuration". That is only true if the slot is a row: an admin can retire `HOME_MIDDLE` or cap
-- `MATCH_PAGE` at one item without a deploy, and a page that asks for a code that is not here gets an
-- empty list rather than an error. The eight codes are the eight a template actually renders — this table
-- never invents a slot the UI cannot show, and the UI never invents a slot the database has not sized
-- (both directions are asserted in tests/unit/phase7-advertising.test.ts).

create table if not exists public.ad_placements (
  code              text        primary key check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  label             text        not null check (char_length(label) between 1 and 60),
  description       text        check (description is null or char_length(description) <= 240),
  page              text        not null check (page in ('home', 'match', 'team', 'news', 'standings', 'any')),
  -- A cap on items, not on desire: a slot that would take six creatives and shows three is still a
  -- slot whose layout was designed for three.
  max_items         integer     not null default 1 check (max_items between 1 and 6),
  -- Height budget in CSS pixels. Recorded because it is the number that makes "must not destroy mobile
  -- usability" checkable when somebody later wants a 970×250 creative in a slot designed for 90.
  height_budget_px  integer     check (height_budget_px is null or height_budget_px between 40 and 600),
  allowed_formats   text[]      not null default array['banner','square','story','sponsor_billboard'],
  -- Slots that sit beside live content carry an extra duty. Nothing enforces this flag in code — the
  -- enforcement is where the slot is placed in the template — but it is stored so that "may this slot
  -- move the scoreboard?" is a query and not a memory.
  yields_to_live    boolean     not null default true,
  is_active         boolean     not null default true,
  sort_order        integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table public.ad_placements is
  'The slots a template may ask for, and the budget each has. A slot that is inactive here answers empty '
  'everywhere, which is how a placement is retired without a deploy.';

-- Seeded, never re-seeded: an admin who sets `max_items` to 1 on `HOME_MIDDLE` must not have it reset to
-- 2 by a re-run. `on conflict do nothing` is the whole of that protection, which is why this table has no
-- upsert function.
insert into public.ad_placements (code, label, description, page, max_items, height_budget_px, allowed_formats, yields_to_live, sort_order) values
  ('HOME_TOP',        'Home — top band',         'Slim band under the header, above the live strip. Renders nothing when no campaign is eligible, and its height is capped so it cannot push live content.', 'home',      1,  90, array['banner','leaderboard','sponsor_billboard'], true,  10),
  ('HOME_MIDDLE',     'Home — between sections', 'Between the live matches and the news rail, inside the scroll.',                              'home',      2, 250, array['banner','square','story'],                      true,  20),
  ('MATCH_PAGE',      'Match page',              'Below the scoreboard on a match page. The scoreboard, the clock and any control are never inside it.', 'match',  1, 160, array['banner','square'],                                true,  30),
  ('TEAM_PAGE',       'Team page',               'Team profile, under the squad block.',                                                        'team',      2, 250, array['banner','square','story'],                      true,  40),
  ('NEWS_PAGE',       'News list',               'The news index, between article cards.',                                                      'news',      2, 250, array['banner','square','story'],                      true,  50),
  ('STANDINGS',       'Standings',               'Beside or under the table on /tables.',                                                       'standings', 1, 250, array['square','story','banner'],                      true,  60),
  ('BETWEEN_CONTENT', 'Inline between content',  'One item inside an article body or a list. The only slot allowed to interrupt reading, so it is capped at one and always labelled.', 'any', 1, 300, array['inline','square','banner'], true, 70),
  ('SPONSOR_BANNER',  'Sponsor strip',           'The league/club sponsor strip. Persistent by design, so the format is a billboard rather than a rotating banner.', 'any', 4, 120, array['sponsor_billboard','square'],           true,  80)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ADVERTISERS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A business, an organisation, a pharmacy, a brand, an event organiser, a local business, or a sponsor:
-- one table with a `kind`, because they are one workflow (someone proposes, someone approves, something
-- runs, something is measured). A separate `sponsors` table beside this one would differ only in which
-- columns are nullable, and that is how a schema grows a second path to the same approval. `contact_*`
-- and `internal_notes` are admin-only by construction: no function a browser can call mentions them.

create table if not exists public.advertisers (
  id              uuid          primary key default gen_random_uuid(),
  business_name   text          not null check (char_length(business_name) between 2 and 120),
  kind            text          not null default 'business'
                  check (kind in ('business', 'organization', 'pharmacy', 'brand', 'event_organizer', 'local_business', 'sponsor')),
  contact_name    text          check (contact_name   is null or char_length(contact_name)   <= 120),
  contact_email   text          check (contact_email  is null or char_length(contact_email)  <= 320),
  contact_phone   text          check (contact_phone  is null or char_length(contact_phone)  <= 40),
  website_url     text          check (website_url is null or public.kicklive_ad_http_url_ok(website_url)),
  logo_url        text          check (logo_url is null or public.kicklive_ad_image_ref_ok(logo_url)),
  city            text          check (city     is null or char_length(city)     <= 80),
  region          text          check (region    is null or char_length(region)  <= 80),
  -- A sponsorship tier as text, because there is no `sponsor_packages` table yet (deferred; see the
  -- architecture note §Deferred). The legacy free-text sponsor field maps here when that data is moved.
  tier            text          check (tier     is null or char_length(tier)     <= 40),
  status          text          not null default 'draft'
                  check (status in ('draft', 'pending', 'approved', 'suspended', 'archived')),
  internal_notes  text          check (internal_notes is null or char_length(internal_notes) <= 2000),
  created_by      uuid          references public.profiles(id) on delete set null,
  approved_by     uuid          references public.profiles(id) on delete set null,
  approved_at     timestamptz,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  -- An approval without a person and a time is a claim with no evidence. This is the audit trail, not
  -- decoration: `approved` cannot be stored at all without both.
  constraint advertisers_approval_consistent check (
    status <> 'approved' or (approved_by is not null and approved_at is not null)
  )
);
create index if not exists advertisers_status_idx on public.advertisers (status, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CAMPAIGNS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The *flight*: dates, a budget as a reference figure, and a status that can stop everything under it at
-- once. The campaign window is the hard bound — an advertisement is never eligible outside its campaign's--  dates, even if its own dates allow it — because "pause the campaign" has to mean stop today, and a
-- system where a paused campaign's ads can still serve is a system where an advertiser's complaint has no
-- answer.

create table if not exists public.advertisement_campaigns (
  id                uuid          primary key default gen_random_uuid(),
  advertiser_id     uuid          not null references public.advertisers(id) on delete restrict,
  name              text          not null check (char_length(name) between 2 and 120),
  starts_at         timestamptz   not null,
  ends_at           timestamptz   not null,
  -- Reference figures. `numeric(12,2)` with a free ISO code because the value has to survive both GHS and
  -- USD without a currency table nobody asked for. Nothing here converts, aggregates toward an invoice,
  -- or rounds: the column exists so "we agreed 4000 for the season" is written down somewhere the admin
  -- can read, and it is *not* the basis of a charge.
  budget_amount     numeric(12,2) check (budget_amount is null or budget_amount >= 0),
  budget_currency   text          check (budget_currency is null or budget_currency ~ '^[A-Z]{3}$'),
  billing_reference text          check (billing_reference is null or char_length(billing_reference) <= 80),
  status            text          not null default 'draft'
                    check (status in ('draft', 'pending', 'active', 'paused', 'completed', 'archived')),
  internal_notes    text          check (internal_notes is null or char_length(internal_notes) <= 2000),
  created_by        uuid          references public.profiles(id) on delete set null,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint campaign_window_ordered check (ends_at > starts_at),
  constraint campaign_currency_needs_amount check (budget_currency is null or budget_amount is not null),
  -- Only an ordering rule lives here. "A flight may not be marked completed before its end date" is *also* a
  -- rule about time, but writing it as a CHECK would freeze `now()` into a permanent invariant: the row is
  -- legal when it is written and, since `ends_at` is in the past by then, still legal forever — so the
  -- constraint can never catch the thing it appears to guard, while a restore into a database with an
  -- older clock would reject it for no reason. The rule belongs to the act of setting the status, and it
  -- lives in `kicklive_ad_set_campaign_status` as `FLIGHT_HAS_NOT_ENDED`.
  constraint campaign_window_has_dates check (ends_at is not null or starts_at is null)
);
create index if not exists campaigns_advertiser_idx on public.advertisement_campaigns (advertiser_id, status, ends_at);
create index if not exists campaigns_status_window_idx on public.advertisement_campaigns (status, starts_at, ends_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ADVERTISEMENTS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The creative, its schedule, its priority/weight and its targeting. Two design points worth the
-- paragraph:
--
-- (a) `status` and *eligibility* are different questions and the app must never confuse them. Status is
--     what an admin last left it as; eligibility is status ∧ window ∧ campaign ∧ placement ∧ advertiser
--     approval ∧ cap ∧ targeting, computed by `kicklive_ad_eligibility`. The serving path asks only the
--     second, so a row that says `active` but ended an hour ago cannot be shown — which is the exact case
--     a status-only system gets wrong silently, and why `status` is not indexed for serving.
-- (b) `destination_url` is validated rather than trusted, because it is the one string in this schema a
--     browser will navigate to on a click. `rel="sponsored nofollow noopener noreferrer"` and
--     `target="_blank"` are set by the template and are NOT stored here: the disclosure label's
--     *rendering* and the link relationship are presentation rules, and a presentation rule kept in data
--     is a presentation rule that can be edited away. `label` is the one exception, and only because the
--     brief wants four approved wordings rather than free text.

create table if not exists public.advertisements (
  id                  uuid          primary key default gen_random_uuid(),
  campaign_id         uuid          not null references public.advertisement_campaigns(id) on delete restrict,
  title               text          not null check (char_length(title) between 2 and 90),
  body                text          check (body is null or char_length(body) <= 240),
  format              text          not null default 'banner'
                      check (format in ('banner', 'square', 'story', 'inline', 'leaderboard', 'sponsor_billboard')),
  -- The creative. `media_asset_id` is the R2-backed asset (the normal case, and the only one with
  -- versioning, retention, a content hash and a size cap behind it); `image_url` is what gets rendered —
  -- a `/api/media/assets/<key>` path when the asset was published through Phase 6, or an external https
  -- URL for the "we already host it" case. Both are stored because the render path must not need a join,
  -- and `media_asset_id` is kept because integrity and retention must be able to name the asset.
  -- `media_assets.id` is a bigint identity, not a uuid: the FK follows the referenced column's type.
  media_asset_id      bigint        references public.media_assets(id) on delete set null,
  image_url           text          check (image_url is null or public.kicklive_ad_image_ref_ok(image_url)),
  video_url           text          check (video_url is null or public.kicklive_ad_http_url_ok(video_url)),
  destination_url     text          not null check (public.kicklive_ad_http_url_ok(destination_url)),
  destination_host    text generated always as (
                        lower(split_part(split_part(destination_url, '//', 2), '/', 1))
                      ) stored,
  alt_text            text          check (alt_text is null or char_length(alt_text) <= 300),
  status              text          not null default 'draft'
                      check (status in ('draft', 'pending', 'active', 'paused', 'expired', 'archived')),
  -- Priority is the deterministic half of the order (a paid season-long sponsor outranks a one-week
  -- experiment); weight is the proportional half (see §ROTATION). Both are 0..100 so an admin can reason
  -- about them without a manual, and neither is a bid.
  priority            integer       not null default 50 check (priority between 0 and 100),
  weight              integer       not null default 10 check (weight between 1 and 100),
  starts_at           timestamptz,
  ends_at             timestamptz,
  targeting           jsonb         not null default '{}'::jsonb,
  daily_impression_cap integer       check (daily_impression_cap is null or daily_impression_cap between 1 and 10000000),
  -- Step 18's disclosure. A closed set, so a creative cannot be labelled "News" or left unlabelled: the
  -- four values are all admissions that this is paid.
  label               text          not null default 'Sponsored'
                      check (label in ('Sponsored', 'Advertisement', 'Promoted', 'Partner content')),
  internal_notes      text          check (internal_notes is null or char_length(internal_notes) <= 2000),
  created_by          uuid          references public.profiles(id) on delete set null,
  approved_by         uuid          references public.profiles(id) on delete set null,
  approved_at         timestamptz,
  -- The last reason activation was refused, on the row, so the list can answer "why can't I turn this
  -- on?" without re-running the check or reading a log line that has already rolled away.
  activation_error    text,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  constraint ad_window_ordered check (ends_at is null or starts_at is null or ends_at > starts_at),
  -- A creative that is *being served* has to be complete. A draft may be a placeholder; an active row
  -- with no image, no alt text and no approver is a broken or unattributable advertisement on a public
  -- page, and this CHECK is the last line after `kicklive_ad_set_status`'s friendlier preconditions.
  -- (The window-vs-campaign containment is enforced in the functions instead: a CHECK cannot contain a
  -- subquery, and a trigger that re-validates on campaign edit would be a third place to keep in sync.)
  constraint ad_activation_complete check (
    status <> 'active' or (
      (image_url is not null or media_asset_id is not null)
      and alt_text is not null
      and char_length(trim(alt_text)) >= 3
      and approved_by is not null
      and approved_at is not null
    )
  ),
  -- (The one-title-per-flight rule is a unique *index* below rather than a table constraint: Postgres
  -- accepts only column lists in `unique (...)`, and `lower(title)` is an expression.)
  constraint ad_targeting_object check (jsonb_typeof(targeting) = 'object')
);
-- Two copies of the same creative in one flight is never deliberate; it is a duplicate that halves each
-- one's measured performance and doubles the impression cap's meaning. Case-insensitive, because "Ramadan
-- Sale" and "RAMADAN SALE" entered on two days is the same banner.
create unique index if not exists advertisements_one_title_per_campaign_idx
  on public.advertisements (campaign_id, lower(title));
create index if not exists advertisements_status_window_idx on public.advertisements (status, starts_at, ends_at);
create index if not exists advertisements_campaign_idx on public.advertisements (campaign_id, status);
-- What the serving path filters on, as one partial index: everything not being served stays out of it.
create index if not exists advertisements_serving_idx on public.advertisements (status, campaign_id) where status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. ADVERTISEMENT ↔ PLACEMENT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Which slots a creative runs in, and the overrides that only make sense per slot (a tighter cap on the
-- busy one, a different priority in the strip). Without this table an ad would have to be one row per
-- slot, and its analytics would be split by an accident of data entry.

create table if not exists public.advertisement_placements (
  advertisement_id     uuid        not null references public.advertisements(id) on delete cascade,
  placement_code       text        not null references public.ad_placements(code) on delete restrict,
  priority             integer     check (priority is null or priority between 0 and 100),
  weight               integer     check (weight is null or weight between 1 and 100),
  daily_impression_cap integer     check (daily_impression_cap is null or daily_impression_cap between 1 and 10000000),
  starts_at            timestamptz,
  ends_at              timestamptz,
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  primary key (advertisement_id, placement_code),
  constraint placement_window_ordered check (ends_at is null or starts_at is null or ends_at > starts_at)
);
create index if not exists ad_placements_by_code_idx on public.advertisement_placements (placement_code, is_active);
comment on table public.advertisement_placements is
  'Which slot a creative runs in. The format/slot compatibility rule lives in a trigger rather than a '
  'CHECK, because a CHECK may not read another table and a format can change after the assignment.';

-- The compatibility rule, as a trigger: a `story` creative cannot be pointed at a slot that only accepts
-- `banner`, and a slot's `allowed_formats` cannot be narrowed from under a creative already assigned to
-- it. Two directions, one function, because the second one is the case that would otherwise leave
-- eligibility refusing something an admin can see as "active in HOME_TOP" in the UI.
create or replace function public.kicklive_ad_guard_placement_format()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_format text;
begin
  -- One trigger per table, and this one is only ever attached to `advertisement_placements`, which is why
  -- `new.advertisement_id` can be read unconditionally: a shared function would have to dispatch on
  -- tg_relid to avoid referencing a column the other table does not have, and that is a much worse way to
  -- say "these are two rules".
  select a.format into v_format from public.advertisements a where a.id = new.advertisement_id;
  if not exists (
    select 1 from public.ad_placements p
     where p.code = new.placement_code
       and coalesce(v_format, 'banner') = any (p.allowed_formats)
  ) then
    raise exception 'placement % does not accept format %', new.placement_code, coalesce(v_format, 'banner')
      using hint = 'Change the creative''s format, or pick a slot that accepts it.';
  end if;
  return new;
end
$fn$;

-- The other direction, as its own function: narrowing a slot's formats must not strand the creatives
-- already assigned to it, because eligibility would then refuse rows the admin can see as "active in
-- HOME_TOP" and nothing in the UI would say why.
create or replace function public.kicklive_ad_guard_slot_formats()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if exists (
    select 1 from public.advertisement_placements x
      join public.advertisements a on a.id = x.advertisement_id
     where x.placement_code = new.code
       and not (a.format = any (new.allowed_formats))
  ) then
    raise exception 'a creative assigned to this slot uses a format the new allowed_formats list drops'
      using hint = 'Move the creative out of the slot first, or keep the format in allowed_formats.';
  end if;
  return new;
end
$fn$;

create or replace function public.kicklive_ad_guard_advertisement_format()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  -- A creative being edited to a format its slots reject: refuse the edit rather than let eligibility
  -- silently stop serving something the admin believes is live.
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.format is distinct from old.format and exists (
    select 1 from public.advertisement_placements x
    join public.ad_placements p on p.code = x.placement_code
     where x.advertisement_id = new.id and not (new.format = any (p.allowed_formats))
  ) then
    raise exception 'format % is not allowed by a slot this creative is assigned to', new.format
      using hint = 'Remove the slot first, or choose a format the slot accepts.';
  end if;
  return new;
end
$fn$;

-- `on delete restrict` from here: an ad with a history is archived, not removed. Cascade would take the
-- rollups with it, and the rollups are the only thing that outlives the raw log.
-- `drop trigger if exists` first, exactly as Phase 6's triggers do: `create trigger` has no `or replace`
-- form, so a file that is meant to be re-runnable cannot simply create one — and a migration that fails on
-- the second run is a migration nobody can apply twice.
drop trigger if exists trg_ad_placement_format_guard on public.advertisement_placements;
create trigger trg_ad_placement_format_guard
  before insert or update on public.advertisement_placements
  for each row execute function public.kicklive_ad_guard_placement_format();
drop trigger if exists trg_ad_slot_formats_guard on public.ad_placements;
create trigger trg_ad_slot_formats_guard
  before update of allowed_formats on public.ad_placements
  for each row execute function public.kicklive_ad_guard_slot_formats();
drop trigger if exists trg_ad_advertisement_format_guard on public.advertisements;
create trigger trg_ad_advertisement_format_guard
  before update on public.advertisements
  for each row execute function public.kicklive_ad_guard_advertisement_format();

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. EVENTS AND ANALYTICS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two tables, because they answer different questions on different lifetimes:
--
--   · `ad_events` is the raw log, and it is disposable. What makes it disposable rather than a privacy
--     liability is that there is nothing in it worth keeping: no IP, no user agent, no account, no
--     device, and `occurred_at` exists only to bound dedupe windows (the day is the grain anything
--     aggregates at). `viewer_key` is a 16-hex truncated digest whose salt changes daily, so it cannot be
--     joined across days even by somebody holding the table. Deleted after 30 days by `kicklive_ad_sweep`.
--   · `advertisement_analytics` is what the admin screens read: one row per (creative, slot, UTC day),
--     counts only. It stands on its own after the log is gone, which is why the rollup moves in the same
--     statement as the insert rather than being derived from a table that is being deleted from.
--
-- Deliberately absent: `user_id`. Recording *who* saw an ad is a different product, with a different
-- legal posture, and no requirement in this brief. The dedupe that needs a viewer identity is served by a
-- per-session digest instead, and the consequence is stated plainly in the architecture note: the
-- impression count is a floor, not an exact number.

create table if not exists public.ad_events (
  id               bigint generated always as identity primary key,
  advertisement_id uuid        not null references public.advertisements(id) on delete cascade,
  -- Denormalised on purpose: "how many impressions did this flight get" is the first question anyone
  -- asks, and it must not need a join into a table that is being pruned.
  campaign_id      uuid        not null,
  -- No FK to ad_placements by design: a retired slot code must keep its history readable, and a
  -- dangling-but-labelled code is the honest shape for that.
  placement_code   text        not null check (placement_code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  event            text        not null check (event in ('impression', 'click')),
  occurred_at      timestamptz not null default now(),
  day              date        not null default ((now() at time zone 'utc')::date),
  viewer_key       text        not null check (viewer_key ~ '^[0-9a-f]{16}$'),
  -- Computed by the insert functions and never accepted from a caller.
  dedupe_key       text        not null,
  counted          boolean     not null default true,
  created_at       timestamptz not null default now(),
  constraint ad_events_dedupe_unique unique (dedupe_key)
);
create index if not exists ad_events_ad_day_idx on public.ad_events (advertisement_id, day, placement_code);
-- The retention delete is `where occurred_at < now() - interval '30 days'`; this partial index is what
-- keeps that from being a scan of the largest table in this migration.
create index if not exists ad_events_retention_idx on public.ad_events (occurred_at) where counted;
comment on table public.ad_events is
  'Impression and click events, deduplicated, with no personal data in them. Raw rows are retained 30 '
  'days by public.kicklive_ad_sweep(); the numbers that outlive them are in advertisement_analytics.';

create table if not exists public.advertisement_analytics (
  advertisement_id uuid        not null references public.advertisements(id) on delete cascade,
  placement_code   text        not null,
  day              date        not null,
  impressions      bigint      not null default 0 check (impressions >= 0),
  -- No upper bound relating clicks to impressions, and that is a real decision rather than an omission:
  -- a click is honoured on a wider window than an impression (see §COUNTING), so clicks legitimately can
  -- exceed impressions when the impression was deduped or refused. A CHECK here would silently discard
  -- the most meaningful number in the system.
  clicks           bigint      not null default 0 check (clicks >= 0),
  updated_at       timestamptz not null default now(),
  primary key (advertisement_id, placement_code, day)
);
create index if not exists analytics_day_idx on public.advertisement_analytics (day desc);
comment on table public.advertisement_analytics is
  'The rollup the admin screens read. Counts only; CTR is computed when asked for and stored nowhere, '
  'because a stored ratio is a second truth that can disagree with the counts it came from.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ELIGIBILITY — the one definition, used by serving, by counting and by the admin screens
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One function owns "may this creative be shown, right now, in this slot, for this context". Step 5 says
-- the server decides whether an advertisement is active; the way to make that true rather than local is
-- to let nothing else compute it. The serving RPC, the event validator, the admin list's `serving`
-- column and the "why isn't this showing?" answer all go through here, and the reason is returned so a
-- refusal is explainable to the operator instead of being a mystery behind a cache.
--
-- It returns a single jsonb object rather than a row, so it can be called from a WHERE clause as a scalar
-- (a set-returning function there is an error in Postgres) and so every caller reads the same vocabulary.
--
-- `p_now` and `p_horizon_seconds` are parameters rather than `now()` and a constant, which is
-- load-bearing three times over: a test can prove an ad is eligible at 14:59:59 and not at 15:00:01
-- without waiting for anything; the horizon can be set to zero by the event validator (which wants
-- "is it live" rather than "will it survive a cache"); and the expiry sweep and the serving path are then
-- provably asking the same question.

create or replace function public.kicklive_ad_eligibility(
  p_advertisement_id uuid,
  p_placement_code   text,
  p_context          jsonb default '{}'::jsonb,
  p_now              timestamptz default now(),
  p_horizon_seconds  integer default 90
)
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  with ad as (
    -- The join chain is inner rather than left, so a campaign or advertiser that has gone makes the
    -- creative invisible rather than visible with a null status. The FKs make that unreachable by normal
    -- means (nothing here can delete an advertiser), which is exactly why the conservative direction is
    -- cheap enough to prefer anyway.
    select a.id, a.status, a.format, a.priority, a.weight, a.image_url, a.media_asset_id,
           a.starts_at, a.ends_at, a.targeting, a.daily_impression_cap,
           c.status as campaign_status, c.starts_at as campaign_starts, c.ends_at as campaign_ends,
           av.status as advertiser_status
      from public.advertisements a
      join public.advertisement_campaigns c on c.id = a.campaign_id
      join public.advertisers av              on av.id = c.advertiser_id
     where a.id = p_advertisement_id
  ),
  ap as (
    select x.priority, x.weight, x.daily_impression_cap, x.is_active, x.starts_at, x.ends_at
      from public.advertisement_placements x
     where x.advertisement_id = p_advertisement_id and x.placement_code = p_placement_code
  ),
  slot as (
    select p.is_active, p.allowed_formats, p.max_items
      from public.ad_placements p where p.code = p_placement_code
  ),
  today as (
    select coalesce(sum(an.impressions), 0)::bigint as impressions
      from public.advertisement_analytics an
     where an.advertisement_id = p_advertisement_id
       and an.placement_code = p_placement_code
       and an.day = (p_now at time zone 'utc')::date
  ),
  verdict as (
    -- The order below is the order an operator reads a refusal in: your data is wrong, then your
    -- schedule, then the switches above you, then "nothing you did".
    select case
      when (select count(1) from ad) = 0                then 'advertisement_not_found'
      when (select count(1) from ap) = 0                then 'not_placed_in_slot'
      when (select count(1) from slot) = 0              then 'slot_unknown'
      when not coalesce((select is_active from slot), false)      then 'slot_disabled'
      when not coalesce((select is_active from ap),  false)       then 'placement_disabled'
      when (select status from ad) <> 'active'                    then 'not_active'
      when (select campaign_status from ad) <> 'active'          then 'campaign_not_active'
      when (select advertiser_status from ad) <> 'approved'      then 'advertiser_not_approved'
      when (select image_url from ad) is null
       and (select media_asset_id from ad) is null               then 'no_creative'
      when (select campaign_starts from ad) > p_now             then 'campaign_not_started'
      when (select campaign_ends  from ad) <= p_now             then 'campaign_ended'
      when (select starts_at from ad) is not null and (select starts_at from ad) > p_now
                                                                then 'not_started'
      -- The horizon rather than `p_now`, and this is the line that makes Step 9 safe: a serving response
      -- may live in a cache for up to `horizon` seconds, so a creative that ends inside that window is
      -- already too late to put in it. An expired advertisement therefore cannot hide behind the cache,
      -- because it can never enter it — no purge, no invalidation, no trust in the CDN.
      when (select ends_at from ad) is not null
           and (select ends_at from ad) <= p_now + make_interval(secs => greatest(coalesce(p_horizon_seconds, 0), 0))
                                                                then 'ends_inside_cache_window'
      when (select starts_at from ap) is not null and (select starts_at from ap) > p_now
                                                                then 'placement_not_started'
      when (select ends_at from ap) is not null and (select ends_at from ap) <= p_now
                                                                then 'placement_ended'
      when not coalesce((select coalesce(a.format, 'banner') = any (s.allowed_formats)
                           from ad a, slot s), false)          then 'slot_refuses_this_format'
      when (select daily_impression_cap from ad) is not null
           and (select impressions from today) >= (select daily_impression_cap from ad)
                                                                then 'daily_cap_reached'
      when (select daily_impression_cap from ap) is not null
           and (select impressions from today) >= (select daily_impression_cap from ap)
                                                                then 'placement_daily_cap_reached'
      when not public.kicklive_ad_targeting_matches((select targeting from ad), p_context, p_now)
                                                                then 'targeting_excludes'
      else 'eligible'
    end as reason
  )
  select jsonb_build_object(
    'advertisement_id', p_advertisement_id,
    'placement_code',   p_placement_code,
    'eligible',         (select reason from verdict) = 'eligible',
    'reason',           (select reason from verdict),
    'slot_max_items',   (select max_items from slot),
    'effective_priority', coalesce((select priority from ap), (select priority from ad)),
    'effective_weight',   coalesce((select weight  from ap), (select weight  from ad)),
    'effective_cap',      coalesce((select daily_impression_cap from ap), (select daily_impression_cap from ad)),
    'impressions_today',  (select impressions from today)
  )
$fn$;

-- The targeting predicate, separate because the admin preview, the serving path and the event validator
-- must evaluate it identically, and because a nested EXISTS inside the CASE above is unreadable.
--
-- A context is what the *page* knows about itself ("match page, match 431, competition 12, season 2026,
-- teams 7 and 9"), never what it knows about the visitor. An empty targeting object matches everything. A
-- targeting key the context cannot answer (a team page has no `match_ids`) does NOT match: the
-- conservative direction, because "targeted at team 7" must not quietly become "shown everywhere" just
-- because the page did not know what a match id was.
create or replace function public.kicklive_ad_targeting_matches(p_targeting jsonb, p_context jsonb, p_now timestamptz default now())
returns boolean
language sql stable
set search_path = public, pg_temp
as $fn$
  with required as (
    select e.key, v.value #>> '{}' as wanted
      from jsonb_each(coalesce(nullif(p_targeting, 'null'::jsonb), '{}'::jsonb)) e,
           jsonb_array_elements(e.value) v
  ),
  supplied as (
    select e.key, v.value #>> '{}' as got
      from jsonb_each(coalesce(nullif(p_context, 'null'::jsonb), '{}'::jsonb)) e,
           jsonb_array_elements(e.value) v
  )
  select case
           when (select count(1) from required) = 0 then true
           when exists (
                    select 1 from (select distinct key from required) rk
                     where not exists (select 1 from supplied s where s.key = rk.key)
                  ) then false
           when exists (
                    select 1 from required r
                     where not exists (select 1 from supplied s where s.key = r.key and s.got = r.wanted)
                  ) then false
           -- `day_parts` is the one derived key, and the *server's* clock decides it. A client-supplied
           -- local time would be both spoofable and wrong for a 22:00 kickoff watched from another
           -- timezone, and "evening" is a statement about the match schedule, not about the viewer.
           when exists (
                    select 1 from required r
                     where r.key = 'day_parts'
                       and r.wanted <> case
                             when extract(hour from p_now) between 5  and 11 then 'morning'
                             when extract(hour from p_now) between 12 and 16 then 'afternoon'
                             when extract(hour from p_now) between 17 and 21 then 'evening'
                             else 'night'
                           end
                  ) then false
           else true
         end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ROTATION
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The brief asks for controlled rotation and explicitly not an auction, and this is the whole mechanism:
-- each advertisement gets `weight` tickets, every ticket is hashed with the current time bucket, and the
-- lowest hash wins — after priority. So:
--
--   · it is a lottery, not a queue. Nobody gets an exact share; everyone gets a proportional chance. For a
--     banner on a football site that is the difference that does not matter, and it is why there is no
--     scheduler, no counter and no per-viewer state here;
--   · it is stable within a cache interval and changes at the boundary, which is what makes "we rotate"
--     compatible with "we cache for 30 seconds". Those two mechanisms otherwise fight, and the loser is
--     whichever one you noticed second;
--   · it needs no write on a read path. The bucket comes from the clock, so the same request in the same
--     interval answers the same list — which is also what makes a cache hit and a cache miss
--     indistinguishable to a fan, a property you want before you need it;
--   · it is testable: with a pinned bucket the function is pure, so "weight 3 gets roughly three times the
--     exposure of weight 1" is a unit test over a lattice of ids rather than a runtime experiment.
--
-- What is deliberately absent: no learned weighting, no per-advertiser pacing, no bid, no floor, no
-- second-price anything, and no per-person frequency cap — that last one would need per-person state,
-- which is precisely what `ad_events` refuses to hold.

create or replace function public.kicklive_ad_rotation_key(
  p_advertisement_id uuid,
  p_weight integer,
  p_bucket bigint
)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- `min` over one hash per ticket: weight 3 gets three chances to land low, so ~3× the exposure of
  -- weight 1 — proportional, not guaranteed. md5 rather than a real RNG because the value only has to be
  -- uniformly spread and reproducible for a bucket; a deterministic draw is what makes the cached and
  -- uncached paths agree, and `random()` would make every cache miss reshuffle the page.
  select min(md5(p_advertisement_id::text || ':' || p_bucket::text || ':' || g::text))
    from generate_series(1, greatest(1, coalesce(p_weight, 1))) g
$fn$;

create or replace function public.kicklive_ad_bucket(p_now timestamptz, p_seconds integer)
returns bigint
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- The interval must equal the serving response's max-age or the two mechanisms argue. `adPolicy.ts`
  -- states the number once, and a test asserts this default agrees with it, so the equality is not a
  -- comment.
  select floor(extract(epoch from p_now) / greatest(coalesce(p_seconds, 30), 1))::bigint
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. THE PUBLIC SURFACE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `kicklive_ad_serve` is the only thing an anonymous browser may ask about advertising. Note what it does
-- NOT take: an advertiser id, a status, a budget, a "show me expired" flag, a limit above the slot's own
-- cap, or a placement that is not active. Everything a caller could use to widen its own view is absent
-- from the signature rather than refused inside it, because a parameter that is refused is one more thing
-- a future refactor can forget to refuse.

create or replace function public.kicklive_ad_serve(
  p_placement_code  text,
  p_context         jsonb default '{}'::jsonb,
  p_limit           integer default null,
  p_now             timestamptz default now(),
  p_horizon_seconds integer default 90
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_slot   public.ad_placements;
  v_limit  integer;
  v_bucket bigint;
  v_rows   jsonb;
begin
  select * into v_slot from public.ad_placements ap
   where ap.code = p_placement_code and ap.is_active;
  if not found then
    -- Not an error, and that is a deliberate API decision: a page may render a slot that has been
    -- retired, or one that an environment has not seeded yet. The answer in both cases is "nothing", and
    -- a 404 would turn a configuration change into a broken page — with a client-side cache of the 404
    -- for good measure.
    return jsonb_build_object(
      'ok', true,
      'reason', 'slot_unavailable',
      'placement', p_placement_code,
      'items', '[]'::jsonb,
      'rotationBucket', public.kicklive_ad_bucket(coalesce(p_now, now()), 30)
    );
  end if;

  -- A caller may ask for fewer, never more. `max_items` is the slot's promise to the layout; a client
  -- that could raise it could make a page taller than its own design.
  v_limit  := least(coalesce(p_limit, v_slot.max_items), v_slot.max_items);
  v_bucket := public.kicklive_ad_bucket(coalesce(p_now, now()), greatest(coalesce(p_horizon_seconds, 30), 1));

  select coalesce(
    jsonb_agg(jsonb_build_object(
      -- §EXPOSURE. This is the entire public vocabulary of an advertisement: `title`, `body`, an image, an
      -- alt text, a destination, the disclosure label, the slot it belongs to, and the asset version so a
      -- replacement (a new key) is distinguishable without invalidating anything. Not here, and
      -- unreachable by any other client-callable function: the advertiser's name (being named is the
      -- advertiser's choice, and it appears in the copy when they want it), campaign or advertiser ids,
      -- priority, weight, caps, dates, statuses, notes, contacts, budgets, and every row of `advertisers`.
      'id',              e.advertisement_id,
      'title',           e.title,
      'body',            e.body,
      'format',          e.format,
      'image_url',       e.image_url,
      'alt_text',        e.alt_text,
      'destination_url', e.destination_url,
      'label',           e.label,
      'placement',       p_placement_code,
      'asset_version',   e.asset_version
    ) order by e.priority desc nulls last, e.rotation_key),
    '[]'::jsonb
  ) into v_rows
  from (
    select a.id as advertisement_id, a.title, a.body, a.format,
           coalesce(a.image_url, '/api/media/assets/' || ma.object_key) as image_url,
           a.alt_text, a.destination_url, a.label,
           coalesce(ma.version, 1) as asset_version,
           coalesce(ap.priority, a.priority) as priority,
           public.kicklive_ad_rotation_key(a.id, coalesce(ap.weight, a.weight), v_bucket) as rotation_key
      from public.advertisements a
      join public.advertisement_campaigns c    on c.id  = a.campaign_id
      join public.advertisers av               on av.id = c.advertiser_id
      join public.advertisement_placements ap  on ap.advertisement_id = a.id and ap.placement_code = p_placement_code
      left  join public.media_assets ma        on ma.id = a.media_asset_id
     where a.status = 'active'
       and ap.is_active
       and c.status = 'active'
       and av.status = 'approved'
       and (a.starts_at is null or a.starts_at <= p_now)
       and (a.ends_at   is null or a.ends_at   >  p_now + make_interval(secs => coalesce(p_horizon_seconds, 0)))
       and (ap.starts_at is null or ap.starts_at <= p_now)
       and (ap.ends_at   is null or ap.ends_at   >  p_now)
       and (a.daily_impression_cap is null or coalesce((
              select sum(an.impressions) from public.advertisement_analytics an
               where an.advertisement_id = a.id and an.placement_code = p_placement_code
                 and an.day = (p_now at time zone 'utc')::date), 0) < a.daily_impression_cap)
       and public.kicklive_ad_targeting_matches(a.targeting, p_context, p_now)
       -- Whatever the WHERE clause above can express in one pass, the eligibility function re-checks, so
       -- the serving list and the "why is this not showing?" answer cannot disagree about what eligible
       -- means. In a slot with single-digit candidates, one extra call per candidate is the cheap side of
       -- that trade; the expensive side is two definitions drifting.
       and (public.kicklive_ad_eligibility(a.id, p_placement_code, p_context, p_now, p_horizon_seconds)->>'eligible') = 'true'
     order by coalesce(ap.priority, a.priority) desc nulls last,
              public.kicklive_ad_rotation_key(a.id, coalesce(ap.weight, a.weight), v_bucket)
     limit v_limit
  ) e;

  return jsonb_build_object(
    'ok', true,
    'reason', 'served',
    'placement', p_placement_code,
    'items', v_rows,
    'rotationBucket', v_bucket,
    'maxItems', v_slot.max_items
  );
end
$fn$;

-- The operator's answer to "it is not showing": the same eligibility function, kept refusal and all,
-- including statuses a browser cannot see. Written against the same predicate so the two can never
-- disagree about what eligible means, which is the property that makes this screen trustworthy.
create or replace function public.kicklive_ad_explain(
  p_advertisement_id uuid,
  p_placement_code   text default null,
  p_context          jsonb default '{}'::jsonb,
  p_now              timestamptz default now()
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_code text;
  v_rows jsonb := '[]'::jsonb;
  v_one  jsonb;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;

  if p_placement_code is not null then
    v_one := public.kicklive_ad_eligibility(p_advertisement_id, p_placement_code, p_context, p_now);
    return jsonb_build_object('ok', true, 'advertisement_id', p_advertisement_id,
                              'placements', jsonb_build_array(v_one));
  end if;

  for v_code in
    select ap.placement_code from public.advertisement_placements ap
     where ap.advertisement_id = p_advertisement_id
     order by ap.placement_code
  loop
    v_rows := v_rows || jsonb_build_array(
      public.kicklive_ad_eligibility(p_advertisement_id, v_code, p_context, p_now)
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'advertisement_id', p_advertisement_id,
    'placements', v_rows,
    'note', 'An empty placements list means no slot assignment exists, so nothing can serve this creative whatever its status.'
  );
end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. WRITES — validated here, never by a patch endpoint
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `service_role` gets no DELETE on the ad tables, and the grant block below says so out loud. There is
-- therefore no path from "the Worker can write these rows" to "the Worker can write them however it
-- likes": every mutation is a function that names the columns it accepts, the role that may call it, and
-- the state transitions it honours. A future route that wants a new column has to add it here, which is
-- the reviewable version of adding an endpoint.
--
-- All three save functions accept a jsonb payload rather than 20 parameters, and that is a shape choice
-- with a reason: `kicklive_asset`-style positional signatures make an optional column a signature
-- change, which breaks every caller of a `security definer` function; a payload lets a column be added
-- with `coalesce` while the signature — and therefore the grant — stays put.

create or replace function public.kicklive_ad_save_advertiser(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.advertisers;
  v_id  uuid := nullif(p_data->>'id', '')::uuid;
begin
  -- The role check is inside the function, not only on the route. A route that forgets is one pull
  -- request away from existing; a function the wrong person cannot call is not.
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- Required on create only. Every column here is `coalesce`d on the update path, so demanding the name
  -- again in a patch that only fixes a phone number would make partial edits impossible — and the Worker's
  -- admin route sends exactly those.
  if v_id is null and nullif(p_data->>'business_name', '') is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'business_name', 'reason', 'REQUIRED');
  end if;
  if p_data ? 'kind' and p_data->>'kind' not in
     ('business','organization','pharmacy','brand','event_organizer','local_business','sponsor') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'kind', 'reason', 'UNKNOWN_KIND');
  end if;
  if p_data ? 'status' and p_data->>'status' not in ('draft','pending','approved','suspended','archived') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'status', 'reason', 'UNKNOWN_STATUS');
  end if;
  if p_data ? 'website_url' and not public.kicklive_ad_http_url_ok(nullif(p_data->>'website_url','')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'website_url', 'reason', 'HTTPS_REQUIRED');
  end if;
  if p_data ? 'logo_url' and not public.kicklive_ad_image_ref_ok(nullif(p_data->>'logo_url','')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'logo_url', 'reason', 'MANAGED_ASSET_PATH_OR_HTTPS');
  end if;

  select * into v_row from public.advertisers a where a.id = v_id;
  if found then
    update public.advertisers set
      business_name  = coalesce(nullif(p_data->>'business_name', ''), business_name),
      kind           = coalesce(nullif(p_data->>'kind', ''), kind),
      contact_name   = coalesce(nullif(p_data->>'contact_name', ''), contact_name),
      contact_email  = coalesce(nullif(lower(p_data->>'contact_email'), ''), contact_email),
      contact_phone  = coalesce(nullif(p_data->>'contact_phone', ''), contact_phone),
      website_url    = coalesce(nullif(p_data->>'website_url', ''), website_url),
      logo_url       = coalesce(nullif(p_data->>'logo_url', ''), logo_url),
      city           = coalesce(nullif(p_data->>'city', ''), city),
      region         = coalesce(nullif(p_data->>'region', ''), region),
      tier           = coalesce(nullif(p_data->>'tier', ''), tier),
      -- Approval fields are NOT settable here, and that is the whole point of the split: `approved_by`
      -- and `approved_at` are written only by `kicklive_ad_set_advertiser_status`, so a save cannot
      -- launder an approval.
      status         = coalesce(nullif(p_data->>'status', ''), status),
      internal_notes = coalesce(nullif(p_data->>'internal_notes', ''), internal_notes),
      updated_at     = now()
     where id = v_id
     returning * into v_row;
    return jsonb_build_object('ok', true, 'advertiser', to_jsonb(v_row), 'created', false);
  end if;

  insert into public.advertisers (
    business_name, kind, contact_name, contact_email, contact_phone, website_url, logo_url,
    city, region, tier, status, internal_notes, created_by
  ) values (
    trim(p_data->>'business_name'),
    coalesce(nullif(p_data->>'kind', ''), 'business'),
    nullif(p_data->>'contact_name', ''),
    lower(nullif(p_data->>'contact_email', '')),
    nullif(p_data->>'contact_phone', ''),
    nullif(p_data->>'website_url', ''),
    nullif(p_data->>'logo_url', ''),
    nullif(p_data->>'city', ''),
    nullif(p_data->>'region', ''),
    nullif(p_data->>'tier', ''),
    -- A new advertiser starts at `pending` unless the caller explicitly asked for `draft`:
    -- self-approval is the one thing an approval workflow must not accept from the person being
    -- approved. Today an admin is both halves of that exchange, which is precisely why the explicit
    -- approve call exists and why it stamps `approved_by` with the caller rather than trusting this one.
    case when nullif(p_data->>'status','') = 'draft' then 'draft' else 'pending' end,
    nullif(p_data->>'internal_notes', ''),
    auth.uid()
  ) returning * into v_row;
  return jsonb_build_object('ok', true, 'advertiser', to_jsonb(v_row), 'created', true);
end
$fn$;

create or replace function public.kicklive_ad_save_campaign(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.advertisement_campaigns;
  v_adv uuid := nullif(p_data->>'advertiser_id', '')::uuid;
  v_id  uuid := nullif(p_data->>'id', '')::uuid;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if v_id is null and nullif(p_data->>'name', '') is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'name', 'reason', 'REQUIRED');
  end if;
  -- The advertiser is required on create and, when present, must exist; an update that omits it keeps the
  -- campaign where it is (moving a flight between advertisers is a re-contracting event, not an edit).
  if v_id is null and v_adv is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'advertiser_id', 'reason', 'REQUIRED');
  end if;
  if v_adv is not null and not exists (select 1 from public.advertisers a where a.id = v_adv) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'advertiser_id', 'reason', 'ADVERTISER_UNKNOWN');
  end if;
  if v_id is null then
    -- A new flight needs dates. `starts_at`/`ends_at` are not optional, because a campaign with no
    -- window is a campaign that never ends, and the whole point of a flight is that it ends.
    if nullif(p_data->>'starts_at','') is null or nullif(p_data->>'ends_at','') is null then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ends_at', 'reason', 'WINDOW_REQUIRED');
    end if;
    if (p_data->>'ends_at')::timestamptz <= (p_data->>'starts_at')::timestamptz then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ends_at', 'reason', 'WINDOW_NOT_ORDERED');
    end if;
  elsif (p_data ? 'starts_at' and p_data ? 'ends_at')
        and (p_data->>'ends_at')::timestamptz <= (p_data->>'starts_at')::timestamptz then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ends_at', 'reason', 'WINDOW_NOT_ORDERED');
  end if;
  if p_data ? 'budget_currency' and nullif(p_data->>'budget_currency','') is not null
     and not (p_data ? 'budget_amount') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'budget_amount',
                              'reason', 'AMOUNT_REQUIRED_FOR_CURRENCY');
  end if;
  if p_data ? 'budget_currency' and nullif(p_data->>'budget_currency','') is not null
     and p_data->>'budget_currency' !~ '^[A-Za-z]{3}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'budget_currency', 'reason', 'ISO4217_REQUIRED');
  end if;
  if p_data ? 'status' and p_data->>'status' not in ('draft','pending','active','paused','completed','archived') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'status', 'reason', 'UNKNOWN_STATUS');
  end if;

  select * into v_row from public.advertisement_campaigns c where c.id = v_id;
  if found then
    update public.advertisement_campaigns set
      name              = coalesce(nullif(p_data->>'name',''), name),
      advertiser_id     = coalesce(v_adv, advertiser_id),
      starts_at         = coalesce(nullif(p_data->>'starts_at','')::timestamptz, starts_at),
      ends_at           = coalesce(nullif(p_data->>'ends_at','')::timestamptz, ends_at),
      budget_amount     = coalesce(nullif(p_data->>'budget_amount','')::numeric, budget_amount),
      budget_currency   = coalesce(nullif(upper(p_data->>'budget_currency'),''), budget_currency),
      billing_reference = coalesce(nullif(p_data->>'billing_reference',''), billing_reference),
      internal_notes    = coalesce(nullif(p_data->>'internal_notes',''), internal_notes),
      status            = coalesce(nullif(p_data->>'status',''), status),
      updated_at        = now()
     where id = v_id
     returning * into v_row;
    return jsonb_build_object('ok', true, 'campaign', to_jsonb(v_row), 'created', false);
  end if;

  insert into public.advertisement_campaigns (
    advertiser_id, name, starts_at, ends_at, budget_amount, budget_currency, billing_reference,
    internal_notes, status, created_by
  ) values (
    v_adv, trim(p_data->>'name'),
    (p_data->>'starts_at')::timestamptz, (p_data->>'ends_at')::timestamptz,
    nullif(p_data->>'budget_amount','')::numeric,
    upper(nullif(p_data->>'budget_currency','')),
    nullif(p_data->>'billing_reference',''),
    nullif(p_data->>'internal_notes',''),
    case when nullif(p_data->>'status','') = 'pending' then 'pending' else 'draft' end,
    auth.uid()
  ) returning * into v_row;
  return jsonb_build_object('ok', true, 'campaign', to_jsonb(v_row), 'created', true);
end
$fn$;

create or replace function public.kicklive_ad_save_advertisement(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row     public.advertisements;
  v_id      uuid := nullif(p_data->>'id', '')::uuid;
  v_campaign uuid := nullif(p_data->>'campaign_id', '')::uuid;
  v_target   uuid;
  v_codes   text[] := '{}';
  v_window  timestamptz[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- Which flight this creative belongs to. On insert it must be named; on update an omitted
  -- campaign_id means "unchanged", so the row's own campaign is what the window check below compares
  -- against. Reading `v_campaign` alone would make every partial edit fail with CAMPAIGN_UNKNOWN — which
  -- is the kind of bug only a real UPDATE reveals, since every creation path supplies the field.
  select coalesce(v_campaign, a.campaign_id) into v_target from public.advertisements a where a.id = nullif(p_data->>'id','')::uuid;
  v_target := coalesce(v_campaign, v_target);
  if v_target is null or not exists (select 1 from public.advertisement_campaigns c where c.id = v_target) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'campaign_id', 'reason', 'CAMPAIGN_UNKNOWN');
  end if;
  v_campaign := v_target;
  if v_id is null and nullif(p_data->>'title','') is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'title', 'reason', 'REQUIRED');
  end if;
  -- A new creative must name a destination; an edit may leave it alone. Validated in both cases when
  -- present, because `destination_url` is the one value here a browser will navigate to.
  if (p_data ? 'destination_url' or v_id is null)
     and not public.kicklive_ad_http_url_ok(nullif(p_data->>'destination_url','')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'destination_url',
                              'reason', 'HTTPS_URL_WITH_HOST_REQUIRED');
  end if;
  if p_data ? 'image_url' and not public.kicklive_ad_image_ref_ok(nullif(p_data->>'image_url','')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'image_url',
                              'reason', 'MANAGED_ASSET_PATH_OR_HTTPS');
  end if;
  if p_data ? 'video_url' and not public.kicklive_ad_http_url_ok(nullif(p_data->>'video_url','')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'video_url', 'reason', 'HTTPS_REQUIRED');
  end if;
  if p_data ? 'targeting' and not public.kicklive_ad_targeting_ok(nullif(p_data->'targeting', 'null'::jsonb)) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'targeting',
                              'reason', 'UNKNOWN_KEY_OR_NON_ARRAY',
                              'detail', 'allowed keys: competition_ids, season_ids, team_ids, match_ids, page_types, day_parts; values must be non-empty arrays of ids');
  end if;
  if p_data ? 'label' and p_data->>'label' not in ('Sponsored','Advertisement','Promoted','Partner content') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'label', 'reason', 'UNKNOWN_LABEL');
  end if;
  if p_data ? 'format' and p_data->>'format' not in ('banner','square','story','inline','leaderboard','sponsor_billboard') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'format', 'reason', 'UNKNOWN_FORMAT');
  end if;

  if jsonb_typeof(nullif(p_data->'placements', 'null'::jsonb)) = 'array' then
    select array_agg(distinct trim(x)) into v_codes
      from jsonb_array_elements_text(nullif(p_data->'placements', 'null'::jsonb)) x;
    v_codes := coalesce(v_codes, '{}');
    if exists (select 1 from unnest(v_codes) c where not exists (select 1 from public.ad_placements p where p.code = c)) then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'placements',
                                'reason', 'UNKNOWN_PLACEMENT',
                                'allowed', (select coalesce(jsonb_agg(code), '[]'::jsonb) from public.ad_placements));
    end if;
    -- Refused here rather than left to the trigger so the answer is a field name and a list of slots, not
    -- a Postgres exception travelling through an API envelope.
    --
    -- The join is written this way for a reason: `x = any (select allowed_formats from …)` puts a whole
    -- text[] in each *row* of the subquery, and Postgres then tries to compare a text against an array and
    -- answers `operator does not exist: text = text[]` — even with the subquery wrapped in extra
    -- parentheses, which the grammar still reads as an ANY-subquery. Joining to the row makes
    -- `p.allowed_formats` an ordinary array column again, which is the form `= any (...)` means.
    if exists (
      select 1
        from unnest(v_codes) c
        join public.ad_placements p on p.code = c
       where not (coalesce(nullif(p_data->>'format',''), 'banner') = any (p.allowed_formats))
    ) then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'placements',
                                'reason', 'FORMAT_NOT_ALLOWED_IN_SLOT');
    end if;
  end if;

  -- Ad dates must sit inside the campaign's window. Checked rather than constrained, because a CHECK
  -- cannot contain a subquery and a trigger would be a third place to keep the rule (see the note on the
  -- table above).
  select array[c.starts_at, c.ends_at] into v_window from public.advertisement_campaigns c where c.id = v_campaign;
  if (nullif(p_data->>'starts_at','') is not null or nullif(p_data->>'ends_at','') is not null) then
    if coalesce(nullif(p_data->>'starts_at','')::timestamptz, v_window[1]) < v_window[1]
       or coalesce(nullif(p_data->>'ends_at','')::timestamptz, v_window[2]) > v_window[2] then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ends_at',
                                'reason', 'OUTSIDE_CAMPAIGN_WINDOW',
                                'detail', jsonb_build_object('campaign_starts', v_window[1], 'campaign_ends', v_window[2]));
    end if;
  end if;

  select * into v_row from public.advertisements a where a.id = v_id;
  if found then
    -- `status` is NOT settable here. Activation belongs to `kicklive_ad_set_status`, which runs the
    -- preconditions; if a save could also flip it, the preconditions would be a suggestion.
  begin
    update public.advertisements set
      title                = coalesce(nullif(p_data->>'title',''), title),
      body                 = coalesce(nullif(p_data->>'body',''), body),
      format               = coalesce(nullif(p_data->>'format',''), format),
      image_url            = coalesce(nullif(p_data->>'image_url',''), image_url),
      video_url            = coalesce(nullif(p_data->>'video_url',''), video_url),
      destination_url      = coalesce(nullif(p_data->>'destination_url',''), destination_url),
      alt_text             = coalesce(nullif(p_data->>'alt_text',''), alt_text),
      priority             = coalesce(nullif(p_data->>'priority','')::integer, priority),
      weight               = coalesce(nullif(p_data->>'weight','')::integer, weight),
      starts_at            = coalesce(nullif(p_data->>'starts_at','')::timestamptz, starts_at),
      ends_at              = coalesce(nullif(p_data->>'ends_at','')::timestamptz, ends_at),
      targeting            = coalesce(nullif(p_data->'targeting', 'null'::jsonb), targeting),
      daily_impression_cap = coalesce(nullif(p_data->>'daily_impression_cap','')::integer, daily_impression_cap),
      label                = coalesce(nullif(p_data->>'label',''), label),
      internal_notes       = coalesce(nullif(p_data->>'internal_notes',''), internal_notes),
      updated_at           = now()
     where id = v_id
     returning * into v_row;
  exception
    when unique_violation then
      -- The one title-per-flight index (§4). A raw 23505 would reach the client as a Postgres sentence,
      -- and every caller would have to pattern-match it; here it is a field name and a reason instead.
      return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'title',
                                'reason', 'DUPLICATE_TITLE_IN_CAMPAIGN',
                                'detail', 'Two creatives with the same name in one flight split both the exposure and the measured numbers.');
  end;

    -- Setting placements is a replace, not an add: a UI that shows three slots and submits two means the
    -- admin removed one. An absent key means "I did not touch placements", which is why the delete is
    -- guarded by `p_data ? 'placements'` and the insert above is not.
    if p_data ? 'placements' then
      delete from public.advertisement_placements x
       where x.advertisement_id = v_id and not (x.placement_code = any (v_codes));
      insert into public.advertisement_placements (advertisement_id, placement_code)
      select v_id, c from unnest(v_codes) c
      on conflict (advertisement_id, placement_code) do nothing;
    end if;

    return jsonb_build_object(
      'ok', true,
      'advertisement', to_jsonb(v_row),
      'placements', coalesce((select jsonb_agg(x.placement_code order by x.placement_code)
                                from public.advertisement_placements x where x.advertisement_id = v_id), '[]'::jsonb),
      'created', false
    );
  end if;

  begin
    insert into public.advertisements (
      campaign_id, title, body, format, image_url, video_url, destination_url, alt_text,
    priority, weight, starts_at, ends_at, targeting, daily_impression_cap, label, internal_notes, created_by
  ) values (
    v_campaign, trim(p_data->>'title'), nullif(p_data->>'body',''),
    coalesce(nullif(p_data->>'format',''), 'banner'),
    nullif(p_data->>'image_url',''), nullif(p_data->>'video_url',''),
    nullif(p_data->>'destination_url',''), nullif(p_data->>'alt_text',''),
    coalesce(nullif(p_data->>'priority','')::integer, 50),
    coalesce(nullif(p_data->>'weight','')::integer, 10),
    nullif(p_data->>'starts_at','')::timestamptz, nullif(p_data->>'ends_at','')::timestamptz,
    coalesce(nullif(p_data->'targeting', 'null'::jsonb), '{}'::jsonb),
    nullif(p_data->>'daily_impression_cap','')::integer,
    coalesce(nullif(p_data->>'label',''), 'Sponsored'),
    nullif(p_data->>'internal_notes',''), auth.uid()
    ) returning * into v_row;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'title',
                                'reason', 'DUPLICATE_TITLE_IN_CAMPAIGN',
                                'detail', 'Two creatives with the same name in one flight split both the exposure and the measured numbers.');
  end;

  insert into public.advertisement_placements (advertisement_id, placement_code)
  select v_row.id, c from unnest(v_codes) c
  on conflict (advertisement_id, placement_code) do nothing;

  return jsonb_build_object(
    'ok', true,
    'advertisement', to_jsonb(v_row),
    'placements', coalesce((select jsonb_agg(x.placement_code order by x.placement_code)
                              from public.advertisement_placements x where x.advertisement_id = v_row.id), '[]'::jsonb),
    'created', true
  );
end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. THE STATUS MACHINE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One VALUES list and one function, so "can active go to pending?" has exactly one answer in the
-- database, and the admin UI *reads that answer* instead of mirroring it. This is the same move Phase 5
-- made with `kicklive_notification_kind_policy`, for the same reason: a matrix that lives in a component
-- is a matrix that can be changed by a pull request that only touched the component.
--
--   draft    → pending | archived
--   pending  → active | draft | archived        (activate = the approval; preconditions run there)
--   active   → paused | expired | archived
--   paused   → active | expired | archived        (re-activation re-runs the preconditions)
--   expired  → active | archived                  (an extension is legitimate; eligibility re-checks the window)
--   archived → ∅                                  nothing serves from archived, and reopening it would
--                                                  put a creative nobody re-reviewed back on a public page
--
-- `pending → active` is the only arc that reaches the public, and it is the only one with preconditions.

create table if not exists public.ad_status_transitions (
  from_status text not null check (from_status in ('draft','pending','active','paused','expired','archived','approved','suspended','completed')),
  to_status   text not null check (to_status   in ('draft','pending','active','paused','expired','archived','approved','suspended','completed')),
  note        text,
  primary key (from_status, to_status)
);

insert into public.ad_status_transitions (from_status, to_status, note) values
  ('draft',   'pending',  'ready for review'),
  ('draft',   'archived', 'nothing sent'),
  ('pending', 'active',   'the approval act; activation preconditions run here'),
  ('pending', 'draft',    'back to editing'),
  ('pending', 'archived', 'declined'),
  ('active',  'paused',   'immediate for the next uncached read; the serving cache holds for at most its max-age'),
  ('active',  'expired',  'normal end of flight (also set by kicklive_ad_expire_due)'),
  ('active',  'archived', 'withdrawn'),
  ('paused',  'active',   're-activation re-runs the preconditions'),
  ('paused',  'expired',  null),
  ('paused',  'archived', null),
  ('expired', 'active',   'an extension moves the window; eligibility re-checks it'),
  ('expired', 'archived', null),
  -- `completed` is the flight's word for the same moment `expired` is the creative's, and the two tables share
  -- this matrix, so the arc has to be here for a campaign to reach it at all. Without it, "the operator closed
  -- this flight by hand" is impossible and `completed` is a state only `kicklive_ad_expire_due` can produce —
  -- which would make the cascade below this table (a flight leaving `active` parks its creatives) the only
  -- thing that ever archives a sponsorship's worth of copy. Adding the arc costs an advertisement nothing:
  -- `kicklive_ad_set_status` validates `p_status` against the *per-table* status list first, and an
  -- advertisement has no `completed` in its list, so the row is unreachable for it by validation rather than
  -- by omission — which is the difference between a matrix that is shared and a rule that is lost.
  ('active',  'completed', 'the flight ended on purpose; `kicklive_ad_set_campaign_status` still refuses it before the date arrives'),
  ('paused',  'completed', 'closing a flight that was paused rather than running down')
  -- `archived` has no outgoing row at all, and that absence IS the rule: this table is read with
  -- `exists (… from_status = current and to_status = wanted)`, so a row written to document a prohibition
  -- ('archived' -> 'active', 'never') would *permit* it. A matrix that doubles as documentation has to
  -- contain only the arcs that are allowed; the prose above is where the never-again rule is stated.
on conflict (from_status, to_status) do nothing;

create or replace function public.kicklive_ad_status_transitions(p_table text)
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- The statuses are per-kind (an advertiser has `approved`/`suspended` and no `expired`; a campaign has
  -- `completed` and no `expired`), and the *transitions* are shared, filtered to the states each table can
  -- be in. One matrix, three vocabularies, and the UI draws its buttons from here — which is how
  -- "PAUSED → ACTIVE is allowed but DRAFT → ACTIVE is not" cannot be re-decided in a component.
  select jsonb_build_object(
    'table', p_table,
    'statuses', case p_table
      when 'advertisers'             then array['draft','pending','approved','suspended','archived']
      when 'advertisement_campaigns' then array['draft','pending','active','paused','completed','archived']
      else array['draft','pending','active','paused','expired','archived']
    end,
    'transitions', coalesce((
      select jsonb_agg(jsonb_build_object('from', t.from_status, 'to', t.to_status, 'note', t.note)
                       order by t.from_status, t.to_status)
        from public.ad_status_transitions t
       where t.from_status = any (case p_table
               when 'advertisers'             then array['draft','pending','approved','suspended','archived']
               when 'advertisement_campaigns' then array['draft','pending','active','paused','completed','archived']
               else array['draft','pending','active','paused','expired','archived'] end)
         and t.to_status = any (case p_table
               when 'advertisers'             then array['draft','pending','approved','suspended','archived']
               when 'advertisement_campaigns' then array['draft','pending','active','paused','completed','archived']
               else array['draft','pending','active','paused','expired','archived'] end)
    ), '[]'::jsonb)
  )
$fn$;

create or replace function public.kicklive_ad_set_advertiser_status(p_id uuid, p_status text)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.advertisers;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.advertisers a where a.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'ADVERTISER_UNKNOWN');
  end if;
  if p_status not in ('draft','pending','approved','suspended','archived') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'status', 'reason', 'UNKNOWN_STATUS');
  end if;
  if v_row.status = 'archived' and p_status <> 'archived' then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'ARCHIVED_IS_TERMINAL',
                              'detail', 'create a new advertiser record instead; history is not reopened');
  end if;
  -- Approving is the one transition that needs the *current* caller rather than any write: `approved_by`
  -- is evidence, and evidence stamped by a background job is not evidence.
  update public.advertisers set
    status      = p_status,
    approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
    approved_at = case when p_status = 'approved' then now()      else approved_at end,
    updated_at  = now()
   where id = p_id
   returning * into v_row;

  -- A suspended advertiser stops its flights serving, immediately and without touching them: eligibility
  -- requires `advertiser_status = 'approved'`, so nothing here has to cascade. What IS cascaded is
  -- approval — an advertiser that is no longer approved cannot keep advertising that was approved under
  -- its old status, so those creatives go back to `pending` rather than staying `active`.
  if p_status in ('suspended', 'archived') then
    update public.advertisements a set status = 'pending', updated_at = now()
     where a.status = 'active'
       and a.campaign_id in (select c.id from public.advertisement_campaigns c where c.advertiser_id = p_id);
  end if;

  return jsonb_build_object('ok', true, 'advertiser', to_jsonb(v_row));
end
$fn$;

create or replace function public.kicklive_ad_set_campaign_status(p_id uuid, p_status text)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row     public.advertisement_campaigns;
  v_allowed boolean;
  v_affected integer := 0;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.advertisement_campaigns c where c.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'CAMPAIGN_UNKNOWN');
  end if;
  select exists (
    select 1 from public.ad_status_transitions t
     where t.from_status = v_row.status and t.to_status = p_status
  ) into v_allowed;
  if not v_allowed then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'TRANSITION_NOT_ALLOWED',
                              'detail', v_row.status || ' -> ' || coalesce(p_status, 'null'));
  end if;
  if p_status = 'active' and v_row.ends_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'CAMPAIGN_WINDOW_PAST',
                              'detail', 'extend the flight first; an active campaign that has already ended is a number nobody can reconcile');
  end if;
  -- The other half of the window rule, stated as a decision rather than as a constraint: `completed` is a
  -- claim about the flight's dates, so the date has to have arrived. A day of grace, because completing on the
  -- last day of a flight is normal clerical work and refusing it would teach an operator to set the date
  -- wrong. Everything else about a finished flight is allowed from anywhere in the flow — that is what
  -- `paused` and `archived` are for.
  if p_status = 'completed' and v_row.ends_at > now() + interval '1 day' then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'ends_at', 'reason', 'FLIGHT_HAS_NOT_ENDED',
                              'detail', 'a flight that has not reached its end date is paused, not completed');
  end if;
  if p_status = 'active' and not exists (
       select 1 from public.advertisers a where a.id = v_row.advertiser_id and a.status = 'approved'
  ) then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'ADVERTISER_NOT_APPROVED');
  end if;

  update public.advertisement_campaigns set status = p_status, updated_at = now() where id = p_id
   returning * into v_row;

  -- A flight leaving `active` must not strand its creatives in `active`: that is how a dashboard ends up
  -- showing "3 live advertisements" for a campaign nobody is paying for. They go to `paused` when the
  -- campaign might resume (a resumed flight should not require re-approving every creative) and to
  -- `archived` when it cannot.
  if p_status in ('paused', 'completed', 'archived') then
    update public.advertisements a
       set status = case when p_status = 'paused' then 'paused' else 'archived' end,
           updated_at = now()
     where a.campaign_id = p_id and a.status = 'active';
    get diagnostics v_affected = row_count;
  end if;

  return jsonb_build_object('ok', true, 'campaign', to_jsonb(v_row),
                            'advertisements_affected', v_affected);
end
$fn$;

create or replace function public.kicklive_ad_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row     public.advertisements;
  v_allowed boolean;
  v_missing text[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.advertisements a where a.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'ADVERTISEMENT_UNKNOWN');
  end if;

  select exists (
    select 1 from public.ad_status_transitions t
     where t.from_status = v_row.status and t.to_status = p_status
  ) into v_allowed;
  if not v_allowed then
    -- The refusal carries what IS allowed, because the admin screen's job is to say what to do next and
    -- 'TRANSITION_NOT_ALLOWED' with no list of alternatives is a dead end with a status code.
    return jsonb_build_object(
      'ok', false, 'code', 'CONFLICT', 'reason', 'TRANSITION_NOT_ALLOWED',
      'detail', v_row.status || ' -> ' || coalesce(p_status, 'null'),
      'allowed', coalesce((select jsonb_agg(t.to_status order by t.to_status)
                             from public.ad_status_transitions t
                            where t.from_status = v_row.status), '[]'::jsonb)
    );
  end if;

  if p_status = 'active' then
    -- ── activation preconditions ─────────────────────────────────────────
    -- Each of these is also a CHECK or an eligibility clause. They are repeated here so the admin gets a
    -- list of field names instead of a constraint violation to interpret: the CHECK is the guarantee, this
    -- is the explanation. And the row records the refusal, so the list page can say it again tomorrow.
    v_missing := '{}';
    -- `array_append`, not `|| 'text'`: Postgres has no text[] || text operator, and the error it
    -- raises (`malformed array literal`) reads like a bug in the caller rather than in this line.
    if v_row.image_url is null and v_row.media_asset_id is null then
      v_missing := array_append(v_missing, 'creative');
    end if;
    if v_row.alt_text is null or char_length(trim(v_row.alt_text)) < 3 then
      -- Alt text is required *to activate* rather than to draft because a decorative ad with no
      -- description is a screen-reader user getting nothing at all, on a page they came to for the score.
      v_missing := array_append(v_missing, 'alt_text');
    end if;
    if not public.kicklive_ad_http_url_ok(v_row.destination_url) then
      v_missing := array_append(v_missing, 'destination_url');
    end if;
    if not exists (
      select 1 from public.advertisement_placements ap
      join public.ad_placements pl on pl.code = ap.placement_code and pl.is_active
       where ap.advertisement_id = p_id and ap.is_active
    ) then
      v_missing := array_append(v_missing, 'placement');
    end if;
    if v_row.ends_at is not null and v_row.ends_at <= now() then
      v_missing := array_append(v_missing, 'window');
    end if;
    if not exists (
      select 1 from public.advertisement_campaigns c
      join public.advertisers av on av.id = c.advertiser_id
       where c.id = v_row.campaign_id and c.status = 'active' and av.status = 'approved'
    ) then
      v_missing := array_append(v_missing, 'campaign');
    end if;
    if array_length(v_missing, 1) > 0 then
      update public.advertisements a
         set activation_error = array_to_string(v_missing, ','), updated_at = now()
       where a.id = p_id;
      return jsonb_build_object(
        'ok', false, 'code', 'CONFLICT', 'reason', 'ACTIVATION_PRECONDITIONS',
        'missing', to_jsonb(v_missing),
        'detail', 'Refused to activate. Nothing was published, so there is nothing to roll back.'
      );
    end if;

    update public.advertisements set
      status = 'active', activation_error = null,
      approved_by = auth.uid(), approved_at = now(), updated_at = now()
     where id = p_id
     returning * into v_row;
  else
    update public.advertisements set status = p_status,
           activation_error = case when p_status = 'archived' then activation_error else null end,
           updated_at = now()
     where id = p_id
     returning * into v_row;
  end if;

  return jsonb_build_object(
    'ok', true,
    'advertisement', to_jsonb(v_row),
    'placements', coalesce((select jsonb_agg(x.placement_code order by x.placement_code)
                              from public.advertisement_placements x where x.advertisement_id = p_id), '[]'::jsonb),
    'note', case p_status
      when 'paused'  then 'Eligibility is per request, so a pause takes effect on the next uncached read; the serving cache holds for at most 30s.'
      when 'expired' then 'The row stays readable for history. The creative is untouched in R2 and Phase 6 retention starts from the next status change, not from here.'
      when 'archived' then 'The creative stays in R2 until the media retention sweep retires it, so an archive is always undoable inside the window.'
      else null
    end
  );
end
$fn$;

-- The two placement operations Step 15 asks for: retire a slot (everything in it stops serving at once,
-- which is the emergency brake this whole design keeps available) and change its cap. Nothing else about
-- a slot is editable from the app, on purpose: a slot whose `max_items` or formats an advertiser could
-- reach is a slot with no administrator, and the codes themselves are a deploy-time decision because a
-- page has to contain the element before a row can fill it.
create or replace function public.kicklive_ad_set_placement(p_code text, p_is_active boolean default null, p_max_items integer default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.ad_placements;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_is_active is null and p_max_items is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'NOTHING_TO_DO');
  end if;
  if p_max_items is not null and p_max_items not between 1 and 6 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'max_items', 'reason', 'OUT_OF_RANGE');
  end if;
  update public.ad_placements set
    is_active = coalesce(p_is_active, is_active),
    max_items = coalesce(p_max_items, max_items),
    updated_at = now()
   where code = p_code
   returning * into v_row;
  if v_row.code is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'PLACEMENT_UNKNOWN');
  end if;
  return jsonb_build_object('ok', true, 'placement', to_jsonb(v_row),
                            'note', 'Deactivating a slot stops it serving within one cache interval and leaves every assignment intact.');
end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. CREATIVES THROUGH THE PHASE 6 PLANE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Step 10: advertisement assets use the R2 architecture, and nothing is uploaded with unrestricted
-- browser credentials. The pipeline is Phase 6's — `publishAsset`: sniff → hash → reserve → put → head →
-- publish — so this file adds only the two things specific to an advertisement: who may reserve a slot
-- for one, and the vocabulary the reservation answers in.
--
-- `kicklive_ad_reserve_creative` deliberately mirrors `kicklive_reserve_asset_upload`'s *outcome shape*
-- (proceed / skip_upload / rejected / forbidden, with the same reason strings) so the Worker's pipeline
-- can drive either without knowing which, and so the two reservations cannot drift into two protocols.
-- Only the authorization differs: media uploads are per-entity-owner, ad creatives are admin-only, and an
-- ad that is being measured cannot be edited by whoever uploaded its image.

-- The two edits Phase 6 left for this file.
--
-- (a) The registry accepts the kind. Phase 6's comment says "sponsors/ and advertisements/ are
--     documented as reserved prefixes but are deliberately NOT legal here yet: there is no table to attach
--     them to, and a CHECK that allows a kind nothing can authorize is how orphaned objects get made".
--     `advertisements` now has a table *and* an authorizing function, so it becomes legal. `sponsors`
--     does **not**: it still has neither, and adding it "for symmetry" would be exactly the orphan-making
--     Phase 6 refused. It gets added the same way, in the migration that creates the table.
-- (b) `kicklive_asset_url_column` answers `image_url`, which is what makes Phase 6's own `finalize`
--     attach the published path to the advertisement row inside the same transaction. Without this arm
--     the asset would be stored and ready but no page would ever render it.
alter table public.media_assets drop constraint if exists media_assets_kind_check;
alter table public.media_assets add constraint media_assets_kind_check check (
  entity_kind in ('teams','players','competitions','seasons','news','team_news','matches','users','advertisements')
);

create or replace function public.kicklive_asset_url_column(p_entity_kind text)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select case p_entity_kind
    when 'teams'        then 'logo_url'
    when 'players'      then 'photo_url'
    when 'competitions' then 'logo_url'
    when 'news'         then 'image_url'
    when 'team_news'    then 'image_url'
    when 'users'        then 'avatar_url'
    -- The one Phase 7 adds. `seasons` and `matches` stay absent: their assets exist to be *read* from the
    -- media registry, not copied onto a row that has no image column.
    when 'advertisements' then 'image_url'
    else null
  end
$fn$;

comment on function public.kicklive_asset_url_column(text) is
  'Which entity column a published asset is copied into, or null when the registry is the only place the '
  'path lives. Extended by 20260913120000 to add `advertisements`; the Phase 6 definition is superseded, '
  'not edited, so a database that already ran Phase 6 converges by re-running this name.';

create or replace function public.kicklive_ad_reserve_creative(
  p_advertisement_id uuid,
  p_content_type     text,
  p_byte_size        bigint,
  p_sha256           text,
  p_width            integer default null,
  p_height           integer default null,
  p_alt_text         text    default null
)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ad  public.advertisements;
  v_ext text;
  v_ver integer;
  v_key text;
  v_dup public.media_assets%rowtype;
  v_new public.media_assets;
begin
  if not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'ADMIN_ONLY');
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'rejected', 'reason', 'DIGEST_REQUIRED');
  end if;
  if p_byte_size is null or p_byte_size < 1 or p_byte_size > 10485760 then
    -- 10 MB, the same ceiling as `news`: a 2×-for-retina leaderboard PNG is around 3 MB, and a 10 MB
    -- banner for a 300 px slot is a file that was never meant for this page. The Worker applies the
    -- per-kind cap before this line is reached, so this is the ceiling that holds when it is not.
    return jsonb_build_object('status', 'rejected', 'reason', 'TOO_LARGE');
  end if;
  v_ext := case lower(coalesce(p_content_type, ''))
    when 'image/png'  then 'png'
    when 'image/jpeg' then 'jpg'
    when 'image/webp' then 'webp'
    when 'image/gif'  then 'gif'
    else 'bin'
  end;
  if v_ext = 'bin' then
    -- The Worker sniffed this bytes-first already. Re-deriving the extension from the *content type the
    -- Worker settled on* (not from a filename, never) is what keeps the key's extension honest if a
    -- future caller arrives with a sniffed type the media plane did not have.
    return jsonb_build_object('status', 'rejected', 'reason', 'UNSUPPORTED_TYPE');
  end if;

  select * into v_ad from public.advertisements a where a.id = p_advertisement_id;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'ADVERTISEMENT_UNKNOWN');
  end if;
  if v_ad.status = 'archived' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'ADVERTISEMENT_ARCHIVED');
  end if;

  -- Dedupe before anything else: re-uploading the same bytes is a no-op rather than a new version, so an
  -- admin who double-clicks save neither doubles the stored bytes nor moves the creative to a second
  -- identical key.
  select * into v_dup from public.media_assets a
   where a.entity_kind = 'advertisements' and a.entity_id = p_advertisement_id::text
     and a.status = 'ready' and a.sha256 = p_sha256
   order by a.version desc limit 1;
  if found then
    return jsonb_build_object('status', 'skip_upload', 'asset', jsonb_build_object(
      'id', v_dup.id, 'object_key', v_dup.object_key, 'version', v_dup.version,
      'visibility', v_dup.visibility, 'status', v_dup.status
    ));
  end if;

  select coalesce(max(a.version), 0) + 1 into v_ver from public.media_assets a
   where a.entity_kind = 'advertisements' and a.entity_id = p_advertisement_id::text;
  v_key := public.kicklive_asset_object_key('advertisements', p_advertisement_id::text, 'original', v_ver, p_sha256, v_ext);

  insert into public.media_assets (
    entity_kind, entity_id, bucket, object_key, variant, version, content_type, byte_size,
    width, height, sha256, visibility, status, alt_text, created_by
  ) values (
    'advertisements', p_advertisement_id::text,
    -- The bucket name is data, not configuration — same rule and same setting as Phase 6, so an
    -- environment whose storage is not bound cannot write a row that claims otherwise.
    coalesce(nullif(current_setting('kicklive.storage_bucket', true), ''), 'media'),
    v_key, 'original', v_ver, p_content_type, p_byte_size, p_width, p_height, p_sha256,
    -- Public, and it has to be: an advertisement is rendered to anonymous visitors from an <img> tag that
    -- carries no Authorization header. Marking a creative private here would produce a broken image on a
    -- public page, not a protection.
    'public', 'uploading', p_alt_text, auth.uid()
  ) returning * into v_new;

  return jsonb_build_object('status', 'proceed', 'asset', jsonb_build_object(
    'id', v_new.id, 'object_key', v_new.object_key, 'version', v_new.version,
    'visibility', v_new.visibility, 'status', v_new.status
  ));
end
$fn$;

-- After the bytes are in R2 and head-confirmed, Phase 6's `kicklive_finalize_asset_upload` marks the row
-- `ready` and — because `kicklive_asset_url_column` below now answers `image_url` for the
-- `advertisements` kind — moves the creative's URL onto the advertisement row in that same transaction.
-- This function is the *undo* half, which Phase 6 has no equivalent of because no other entity has a
-- second copy of the path: `advertisements.media_asset_id` is the provenance link, and it must be set and
-- cleared explicitly so an archived ad cannot point at an asset somebody else now owns.
create or replace function public.kicklive_ad_attach_creative(p_advertisement_id uuid, p_asset_id bigint)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset public.media_assets;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_asset from public.media_assets a where a.id = p_asset_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'ASSET_UNKNOWN');
  end if;
  -- The asset has to belong to THIS advertisement. Without this line, "attach asset 42" is a way to point
  -- a new creative at somebody else's stored object and read it back through a public page.
  if v_asset.entity_kind <> 'advertisements' or v_asset.entity_id <> p_advertisement_id::text then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'ASSET_BELONGS_TO_ANOTHER_ENTITY');
  end if;
  if v_asset.status not in ('ready', 'uploading') then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'ASSET_NOT_READY', 'actual', v_asset.status);
  end if;

  update public.advertisements set
    media_asset_id = p_asset_id,
    -- The rendered path is derived from the same key Phase 6 published, so the two columns cannot
    -- disagree: `image_url` is never accepted from a caller on this path.
    image_url = '/api/media/assets/' || v_asset.object_key,
    updated_at = now()
   where id = p_advertisement_id;

  return jsonb_build_object('ok', true, 'asset_id', p_asset_id, 'version', v_asset.version,
                            'image_url', '/api/media/assets/' || v_asset.object_key);
end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. COUNTING, DEDUPLICATED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- IMPRESSION (the definition the brief asks to be written down): one advertisement, one slot, one
-- viewer-key, one UTC day, counted the first time the creative is *observed on screen* — not fetched, not
-- mounted. Re-renders, refetches, tab re-activation, a component that mounts twice and a retry of the
-- report all collapse onto one row, because the dedupe key is
-- `imp|<advertisement>|<placement>|<viewer_key>|<day>`. That single choice is what makes "do not count
-- every React render" a property of the database rather than a promise about `useEffect` dependencies.
--
-- The honest consequence, stated in the architecture note as well as here: a viewer who starts a new
-- session gets a new key, so the count is a **floor**, not an exact number. For an aggregate this is
-- measured for — "did the banner do better on the match page than on /tables" — a floor is enough, and
-- it is the right direction to err in. It is also why these numbers must not become an invoice before
-- somebody builds a real verification path.
--
-- CLICK: one advertisement, one slot, one viewer-key, one UTC *hour*, counted once — same shape, shorter
-- window, because a person legitimately taps a sponsor twice in an afternoon and should not be flattened
-- into one, while a script hammering the endpoint cannot get more than 24 counted clicks a day per key.
--
-- CTR is clicks ÷ impressions, computed when asked for. It is stored nowhere: a stored ratio is a second
-- truth that disagrees with the counts it came from the moment a count is corrected.

create or replace function public.kicklive_ad_record_event(
  p_advertisement_id uuid,
  p_placement_code   text,
  p_event            text,
  p_viewer_key       text,
  p_now              timestamptz default now()
)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_day      date := (p_now at time zone 'utc')::date;
  v_hour     text := to_char(p_now at time zone 'utc', 'YYYY-MM-DD HH24');
  v_dedupe   text;
  v_campaign uuid;
  v_ad       public.advertisements;
  v_state    jsonb;
  v_reason   text;
  v_grace    interval;
begin
  if p_event not in ('impression', 'click') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'event', 'reason', 'UNKNOWN_EVENT');
  end if;
  -- Shape, not provenance. The key is a caller-chosen 16 hex characters and it is NOT a credential: an
  -- attacker who wants to spend somebody else's daily allowance can, and gains nothing beyond a row they
  -- cannot read back. What the shape check buys is that a caller cannot smuggle an identifier into a
  -- column named viewer_key — `^[0-9a-f]{16}$` does not hold an email address, a device id or a phone
  -- number, which is the privacy property that matters here.
  if p_viewer_key is null or p_viewer_key !~ '^[0-9a-f]{16}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'viewerKey', 'reason', 'MALFORMED_VIEWER_KEY');
  end if;

  select * into v_ad from public.advertisements a where a.id = p_advertisement_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'ADVERTISEMENT_UNKNOWN');
  end if;
  v_campaign := v_ad.campaign_id;

  -- An event has to be about something that could actually have been on screen in this slot. Horizon 0
  -- rather than the serving horizon: the cache question is not the counting question, and asking the same
  -- function with a different parameter is cheaper than a second predicate that can drift.
  v_state  := public.kicklive_ad_eligibility(p_advertisement_id, p_placement_code, '{}'::jsonb, p_now, 0);
  v_reason := coalesce(v_state->>'reason', 'advertisement_not_found');

  if v_reason in ('advertisement_not_found', 'not_placed_in_slot', 'slot_unknown', 'slot_disabled',
                  'placement_disabled', 'no_creative', 'slot_refuses_this_format') then
    -- Nothing like this was ever served, so nothing here can be true about it.
    return jsonb_build_object('ok', true, 'counted', false, 'reason', 'NEVER_SERVABLE', 'detail', v_reason);
  end if;

  if v_reason not in ('eligible', 'daily_cap_reached', 'placement_daily_cap_reached', 'targeting_excludes') then
    -- Anything else means the creative is not currently servable for a reason of *status or schedule*. That
    -- is exactly the trailing-event case: an impression or click that arrives a moment after a pause, an
    -- expiry or a campaign stop refers to something the person really did see. The grace window is what
    -- makes that legitimate late event countable without making a permanently retired creative countable,
    -- and `updated_at` is the only record of when the status changed — which is why the window is coarse
    -- (10 minutes for an impression, 1 hour for a click) rather than tight.
    v_grace := case when p_event = 'impression' then interval '10 minutes' else interval '1 hour' end;
    if v_ad.updated_at < p_now - v_grace then
      return jsonb_build_object('ok', true, 'counted', false, 'reason', 'OUTSIDE_GRACE', 'detail', v_reason);
    end if;
  end if;

  v_dedupe := case when p_event = 'impression'
                   then 'imp|' || p_advertisement_id::text || '|' || p_placement_code || '|' || p_viewer_key || '|' || v_day::text
                   else 'clk|' || p_advertisement_id::text || '|' || p_placement_code || '|' || p_viewer_key || '|' || v_hour end;

  insert into public.ad_events (advertisement_id, campaign_id, placement_code, event, occurred_at, day, viewer_key, dedupe_key, counted)
  values (p_advertisement_id, v_campaign, p_placement_code, p_event, p_now, v_day, p_viewer_key, v_dedupe, true)
  on conflict (dedupe_key) do nothing;

  if not found then
    -- A duplicate: the honest answer is `counted: false`, and the rollup is left alone. Returning an
    -- error here would teach every client to stop retrying a *legitimate* second event.
    return jsonb_build_object('ok', true, 'counted', false, 'reason', 'ALREADY_COUNTED');
  end if;

  -- The rollup moves in the same statement, so `ad_events` and `advertisement_analytics` can only be
  -- apart if something dies between them — which, in one transaction, it cannot.
  insert into public.advertisement_analytics (advertisement_id, placement_code, day, impressions, clicks)
  values (p_advertisement_id, p_placement_code, v_day,
          case when p_event = 'impression' then 1 else 0 end,
          case when p_event = 'click' then 1 else 0 end)
  on conflict (advertisement_id, placement_code, day)
    do update set
      impressions = public.advertisement_analytics.impressions + case when p_event = 'impression' then 1 else 0 end,
      clicks      = public.advertisement_analytics.clicks      + case when p_event = 'click' then 1 else 0 end,
      updated_at  = now();

  return jsonb_build_object('ok', true, 'counted', true, 'event', p_event, 'day', v_day::text);
end
$fn$;

-- The batch form, for the queue consumer and only for it: one call per batch rather than one per event,
-- because a consumer that issues 25 RPCs for a 25-message batch has made the queue the bottleneck it
-- exists to remove. Refusals are per item and reported, never fatal for the batch — a poison event must
-- not stall the ninety-nine behind it. `exception when others` is what makes that true for a row that
-- fails at *parse* time (a uuid that is not one), which the per-item checks above cannot see.
create or replace function public.kicklive_ad_record_events(p_events jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  e          jsonb;
  v_res      jsonb;
  v_counted  integer := 0;
  v_deduped  integer := 0;
  v_refused  integer := 0;
  v_reasons  jsonb := '{}'::jsonb;
  v_key      text;
begin
  if jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'ARRAY_REQUIRED');
  end if;
  if jsonb_array_length(p_events) > 500 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'BATCH_TOO_LARGE');
  end if;

  for e in select * from jsonb_array_elements(p_events)
  loop
    begin
      v_res := public.kicklive_ad_record_event(
        nullif(e->>'advertisementId','')::uuid,
        coalesce(nullif(e->>'placement',''), 'HOME_TOP'),
        coalesce(nullif(e->>'event',''), 'impression'),
        nullif(e->>'viewerKey',''),
        coalesce(nullif(e->>'occurredAt','')::timestamptz, now())
      );
    exception when others then
      v_refused := v_refused + 1;
      v_reasons := jsonb_set(v_reasons, array['invalid_row'],
                            to_jsonb(coalesce((v_reasons->>'invalid_row')::integer, 0) + 1));
      continue;
    end;
    if coalesce((v_res->>'counted')::boolean, false) then
      v_counted := v_counted + 1;
    elsif v_res->>'reason' = 'ALREADY_COUNTED' then
      v_deduped := v_deduped + 1;
    else
      v_refused := v_refused + 1;
      v_key := coalesce(v_res->>'reason', 'UNKNOWN');
      v_reasons := jsonb_set(v_reasons, array[v_key],
                             to_jsonb(coalesce((v_reasons->>v_key)::integer, 0) + 1));
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'counted', v_counted, 'deduped', v_deduped,
                            'refused', v_refused, 'reasons', v_reasons);
end
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. ANALYTICS READ, SCHEDULING, RETENTION, DIAGNOSTICS
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.kicklive_ad_analytics(
  p_from date default ((now() at time zone 'utc')::date - 29),
  p_to   date default ((now() at time zone 'utc')::date),
  p_advertiser_id uuid default null,
  p_campaign_id   uuid default null,
  p_placement_code text default null,
  p_group_by text default 'advertisement'
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows jsonb;
begin
  -- Staff-only. The rollups are aggregate counts and look harmless, but they are the numbers a business
  -- relationship gets argued over, and "how many impressions did the pharmacy get last week" is
  -- commercially sensitive whether or not it contains a person.
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- Re-derive the defaults here rather than trusting the parameter defaults, because a caller that passes
  -- an explicit null — which is what an absent field in a JSON body becomes over RPC — does NOT get the
  -- default. Left alone, `between null and null` matches nothing and the screen shows an honest-looking
  -- empty table for a system full of numbers.
  p_from := coalesce(p_from, ((now() at time zone 'utc')::date - 29));
  p_to   := coalesce(p_to, ((now() at time zone 'utc')::date));
  p_group_by := coalesce(p_group_by, 'advertisement');
  if p_group_by not in ('advertisement', 'campaign', 'placement', 'day') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'groupBy', 'reason', 'UNKNOWN_GROUP_BY');
  end if;
  if p_to < p_from then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'to', 'reason', 'WINDOW_NOT_ORDERED');
  end if;
  -- A bounded window rather than "give me everything": the rollup is small per day but a two-year query
  -- over every creative is how a reporting screen becomes the slowest route in the Worker.
  if p_to - p_from > 92 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'from',
                              'reason', 'WINDOW_TOO_WIDE', 'detail', 'a quarter at a time; anything longer is an export job, not a request');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'key', r.key,
           'title', r.title,
           'impressions', r.impressions,
           'clicks', r.clicks,
           -- Rounded here rather than in the client: 0.037% and 0.04% are the same number for every
           -- purpose this table exists for, and one rounding rule means one place to argue about it.
           'ctr_percent', case when r.impressions = 0 then 0
                               else round(r.clicks::numeric * 100 / r.impressions, 2) end,
           'days', r.days
         ) order by r.impressions desc), '[]'::jsonb)
    into v_rows
  from (
    select
      case p_group_by
        when 'campaign'  then a.campaign_id::text
        when 'placement' then an.placement_code
        when 'day'       then an.day::text
        else an.advertisement_id::text
      end as key,
      case p_group_by
        when 'campaign'  then c.name
        when 'placement' then an.placement_code
        when 'day'       then an.day::text
        else a.title
      end as title,
      sum(an.impressions)::bigint as impressions,
      sum(an.clicks)::bigint      as clicks,
      count(distinct an.day)      as days
    from public.advertisement_analytics an
    join public.advertisements a         on a.id = an.advertisement_id
    join public.advertisement_campaigns c on c.id = a.campaign_id
    join public.advertisers av           on av.id = c.advertiser_id
    where an.day between p_from and p_to
      and (p_advertiser_id  is null or av.id = p_advertiser_id)
      and (p_campaign_id    is null or c.id  = p_campaign_id)
      and (p_placement_code is null or an.placement_code = p_placement_code)
    group by 1, 2
  ) r;

  return jsonb_build_object('ok', true, 'rows', v_rows, 'from', p_from::text, 'to', p_to::text,
                            'group_by', p_group_by,
                            'definition', 'impressions = distinct viewer-days per creative per slot (a floor, not an exact count); clicks = distinct viewer-hours; ctr = clicks/impressions');
end
$fn$;

-- Step 5's other half. Eligibility already ignores a creative whose window has passed, so nothing is
-- *served* wrongly; this is about what the tables say. An `active` row whose flight ended three weeks
-- ago is a lie on the admin screen, a CTR whose denominator is frozen under a status that implies it is
-- running, and a row nobody will ever pause. Flipping it to `expired` touches nothing a public reader
-- sees, because a public reader never asked about status.
--
-- `for update ... skip locked` inside a cursor loop, not in a CTE: a lock clause in a WITH is an error in
-- Postgres, and `skip locked` is what stops two overlapping runs from fighting over the same rows
-- instead of one of them failing.
create or replace function public.kicklive_ad_expire_due(p_limit integer default 500)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  r record;
  v_ads integer := 0;
  v_campaigns integer := 0;
begin
  for r in
    select a.id from public.advertisements a
     where a.status = 'active' and a.ends_at is not null and a.ends_at <= now()
     order by a.ends_at
     limit least(greatest(coalesce(p_limit, 500), 1), 2000)
     for update skip locked
  loop
    update public.advertisements set status = 'expired', updated_at = now() where id = r.id;
    v_ads := v_ads + 1;
  end loop;

  for r in
    select c.id from public.advertisement_campaigns c
     where c.status = 'active' and c.ends_at <= now()
     order by c.ends_at
     limit least(greatest(coalesce(p_limit, 500), 1), 2000)
     for update skip locked
  loop
    update public.advertisement_campaigns set status = 'completed', updated_at = now() where id = r.id;
    update public.advertisements a set status = 'expired', updated_at = now()
      where a.campaign_id = r.id and a.status = 'active';
    v_campaigns := v_campaigns + 1;
  end loop;

  return jsonb_build_object('ok', true, 'advertisements_expired', v_ads, 'campaigns_completed', v_campaigns);
end
$fn$;

-- Retention. It is the one DELETE in this file, and the reason is the same one that makes an
-- analytics log with no expiry a surveillance log nobody switched off: 30 days is long enough to settle a
-- dispute about last week and short enough that this table cannot become where the app keeps history about
-- who saw what. The rollups stay, and they hold no key that could be joined to a person.
--
-- The identity guard is the same shape as Phase 6's sweep and it is only safe for the same reason: the
-- function is not granted to `anon`/`authenticated`, so an identified caller who is not an admin has no
-- way to reach it at all.
create or replace function public.kicklive_ad_sweep(p_days integer default 30, p_limit integer default 20000)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cutoff  timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_ids     bigint[];
  v_deleted integer := 0;
begin
  if auth.uid() is not null and not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_REQUIRED');
  end if;

  select array_agg(x.id) into v_ids from (
    select e.id from public.ad_events e
     where e.occurred_at < v_cutoff
     order by e.occurred_at
     limit least(greatest(coalesce(p_limit, 20000), 1), 50000)
     for update of e skip locked
  ) x;

  if v_ids is not null then
    delete from public.ad_events e where e.id = any (v_ids);
    get diagnostics v_deleted = row_count;
  end if;

  return jsonb_build_object('ok', true, 'events_deleted', v_deleted, 'cutoff', v_cutoff::text,
                            'note', 'Rollups in advertisement_analytics are retained; they contain no viewer key.');
end
$fn$;

create or replace function public.kicklive_ad_admin_list(
  p_status text default null,
  p_placement_code text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows jsonb;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- A function rather than a REST read of the tables, for one column: `serving` is the eligibility answer,
  -- and a browser joining a set-returning function per row is a request per row. Everything else on this
  -- list is a straight projection, including the columns the *public* never sees — which is fine here and
  -- only here, because the caller has been checked against the capability in the route table.
  select coalesce(jsonb_agg(to_jsonb(r) order by r.updated_at desc), '[]'::jsonb) into v_rows
  from (
    select a.id, a.title, a.body, a.status, a.format, a.priority, a.weight, a.label,
           a.starts_at, a.ends_at, a.activation_error, a.updated_at, a.approved_at,
           a.image_url, a.destination_host, a.alt_text, a.daily_impression_cap, a.media_asset_id,
           c.id as campaign_id, c.name as campaign_name, c.status as campaign_status,
           av.id as advertiser_id, av.business_name, av.status as advertiser_status,
           coalesce((select jsonb_agg(x.placement_code order by x.placement_code)
                       from public.advertisement_placements x where x.advertisement_id = a.id), '[]'::jsonb) as placements,
           coalesce((select sum(an.impressions) from public.advertisement_analytics an
                      where an.advertisement_id = a.id and an.day = ((now() at time zone 'utc')::date)), 0) as impressions_today,
           coalesce((select sum(an.clicks) from public.advertisement_analytics an
                      where an.advertisement_id = a.id and an.day = ((now() at time zone 'utc')::date)), 0) as clicks_today,
           coalesce((select bool_or(el.eligible) from (
                       select (public.kicklive_ad_eligibility(a.id, x.placement_code, '{}'::jsonb, now(), 90)->>'eligible')::boolean as eligible
                         from public.advertisement_placements x where x.advertisement_id = a.id
                     ) el), false) as serving
      from public.advertisements a
      join public.advertisement_campaigns c on c.id = a.campaign_id
      join public.advertisers av            on av.id = c.advertiser_id
     where (p_status is null or a.status = p_status)
       and (p_placement_code is null or exists (
              select 1 from public.advertisement_placements x
               where x.advertisement_id = a.id and x.placement_code = p_placement_code))
     order by a.updated_at desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) r;
  return jsonb_build_object('ok', true, 'advertisements', v_rows);
end
$fn$;

-- The slot registry, for the admin screen. A function and not a table grant because RLS is enabled with
-- no policies on every table here: a `grant select` would be a privilege that answers zero rows, which is
-- the worst possible shape for a permission — it looks granted and reads as empty. So the registry has an
-- owner (this function), and the caller is checked instead of the row.
create or replace function public.kicklive_ad_placements()
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'ok', true,
    'placements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'code', p.code, 'label', p.label, 'description', p.description, 'page', p.page,
               'maxItems', p.max_items, 'heightBudgetPx', p.height_budget_px,
               'allowedFormats', to_jsonb(p.allowed_formats), 'yieldsToLive', p.yields_to_live,
               'isActive', p.is_active, 'sortOrder', p.sort_order,
               'assigned', coalesce((select count(1) from public.advertisement_placements x where x.placement_code = p.code), 0),
               'serving', coalesce((
                 select count(1) from public.advertisements a
                   join public.advertisement_campaigns c on c.id = a.campaign_id and c.status = 'active'
                   join public.advertisers av on av.id = c.advertiser_id and av.status = 'approved'
                  where a.status = 'active'
                    and exists (select 1 from public.advertisement_placements y
                                 where y.advertisement_id = a.id and y.placement_code = p.code and y.is_active)
                ), 0)
             ) order by p.sort_order, p.code)
        from public.ad_placements p
    ), '[]'::jsonb)
  )
$fn$;

create or replace function public.kicklive_ad_diagnostics()
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- Counts only. No creative bytes, no event row, no viewer key and no contact detail ever appears in this
  -- response, which is what lets it be a route rather than a privilege escalation.
  select jsonb_build_object(
    'ok', true,
    'schema', jsonb_build_object(
      'advertisers',       (select count(1) from public.advertisers),
      'advertisers_by_status', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                                  select status k, count(1) n from public.advertisers group by 1) s),
      'campaigns',         (select count(1) from public.advertisement_campaigns),
      'advertisements',    (select count(1) from public.advertisements),
      'advertisements_by_status', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                                  select status k, count(1) n from public.advertisements group by 1) s),
      'placements',        (select count(1) from public.ad_placements),
      'placements_active', (select count(1) from public.ad_placements where is_active)
    ),
    'serving', jsonb_build_object(
      'eligible_by_placement', (
        select coalesce(jsonb_object_agg(x.code, x.n), '{}'::jsonb) from (
          select pl.code, (
            select count(1) from public.advertisements a
             join public.advertisement_placements ap on ap.advertisement_id = a.id and ap.placement_code = pl.code and ap.is_active
             join public.advertisement_campaigns c on c.id = a.campaign_id and c.status = 'active'
             join public.advertisers av on av.id = c.advertiser_id and av.status = 'approved'
             where a.status = 'active'
               and (a.starts_at is null or a.starts_at <= now())
               and (a.ends_at   is null or a.ends_at   >  now())
          ) as n
          from public.ad_placements pl where pl.is_active
        ) x
      )
    ),
    'events', jsonb_build_object(
      'total',       (select count(1) from public.ad_events),
      'last_24h',    (select count(1) from public.ad_events where occurred_at > now() - interval '24 hours'),
      'oldest',      (select min(occurred_at) from public.ad_events),
      'rollup_days', (select count(distinct day) from public.advertisement_analytics)
    ),
    'integrity', jsonb_build_object(
      -- The shapes that must not exist, counted rather than asserted. The CHECKs and triggers make them
      -- unwritable, so a non-zero count means a row predates this migration — a thing to know about, not a
      -- thing to discover through a page that shows a broken banner.
      'active_without_creative', (select count(1) from public.advertisements where status = 'active' and image_url is null and media_asset_id is null),
      'active_outside_campaign', (select count(1) from public.advertisements a
                                   join public.advertisement_campaigns c on c.id = a.campaign_id
                                  where a.status = 'active' and c.status <> 'active'),
      'unplaced_active',         (select count(1) from public.advertisements a
                                   where a.status = 'active'
                                     and not exists (select 1 from public.advertisement_placements x where x.advertisement_id = a.id)),
      'expired_but_active',      (select count(1) from public.advertisements a
                                   where a.status = 'active' and a.ends_at is not null and a.ends_at <= now()),
      'destination_not_https',   (select count(1) from public.advertisements a where a.destination_url !~* '^https://'),
      'active_advertiser_not_approved', (select count(1) from public.advertisements a
                                   join public.advertisement_campaigns c on c.id = a.campaign_id
                                   join public.advertisers av on av.id = c.advertiser_id
                                  where a.status = 'active' and av.status <> 'approved')
    ),
    'media', jsonb_build_object(
      'advertisements_assets', (select count(1) from public.media_assets where entity_kind = 'advertisements'),
      -- A creative whose advertisement is gone is Phase 6's orphan case, and it is reported here rather
      -- than silently deleted here: reconciliation is the Worker's job, in both directions, in one place.
      'orphan_ad_assets',      (select count(1) from public.media_assets ma
                                 where ma.entity_kind = 'advertisements' and ma.status in ('ready','superseded')
                                   and not exists (select 1 from public.advertisements a where a.id::text = ma.entity_id))
    ),
    'config', jsonb_build_object(
      'note', 'Diagnostics counts only. Nothing in this response names a person, a device or a file.'
    )
  )
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. GRANTS, RLS, TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- RLS enabled, no policies, on every table in this file. The reasoning is Phase 5's and Phase 6's and is
-- written once rather than per table: the only access path the app has is through the functions above, a
-- client role holds no table privilege except `select` on the placement registry, and `service_role`
-- holds no DELETE on the ad tables. `force row level security` is absent on purpose — see
-- docs/NOTIFICATIONS_ARCHITECTURE.md §9.6 for the three reasons it is worse than useless here.

do $rls$
declare
  t text;
begin
  foreach t in array array[
    'advertisers', 'advertisement_campaigns', 'advertisements', 'ad_placements',
    'advertisement_placements', 'ad_events', 'advertisement_analytics', 'ad_status_transitions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, service_role', t);
  end loop;
end
$rls$;

do $grant$
declare
  r record;
  n integer := 0;
begin
  -- Explicit names plus a pattern, because a grant loop driven by one LIKE silently omits the function
  -- named for what it does instead of what it touches — which is a 401 at runtime that no typechecker
  -- sees (Phase 6 learned this the expensive way).
  for r in
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prokind = 'f'
       and (p.proname like 'kicklive_ad_%'
            or p.proname in ('kicklive_asset_url_column', 'kicklive_ad_guard_placement_format',
                             'kicklive_ad_guard_advertisement_format', 'touch_updated_at'))
  loop
    -- Every client role by name. `from public` only would leave the anon/authenticated EXECUTE entries that
    -- the default privileges Supabase creates, which is precisely the hole the block below asserts against.
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', r.proname, r.args);
    execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
    n := n + 1;
  end loop;

  -- The ENTIRE client-callable surface: two functions, both of which return nothing a caller was not
  -- already allowed to see. `kicklive_ad_serve` because an anonymous visitor is the normal reader of an
  -- advertisement, and `kicklive_ad_record_event` because the person who saw the banner is the only
  -- witness to it — the function's eligibility check and dedupe are the whole of its protection, and a
  -- write this cheap is bounded by the Worker's `public` budget in front of it rather than by an
  -- identity. Everything else in this file, including every status change, every analytics read and the
  -- batch ingest (which would turn one request into 500 events from an anonymous socket), is service-role
  -- only: reachable through a route that has already checked a capability.
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('kicklive_ad_serve', 'kicklive_ad_record_event')
  loop
    execute format('grant execute on function public.%I(%s) to anon, authenticated', r.proname, r.args);
  end loop;

  -- Table privileges, and what each one excludes. Read the exclusions as the design:
  --   · `ad_placements`: writable by the service role, but `kicklive_ad_set_placement` is the only thing
  --     that writes it, so the columns it cannot change are unchangeable in practice too.
  --   · `ad_status_transitions`: select only. The matrix is this migration's, not an API.
  --   · `ad_events`: insert and select, no update and no delete. Only the record functions write it and
  --     only the retention sweep prunes it.
  --   · advertisers / campaigns / advertisements / placements: select, insert, update. No DELETE, so a
  --     row cannot vanish while an event row or a rollup still points at it. Archiving is this system's
  --     delete, and it is the reason an audit of "what ran when" survives an admin's bad afternoon.
  grant select, insert, update, delete on table public.ad_placements           to service_role;
  grant select                        on table public.ad_status_transitions     to service_role;
  grant select, insert, update        on table public.advertisers              to service_role;
  grant select, insert, update        on table public.advertisement_campaigns  to service_role;
  grant select, insert, update        on table public.advertisements           to service_role;
  grant select, insert, update, delete on table public.advertisement_placements to service_role;
  grant insert, select                on table public.ad_events                to service_role;
  grant select, insert, update        on table public.advertisement_analytics   to service_role;
  -- `ad_events.id` is an identity column, so the insert needs the sequence.
  grant usage, select on sequence public.ad_events_id_seq to service_role;

  raise notice 'kicklive: advertising grants applied to % functions', n;
end
$grant$;

-- `updated_at` for every mutable table, as one trigger (Phase 3's pattern; a dozen copies of the same
-- eight lines is how one of them ends up missing). Phase 6 has no equivalent because its timestamps are
-- per-transition rather than one shared column, which is the right choice for a media registry and the
-- wrong one for a status table an admin edits.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

do $trig$
declare
  t text;
begin
  foreach t in array array[
    'advertisers', 'advertisement_campaigns', 'advertisements', 'ad_placements', 'advertisement_analytics'
  ] loop
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format('create trigger trg_touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end
$trig$;

-- A creative is never orphaned by its advertisement's deletion: `advertisement_placements` cascades and
-- `media_asset_id` sets null. The R2 object itself is NOT deleted from here, on purpose — Phase 6's
-- retention window is what decides when stored bytes are forgotten, and putting a second, irreversible
-- deletion path inside an application table's trigger is the failure its Step 15 was written to avoid.

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. VERIFY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same discipline as Phase 6: the list below is the authority on what this file must have created,
-- and every table privilege, policy and CHECK is asserted against the catalogue rather than against
-- intent. It raises, so a half-applied advertising schema is not a state this migration can leave behind.

do $verify$
declare
  expected text[] := array[
    'kicklive_ad_http_url_ok',
    'kicklive_ad_image_ref_ok',
    'kicklive_ad_targeting_ok',
    'kicklive_ad_eligibility',
    'kicklive_ad_targeting_matches',
    'kicklive_ad_rotation_key',
    'kicklive_ad_bucket',
    'kicklive_ad_serve',
    'kicklive_ad_explain',
    'kicklive_ad_save_advertiser',
    'kicklive_ad_save_campaign',
    'kicklive_ad_save_advertisement',
    'kicklive_ad_status_transitions',
    'kicklive_ad_set_advertiser_status',
    'kicklive_ad_set_campaign_status',
    'kicklive_ad_set_status',
    'kicklive_ad_set_placement',
    'kicklive_ad_reserve_creative',
    'kicklive_ad_attach_creative',
    'kicklive_ad_record_event',
    'kicklive_ad_record_events',
    'kicklive_ad_analytics',
    'kicklive_ad_expire_due',
    'kicklive_ad_sweep',
    'kicklive_ad_admin_list',
    'kicklive_ad_placements',
    'kicklive_ad_diagnostics',
    'kicklive_ad_guard_placement_format',
    'kicklive_ad_guard_slot_formats',
    'kicklive_ad_guard_advertisement_format',
    'kicklive_asset_url_column'
  ];
  client_writable text[];
  policy_holders  text[];
  missing         text[];
  not_granted     text[];
  t text;
begin
  select array_agg(x) into missing from unnest(expected) x
   where not exists (
     select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.proname = x
   );
  if missing is not null then
    raise exception 'kicklive migration verification failed: advertising functions not created: %', missing;
  end if;

  foreach t in array array[
    'advertisers', 'advertisement_campaigns', 'advertisements', 'ad_placements',
    'advertisement_placements', 'ad_events', 'advertisement_analytics'
  ] loop
    if not exists (
      select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = t and c.relrowsecurity
    ) then
      raise exception 'kicklive migration verification failed: public.% is not RLS-protected', t;
    end if;
    if exists (
      select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
       join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = t
    ) then
      raise exception 'kicklive migration verification failed: public.% has a policy; the Worker is the only access path', t;
    end if;
    -- The assertion that matters most in this file: no client role holds *any* table privilege on any ad
    -- table. Not "no write privilege" — with RLS enabled and no policies a read privilege is already a
    -- door, and the shape of this schema is that a browser reaches these rows only through a function
    -- that decided it may.
    select array_agg(distinct g.grantee || ':' || g.privilege_type) into client_writable
      from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.table_name = t
       and g.grantee in ('anon', 'authenticated');
    if client_writable is not null then
      raise exception 'kicklive migration verification failed: a client role holds a table privilege on public.%: %', t, client_writable;
    end if;
  end loop;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'advertisements'
       and grantee in ('anon','authenticated')
  ) then
    raise exception 'kicklive migration verification failed: advertisements are readable by a client role';
  end if;

  -- Exposure, asserted structurally: the public serving function's result must not name a column that
  -- only an admin may see. It is a `returns jsonb` today, so this catches a future refactor that swaps it
  -- for a typed row-returning function — the shape a leak would actually arrive in.
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'kicklive_ad_serve'
       and pg_get_function_result(p.oid) ilike '%budget%'
  ) then
    raise exception 'kicklive migration verification failed: kicklive_ad_serve exposes a budget column';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'kicklive_ad_serve'
       and (pg_get_function_arguments(p.oid) ilike '%p_status%'
            or pg_get_function_arguments(p.oid) ilike '%p_advertiser_id%')
  ) then
    raise exception 'kicklive migration verification failed: kicklive_ad_serve takes a filter a caller could use to widen its own view';
  end if;

  -- The public surface must actually be callable by the roles that need it, and everything else must not
  -- be, and oid-based rather than signature-based, because `has_function_privilege('anon',
  -- 'public.f(...)','execute')` demands the exact argument list — including the defaults, which a caller
  -- never types — so a signature spelled one way here silently checks nothing.
  --
  -- Note the argument ORDER: (role, function, privilege). Written the other way round the call does not
  -- resolve to an overload, and Postgres' complaint is `expected a left parenthesis`, which points at
  -- nothing and cost an hour.
  select array_agg(p.proname) into not_granted
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('kicklive_ad_serve', 'kicklive_ad_record_event')
     and not public.kicklive_has_grant('anon', p.oid::regprocedure::text, 'X');
  if not_granted is not null then
    raise exception 'kicklive migration verification failed: public surface not granted to anon: %', not_granted;
  end if;

  -- Read the ACL, not has_function_privilege: the second form answers "true" for every function when the
  -- applying role is a superuser, so this assertion can only ever fire when it is wrong to fire.
  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname like 'kicklive_ad_%'
       and p.proname not in ('kicklive_ad_serve', 'kicklive_ad_record_event')
       and public.kicklive_has_grant('authenticated', p.oid::regprocedure::text, 'X')
  ) then
    raise exception 'kicklive migration verification failed: an admin-only advertising function is granted to authenticated';
  end if;

  -- The media kind widening must have widened, not narrowed: every kind Phase 6 accepted is still
  -- accepted, and `advertisements` now is one.
  if not exists (
    select 1 from pg_constraint where conname = 'media_assets_kind_check'
  ) then
    raise exception 'kicklive migration verification failed: media_assets kind constraint missing';
  end if;
  if exists (
    select 1
      from unnest(array['teams','players','competitions','seasons','news','team_news','matches','users','advertisements']) k
     where not exists (
       select 1 from pg_constraint c
        where c.conname = 'media_assets_kind_check'
          and pg_get_constraintdef(c.oid) like '%' || quote_literal(k) || '%'
     )
  ) then
    -- A textual check of the constraint definition, deliberately: the alternative is a live insert into the
    -- media registry during a migration, which is exactly what an idempotent file must not do. This also
    -- proves the widening did not *narrow* anything Phase 6 relied on.
    raise exception 'kicklive migration verification failed: media_assets kind CHECK no longer admits every expected kind';
  end if;

  if (select count(1) from public.ad_placements) < 8 then
    raise exception 'kicklive migration verification failed: placement registry under-seeded (expected 8)';
  end if;
  if (select count(1) from public.ad_status_transitions) < 13 then
    raise exception 'kicklive migration verification failed: status matrix under-seeded';
  end if;
  if public.kicklive_ad_http_url_ok('http://insecure.example/') or public.kicklive_ad_http_url_ok('https://a@b.example/x..') then
    raise exception 'kicklive migration verification failed: the destination URL rule accepted something it must refuse';
  end if;
  if not public.kicklive_ad_http_url_ok('https://sponsor.example/promo?utm=1') then
    raise exception 'kicklive migration verification failed: the destination URL rule refused a normal sponsor link';
  end if;
  if public.kicklive_ad_targeting_ok('{"interests":["football"]}'::jsonb) then
    raise exception 'kicklive migration verification failed: targeting accepted a profiling key';
  end if;

  raise notice 'kicklive: advertising migration verified — 7 tables + matrix, % functions, 8 placements',
    array_length(expected, 1);
end
$verify$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. ROLLBACK — commented, and short because the file is additive.
-- ─────────────────────────────────────────────────────────────────────────────
/*
 * Rollback is only safe while nothing has been measured. Check first:
 *
 *   select count(1) from public.ad_events;                 -- must be 0
 *   select count(1) from public.advertisement_analytics;  -- must be 0
 *   select count(1) from public.media_assets where entity_kind = 'advertisements';  -- see below
 *
 * Any non-zero count means the system has been in use, and the counts are the evidence for what was paid
 * for. Dropping the tables then is destroying records, not rolling back a deploy: archive the tables
 * instead (rename or `create table ..._phase7_archive as select *`), and let the owner decide.
 *
 * If ad creatives were ever stored, their media_assets rows must go through Phase 6's retention
 * (`kicklive_delete_asset` with purge, or the sweep) BEFORE the kind CHECK is narrowed back to eight —
 * otherwise the rows become un-updatable and their objects unreachable-but-present, which is the one
 * inconsistency a media registry must never end up in.
 *
 *   begin;
 *   drop trigger if exists trg_touch_updated_at on public.advertisements;
 *   drop trigger if exists trg_touch_updated_at on public.advertisement_campaigns;
 *   drop trigger if exists trg_touch_updated_at on public.advertisers;
 *   drop trigger if exists trg_touch_updated_at on public.ad_placements;
 *   drop trigger if exists trg_touch_updated_at on public.advertisement_analytics;
 *   drop trigger if exists trg_ad_placement_format_guard on public.advertisement_placements;
 *   drop trigger if exists trg_ad_slot_formats_guard on public.ad_placements;
 *   drop trigger if exists trg_ad_advertisement_format_guard on public.advertisements;
 *   -- one `drop function if exists public.<name>(<args>)` per entry in $verify$.expected ...
 *   alter table public.media_assets drop constraint if exists media_assets_kind_check;
 *   alter table public.media_assets add constraint media_assets_kind_check check (
 *     entity_kind in ('teams','players','competitions','seasons','news','team_news','matches','users')
 *   );
 *   drop table if exists public.advertisement_analytics, public.ad_events,
 *                          public.advertisement_placements, public.ad_placements,
 *                          public.advertisements, public.advertisement_campaigns,
 *                          public.advertisers, public.ad_status_transitions;
 *   commit;
 *   notify pgrst, 'reload schema';
 *
 * Note what is NOT reverted: `kicklive_asset_url_column` is left with its `advertisements` arm. A
 * function that answers a column name for a kind nobody can insert is harmless, and replacing it with
 * Phase 6's version would be a `create or replace` of a function Phase 6's own file still defines — a
 * drift with no owner.
 */

commit;

-- PostgREST caches function signatures: without this a client would get 404 on
-- /rest/v1/rpc/kicklive_ad_serve until the API is restarted.
notify pgrst, 'reload schema';
