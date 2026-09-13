-- ============================================================================
-- KICK LIVE · Phase 8 · sponsorship
-- ----------------------------------------------------------------------------
-- A sponsor is not an advertiser, and this file is the argument for keeping the two systems apart.
--
--   An ADVERTISEMENT buys a slot. It is scheduled by the second, measured by the impression, rotated by
--   weight against other creatives in the same slot, and it disappears the moment it stops being paid for.
--   Phase 7 built that machine (`advertisers`, `advertisement_campaigns`, `advertisements`, `ad_placements`).
--
--   A SPONSORSHIP is a right. It is a relationship between a brand and a *thing the competition office
--   recognises* — a competition, a season, a match, a team, an award, an event — it lasts a season rather
--   than a fortnight, it is displayed because the contract says so and not because a rota came round, and
--   being the title sponsor of a cup is not something another bidder can out-weight. There is no rotation
--   here, no auction, no impression cap and no click. If those words appear in a sponsorship file, the
--   design has been confused with the other one.
--
-- So: separate tables, separate status machines, separate caches, one shared media plane. `docs/
-- PRODUCTION_ARCHITECTURE.md` §14 specified this split before either existed, including the seam — "a
-- package may include placements: the link is `sponsorship_id` → generated campaign rows, not shared
-- columns" — and the link column is here (`sponsorships.advertisement_campaign_id`), deliberately written
-- by nobody in this migration: generating a flight from a rights package is Phase 9's job, and a column
-- with a foreign key is a seam, while a copy of the other system's columns would be a merger.
--
-- What a sponsor's own record holds (steps 2 and 13 of the brief):
--   · a brand (`display_name`) and, separately, the organisation behind it (`legal_name`) — the name on the
--     shirt and the name on the contract are different fields because they are different facts;
--   · private contact (`contact_name`, `contact_email`, `contact_phone`) that the public projection never
--     reads, not "never returns" — see the note on `kicklive_sponsorship_for`;
--   · five agreement fields (`value_amount`, `value_currency`, `value_basis`, `invoice_reference`,
--     `renewal_terms`) as *text the desk typed*. There is no ledger, no invoice table, no tax or bank
--     column, and no column that could hold one. Step 13 asks for structures that a future billing system
--     can attach to; the way to grant that without building it is to store what a contract already states
--     and to keep the money in the contract until somebody has to reconcile it.
--
-- Media (step 6): sponsor logos and banners go to the Phase 6 R2 plane, keyed under the `sponsors/` prefix
-- that Phase 6 reserved and refused to activate until a table existed to own the rows. This migration
-- creates that table and widens `media_assets_kind_check` in the same file, which is precisely what
-- Phase 6's comment asked for. Nothing here stores bytes.
--
-- Expiry (step 5) is enforced twice on purpose: the serving query filters on the window, so an expired
-- sponsorship stops appearing within one cache lifetime (max-age is short and said so below); and
-- `kicklive_sponsorship_expire_due` moves the *status* so the admin screen, the counts and any future
-- report stop claiming it is live. The first is what a viewer sees; the second is what an operator can
-- trust. A schedule cannot be a display rule.
--
-- Cache invalidation (step 11) has a real answer rather than a hopeful one: every write in this file bumps
-- `sponsorship_config.epoch`, and the public read carries that epoch. An edge entry is valid while the
-- epoch it was built under is current, so an activation is visible on the next request that can tell the
-- difference — and the browser's own Phase 4 cache is invalidated by tag from the admin mutation, which is
-- the only invalidation that can be synchronous because it is the only one in the same process.
--
-- Apply with `supabase db push`. It is additive: no table is dropped, no column is dropped, and the one
-- `alter table` touches a CHECK constraint on `media_assets` by replacing it with a superset. With this
-- migration applied and zero rows written, every public page is byte-identical to yesterday: `sponsorships`
-- is empty, so `kicklive_sponsorship_for` answers `{}` and the slots render nothing at all.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0 · the validation primitives
--
-- IMMUTABLE and expression-only, because a table CHECK may not contain a subquery or read the clock and
-- these are called from CHECKs. Anything that has to *look something up* is a trigger instead (§6).
-- ----------------------------------------------------------------------------

-- The https rule is Phase 7's, and it is *delegated* rather than copied. The reason is the same one that
-- makes two implementations of a cache policy a mistake: a sponsor's link and an advertiser's destination are
-- the same hazard — a string that becomes an `href` — and two rules drift the moment one of them is
-- tightened. Phase 7's `kicklive_ad_http_url_ok` is the owner of that rule; the flow test behind it (`https://kicklive.football@evil.test/` refused,
-- no second colon, no protocol-relative form, no `..`), so sponsorship inherits that instead of re-deriving
-- a weaker one. `docs/SPONSORSHIP_ARCHITECTURE.md` §7 names the owner.
create or replace function public.kicklive_sponsor_https_ok(p_url text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select public.kicklive_ad_http_url_ok(p_url)
$fn$;

-- A target kind is a closed list — it decides which table an id is resolved against, and a value that
-- resolves nothing would be a sponsorship attached to nothing. The *packages* are open (step 3); this is
-- not that.
create or replace function public.kicklive_sponsor_target_kind_ok(p_kind text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_kind = any (array['competition', 'season', 'match', 'team', 'award', 'event'])
$fn$;

-- An entity id per kind: `competition`/`season`/`team`/`match` are integer keys in this schema, and
-- `award`/`event` do not have tables yet, so they take a slug. One regex, stated once, used by both the
-- CHECK and the guard trigger.
create or replace function public.kicklive_sponsor_target_id_ok(p_kind text, p_id text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_id is not null and case
    when p_kind in ('competition', 'season', 'team', 'match') then p_id ~ '^[1-9][0-9]{0,9}$'
    -- An award or an event is named by whoever creates it, so it is a slug rather than a row: the only
    -- requirement is that it is stable enough to be a cache key and boring enough to put in a URL.
    else p_id ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  end
$fn$;

-- Every numeric field is cast out of JSON text, and a bad cast raises rather than refuses. One helper,
-- three writers, and the answer names the field: an empty string is "absent" (the forms send one), a number
-- or a numeric string is accepted, and anything else is refused before it reaches a cast.
-- A date the client typed: shape checked here, calendar sense checked by the cast below. Both, rather than a
-- bare `::date`, because `{"endsAt": "2026-02-30"}` would otherwise raise `date/time field value out of
-- range` out of a definer function, and the Worker can only report that as a 502. A wrong form is a field
-- error, and the client has to be told which field.
create or replace function public.kicklive_sponsor_date_ok(p_value text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_value is null or p_value ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
$fn$;

create or replace function public.kicklive_sponsor_field_refuses(p_data jsonb, p_keys text[])
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select k.x
    from unnest(coalesce(p_keys, array[]::text[])) k(x)
   where p_data ? k.x
     and coalesce(p_data ->> k.x, '') <> ''
     and p_data ->> k.x !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
   limit 1
$fn$;

-- A label a viewer will read: no control characters, no markup, and short enough to fit the band. Note
-- what is *not* checked: the words. "Official Partner" is a claim about a relationship, and the only
-- defence against an inflationary one is a human approving it, which is what `status` is for.
create or replace function public.kicklive_sponsor_label_ok(p_label text, p_max integer default 120)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_label is null
      or (
        char_length(btrim(p_label)) between 1 and coalesce(p_max, 120)
        and p_label !~ '[[:cntrl:]]'
        and p_label not like '%<%'
        and p_label not like '%>%'
      )
$fn$;

-- The entitlement keys a package may promise, and the shape each must have. A closed set, for the reason
-- Phase 7's targeting keys are closed: the renderer is the far end of this, and a free-form bag of
-- properties turns every consumer into a try/catch. New entitlements are added here, which is a
-- deliberate change to what a sponsor can be promised.
-- Every entitlement is checked with a `case`, not with a chain of `and`/`or`. The difference is not style:
-- written as `a and b in (…) or not c and d in (…) or not c`, Postgres' precedence (`and` before `or`) makes
-- the whole expression true as soon as *any one* optional key is absent — which is every package that does
-- not set all ten. That accepted `{"tracks_pixels": true}` silently, and a validator that returns true for
-- garbage is worse than no validator, because the caller stops asking. Each clause below is one key, one
-- shape, and an explicit `else true`.
create or replace function public.kicklive_sponsor_entitlements_ok(p_doc jsonb)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $fn$
  select p_doc is null
      or (
        jsonb_typeof(p_doc) = 'object'
        -- No unknown keys. This is the half that protects the renderer: it may switch on a name and treat
        -- anything else as absent, which is only safe if nothing else can be stored.
        and not exists (
          select 1 from jsonb_object_keys(p_doc) k(name)
           where k.name not in (
             'logo_on_screen', 'logo_size', 'banner_on_page', 'mentions_per_match',
             'ad_flight', 'auto_flight', 'priority_default', 'max_per_target',
             'requires_exclusivity', 'naming_rights', 'award_citation'
           )
        )
        and case when p_doc ? 'logo_on_screen'    then p_doc->>'logo_on_screen'    in ('true','false') else true end
        and case when p_doc ? 'banner_on_page'     then p_doc->>'banner_on_page'     in ('true','false') else true end
        and case when p_doc ? 'ad_flight'          then p_doc->>'ad_flight'          in ('true','false') else true end
        and case when p_doc ? 'auto_flight'        then p_doc->>'auto_flight'        in ('true','false') else true end
        and case when p_doc ? 'naming_rights'      then p_doc->>'naming_rights'      in ('true','false') else true end
        and case when p_doc ? 'award_citation'     then p_doc->>'award_citation'     in ('true','false') else true end
        and case when p_doc ? 'requires_exclusivity' then p_doc->>'requires_exclusivity' in ('true','false') else true end
        and case when p_doc ? 'logo_size'          then p_doc->>'logo_size'          in ('small','medium','large') else true end
        and case when p_doc ? 'mentions_per_match' then p_doc->>'mentions_per_match' ~ '^[0-9]$' else true end
        and case when p_doc ? 'priority_default'   then p_doc->>'priority_default'   ~ '^[0-9]{1,4}$' else true end
        and case when p_doc ? 'max_per_target'     then p_doc->>'max_per_target'     ~ '^[0-9]{1,3}$' else true end
      )
$fn$;
-- The above is checked with a full-table scan of the *keys*, not the values, on every write of a package —
-- and packages are written perhaps ten times a season, so the shape of the predicate is not a cost here.

comment on function public.kicklive_sponsor_entitlements_ok(jsonb) is 'Closed entitlement vocabulary. `auto_flight` is reserved for Phase 9 and is deliberately present now: a package that can promise a generated ad flight has to say so before the code exists that writes one, because the alternative is a migration that silently changes what old packages mean.';

-- ----------------------------------------------------------------------------
-- 1 · sponsors
-- ----------------------------------------------------------------------------

create table if not exists public.sponsors (
  id              uuid          primary key default gen_random_uuid(),
  -- The slug is the public handle: `/sponsor/acme`, and the cache key half of every sponsorship read. Once
  -- a sponsorship row or a page link exists it cannot change, which is enforced by a trigger (§6) because
  -- a CHECK cannot look up whether anybody is referring to the old value.
  slug            text          not null,
  display_name    text          not null,
  legal_name      text,
  description     text          check (description is null or char_length(description) <= 600),
  website_url     text          check (public.kicklive_sponsor_https_ok(website_url)),
  status          text          not null default 'draft'
                                constraint sponsors_status_check
                                check (status in ('draft', 'pending', 'approved', 'suspended', 'archived')),
  -- Private (§10): present in the admin list, absent from every projection the browser can reach. The
  -- phone is a business number, not a personal one, and it is still not public.
  contact_name    text          check (contact_name is null or char_length(contact_name) <= 120),
  contact_email   text          check (contact_email is null or (char_length(contact_email) <= 320 and contact_email ~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]{2,}$')),
  contact_phone   text          check (contact_phone is null or (char_length(contact_phone) <= 32 and contact_phone ~ '^[+0-9 ()./-]{6,}$')),
  contact_consent_at timestamptz,
  -- The brand kit. `logo_url`/`banner_url` hold `/api/media/assets/<key>` paths written by the media plane
  -- and nothing else — a hand-typed absolute URL is how a sponsor's logo ends up hotlinked from a domain
  -- nobody owns. `image_ref`-style allowances live in §7's attach function, not in a CHECK.
  logo_url        text,
  banner_url      text,
  logo_asset_id   bigint        references public.media_assets(id) on delete set null,
  banner_asset_id bigint        references public.media_assets(id) on delete set null,
  brand_colour    text          check (brand_colour is null or brand_colour ~* '^#[0-9a-f]{6}$'),
  on_dark         boolean       not null default false,
  -- Step 8, and the whole of it: an integer a human sets, and the number the renderer sorts by. Not a bid,
  -- not a price, not recomputed from engagement. Default 100 so a new relationship sits in the middle
  -- rather than at the top by accident.
  default_priority smallint     not null default 100 check (default_priority between 0 and 9999),
  -- Agreement fields (§13). Text and a number, never an instrument: no account, no IBAN, no card, no tax id.
  value_amount    numeric(12,2) check (value_amount is null or value_amount >= 0),
  value_currency  text          check (value_currency is null or value_currency ~ '^[A-Z]{3}$'),
  value_basis     text          check (value_basis is null or value_basis in ('negotiated', 'per_season', 'per_match', 'per_month')),
  invoice_reference text        check (invoice_reference is null or char_length(invoice_reference) <= 64),
  renewal_terms   text          check (renewal_terms is null or char_length(renewal_terms) <= 1000),
  internal_notes  text          check (internal_notes is null or char_length(internal_notes) <= 2000),
  approved_by     uuid          references public.profiles(id) on delete set null,
  approved_at     timestamptz,
  created_by      uuid          references public.profiles(id) on delete set null,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint sponsors_slug_check      check (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  constraint sponsors_display_name_check check (public.kicklive_sponsor_label_ok(display_name, 120)),
  constraint sponsors_legal_name_check     check (public.kicklive_sponsor_label_ok(legal_name, 200)),
  -- Approval is a fact about a person and a moment, so it is recorded as one pair: no row reaches
  -- `approved` without a named approver. `approved_at` without `approved_by` is what a data import looks
  -- like, and an import should not be able to launder an approval.
  constraint sponsors_approval_recorded check (
    status <> 'approved' or (approved_by is not null and approved_at is not null)
  ),
  -- A logo slot may hold a URL only alongside the asset that produced it, or with neither. The pair is
  -- what makes `kicklive_sponsorship_diagnostics`' orphan count mean something.
  constraint sponsors_logo_pair_check check (
    (logo_url is null or logo_asset_id is not null)
    and (banner_url is null or banner_asset_id is not null)
  )
);
create unique index if not exists sponsors_slug_key on public.sponsors (slug);
create unique index if not exists sponsors_display_name_active_key on public.sponsors (lower(display_name))
  where status <> 'archived';
create index if not exists sponsors_status_idx on public.sponsors (status, default_priority);

comment on table public.sponsors is 'A brand with rights. Phase 7 `advertisers` is the paid-placement equivalent and is deliberately a different table: an advertiser buys a slot for a fortnight, a sponsor is associated with the competition, and the two sets of fields (rotation weights vs. season and exclusivity) do not overlap enough to share a row.';
comment on column public.sponsors.contact_email is 'Private. Excluded from every projection a browser can reach, by not being named in it (§7).';
comment on column public.sponsors.value_amount is 'What the contract says, to the kobo. Not a ledger: no invoice, no payment, no balance, and no column that could hold one.';

-- ----------------------------------------------------------------------------
-- 2 · sponsorship packages (step 3: configurable, seeded, not enumerated)
-- ----------------------------------------------------------------------------

create table if not exists public.sponsorship_packages (
  id              uuid          primary key default gen_random_uuid(),
  -- `code` is the stable name and `label` is the display one, so renaming "MAIN SPONSOR" to "PREMIER
  -- PARTNER" is a label edit that breaks no reference. Both are free text within shape limits — the brief's
  -- requirement is that the names are configurable, which a CHECK over six literals would have quietly
  -- contradicted.
  code            text          not null,
  label           text          not null,
  description     text          check (description is null or char_length(description) <= 500),
  -- What kind of relationship this is, for filtering and for the renderer's wording. Free-form within a
  -- shape, and seeded with the brief's six.
  kind            text          not null,
  tier            smallint      not null default 3 check (tier between 1 and 9),
  season_label    text          check (season_label is null or char_length(season_label) <= 24),
  exclusivity     text          not null default 'none'
                                constraint sponsorship_packages_exclusivity_check
                                check (exclusivity in ('none', 'category', 'package', 'exclusive')),
  entitlements    jsonb         not null default '{}'::jsonb check (public.kicklive_sponsor_entitlements_ok(entitlements)),
  -- Ordering *of the packages themselves* in a picker; `sponsorships.priority` is the ordering on the page.
  sort_order      smallint      not null default 100,
  is_active       boolean       not null default true,
  -- Price, again as a stated intention rather than a bill (step 13).
  price_amount    numeric(12,2) check (price_amount is null or price_amount >= 0),
  price_currency  text          check (price_currency is null or price_currency ~ '^[A-Z]{3}$'),
  price_basis     text          check (price_basis is null or price_basis in ('negotiated', 'per_season', 'per_match', 'per_month', 'one_off')),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  constraint sponsorship_packages_code_check  check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint sponsorship_packages_kind_check  check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint sponsorship_packages_label_check check (public.kicklive_sponsor_label_ok(label, 80)),
  -- What a package may be sold against. A closed set, because it decides which `target_kind` values an
  -- assignment may use for this package — the pair (package kind, target kind) is checked in §5's save.
  allowed_target_kinds text[]   not null default array['competition','season','match','team','award','event']::text[]
                                check (array_length(allowed_target_kinds, 1) between 1 and 6)
);
create unique index if not exists sponsorship_packages_code_key on public.sponsorship_packages (code);
create index if not exists sponsorship_packages_active_idx on public.sponsorship_packages (is_active, sort_order, tier);

comment on table public.sponsorship_packages is 'The rate card. Names are data, not code: nothing in the Worker or the SPA switches on a package code, and the six seeded rows are the brief''s examples rather than an enum.';

insert into public.sponsorship_packages (code, label, kind, tier, exclusivity, sort_order, description, allowed_target_kinds, entitlements)
values
  ('title',        'Title Sponsor',   'title',        1, 'exclusive', 10,
   'The name on the competition. Highest placement, one per target, and the only package whose entitlement set includes naming rights.',
   array['competition','season','event']::text[],
   '{"logo_on_screen": true, "logo_size": "large", "banner_on_page": true, "naming_rights": true, "mentions_per_match": 6, "requires_exclusivity": true, "max_per_target": 1, "priority_default": 10}'::jsonb),
  ('main',         'Main Sponsor',      'main',         2, 'category',  20,
   'Shared top billing alongside the title sponsor, in a different commercial category.',
   array['competition','season','event']::text[],
   '{"logo_on_screen": true, "logo_size": "medium", "banner_on_page": true, "mentions_per_match": 3, "requires_exclusivity": true, "max_per_target": 3, "priority_default": 40}'::jsonb),
  ('match',        'Match Sponsor',     'match',        3, 'none',      30,
   'One fixture. Shown on the match page and read out around kickoff.',
   array['match']::text[],
   '{"logo_on_screen": true, "logo_size": "medium", "banner_on_page": false, "mentions_per_match": 2, "requires_exclusivity": false, "max_per_target": 4, "priority_default": 70}'::jsonb),
  ('team',         'Team Sponsor',      'team',         4, 'category',  40,
   'Attached to a club, so it follows the club across competitions and renders wherever a crest renders.',
   array['team']::text[],
   '{"logo_on_screen": true, "logo_size": "small", "banner_on_page": true, "mentions_per_match": 1, "requires_exclusivity": true, "max_per_target": 2, "priority_default": 80}'::jsonb),
  ('award',        'Award Sponsor',     'award',        5, 'package',   50,
   'Named with a trophy or an individual award, and cited when the award is presented.',
   array['award','event']::text[],
   '{"logo_on_screen": true, "logo_size": "small", "award_citation": true, "requires_exclusivity": true, "max_per_target": 1, "priority_default": 60}'::jsonb),
  ('media_partner','Media Partner',     'media_partner', 6, 'none',      60,
   'Exchange of reach rather than money: the partner carries us, we carry their logo. No price, and the public band is smaller.',
   array['competition','season','match','event']::text[],
   '{"logo_on_screen": false, "logo_size": "small", "banner_on_page": false, "requires_exclusivity": false, "max_per_target": 8, "priority_default": 200}'::jsonb)
on conflict (code) do nothing;

-- ----------------------------------------------------------------------------
-- 3 · sponsorships (step 4: one relationship table, not six)
-- ----------------------------------------------------------------------------

create table if not exists public.sponsorships (
  id              uuid          primary key default gen_random_uuid(),
  sponsor_id      uuid          not null references public.sponsors(id) on delete restrict,
  package_id      uuid          not null references public.sponsorship_packages(id) on delete restrict,
  -- The polymorphic pair. Six separate tables (sponsorship_competitions, sponsorship_teams, …) would each
  -- need their own status machine, their own expiry pass, their own admin screen and their own leak; and
  -- "what is showing on this page" would become a union of six queries. One pair of columns, resolved by a
  -- function that knows which table each kind means, costs one trigger instead.
  target_kind     text          not null check (public.kicklive_sponsor_target_kind_ok(target_kind)),
  target_id       text          not null,
  -- `starts_at`/`ends_at` are DATEs, not timestamps: a sponsorship is bought by the day and a half-day
  -- boundary in UTC is how a "season" becomes an argument at 23:30 local time.
  starts_at       date          not null,
  ends_at         date          not null,
  status          text          not null default 'draft'
                                constraint sponsorships_status_check
                                check (status in ('draft', 'scheduled', 'active', 'paused', 'ended', 'archived')),
  -- The display switch. Distinct from `status` for the same reason `ad_placements.is_active` is: an
  -- operator must be able to take a live sponsorship off the site without editing the contract's state,
  -- and put it back without re-approval.
  is_active       boolean       not null default false,
  activated_by    uuid          references public.profiles(id) on delete set null,
  activated_at    timestamptz,
  -- Step 8: controlled order, nothing else. Lower priority sorts first; equal priorities fall back to the
  -- assignment date so the order is stable rather than whatever the planner produced.
  priority        smallint      not null default 100 check (priority between 0 and 9999),
  display_order   integer       not null default 0 check (display_order between 0 and 999999),
  -- What the page says, verbatim, in the sponsor's words as approved. Kept per assignment rather than on the
  -- sponsor because a title sponsorship and a match sponsorship do not describe the same relationship.
  attribution     text          check (public.kicklive_sponsor_label_ok(attribution, 160)),
  -- `naming_override` is how "the Cup, presented by X" is done without touching `competitions.name`:
  -- the canonical name stays the canonical name, and a display label is a display label.
  naming_override text          check (public.kicklive_sponsor_label_ok(naming_override, 120)),
  -- Per-placement branding overrides (step 6), so a dark stadium banner and a light archive page can carry
  -- the right artwork without the sponsor's record holding two versions of the truth.
  logo_asset_id   bigint        references public.media_assets(id) on delete set null,
  banner_asset_id bigint        references public.media_assets(id) on delete set null,
  logo_variant    text          check (logo_variant is null or logo_variant in ('default', 'mono', 'light', 'dark')),
  background_colour text        check (background_colour is null or background_colour ~* '^#[0-9a-f]{6}$'),
  link_url        text          check (link_url is null or public.kicklive_sponsor_https_ok(link_url)),
  -- The Phase 9 seam (see the header): a package may generate an advertising flight, and this is where the
  -- generated one is remembered. Nullable, written by nobody today, and `on delete set null` so removing
  -- a campaign can never delete a contract.
  advertisement_campaign_id uuid references public.advertisement_campaigns(id) on delete set null,
  -- §13 again: what the paperwork says, not what the bank says.
  value_amount    numeric(12,2) check (value_amount is null or value_amount >= 0),
  value_currency  text          check (value_currency is null or value_currency ~ '^[A-Z]{3}$'),
  value_basis     text          check (value_basis is null or value_basis in ('negotiated', 'per_season', 'per_match', 'per_month')),
  invoice_reference text        check (invoice_reference is null or char_length(invoice_reference) <= 64),
  renewal_terms   text          check (renewal_terms is null or char_length(renewal_terms) <= 1000),
  internal_notes  text          check (internal_notes is null or char_length(internal_notes) <= 2000),
  activation_error text,
  created_by      uuid          references public.profiles(id) on delete set null,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  -- Only rules that can be true without looking anything up live here. "The sponsor is approved", "the
  -- package allows this kind", "the exclusivity slot is free" are §5 and §6 work, because each needs a
  -- second table and a CHECK may not read one.
  constraint sponsorships_window_ordered check (ends_at >= starts_at),
  constraint sponsorships_target_id_check check (public.kicklive_sponsor_target_id_ok(target_kind, target_id))
);
create index if not exists sponsorships_target_idx on public.sponsorships (target_kind, target_id, status, priority, display_order);
create index if not exists sponsorships_sponsor_idx on public.sponsorships (sponsor_id, status, ends_at);
create index if not exists sponsorships_expiry_idx on public.sponsorships (ends_at) where status in ('scheduled', 'active');
-- The double-booking guard, as an index rather than a trigger: the same sponsor may not hold the same
-- package against the same target for two windows starting on the same day, which is what a re-typed
-- renewal looks like in this table. Partial on purpose — an archived row must stay to explain history.
create unique index if not exists sponsorships_no_duplicate_key
  on public.sponsorships (sponsor_id, package_id, target_kind, target_id, starts_at)
  where status <> 'archived';

comment on column public.sponsorships.target_id is 'Text, because ids in this schema are not one type (competitions are integer, awards do not have a table). `kicklive_sponsor_target_exists` is what gives it meaning.';
comment on column public.sponsorships.advertisement_campaign_id is 'The documented seam to Phase 7. Nothing writes it in this migration; a generated flight is linked here so the two systems stay joinable without becoming one.';

-- ----------------------------------------------------------------------------
-- 4 · the status machine (Phase 7's lesson, applied with a `kind` column)
-- ----------------------------------------------------------------------------

create table if not exists public.sponsorship_status_transitions (
  kind        text        not null check (kind in ('sponsor', 'sponsorship')),
  from_status text        not null,
  to_status   text        not null,
  note        text,
  primary key (kind, from_status, to_status)
);

-- Read as `exists (kind, from, to)`: an absent row is a prohibition, so a row must never be inserted to
-- document something that is forbidden (Phase 7 learned that the hard way).
insert into public.sponsorship_status_transitions (kind, from_status, to_status, note) values
  ('sponsor', 'draft',     'pending',   'submitted for approval'),
  ('sponsor', 'draft',     'archived',  'nothing signed'),
  ('sponsor', 'pending',   'draft',     'back to editing'),
  ('sponsor', 'pending',   'approved',  'the approval act; stamps approved_by/at'),
  ('sponsor', 'pending',   'archived',  'declined'),
  ('sponsor', 'approved',  'suspended', 'refused new placements; existing ones are paused by the cascade'),
  ('sponsor', 'approved',  'archived',  'relationship over'),
  ('sponsor', 'suspended', 'approved',  'reinstatement is an explicit admin act, not a timeout'),
  ('sponsor', 'suspended', 'archived',  null),
  ('sponsorship', 'draft',     'scheduled', 'agreed and dated; not displaying yet'),
  ('sponsorship', 'draft',     'archived',  null),
  ('sponsorship', 'scheduled', 'active',    'the display act; preconditions run here'),
  ('sponsorship', 'scheduled', 'draft',     'back to editing'),
  ('sponsorship', 'scheduled', 'archived',  'cancelled before it ran'),
  ('sponsorship', 'active',    'paused',    'off the site immediately, contract intact'),
  ('sponsorship', 'active',    'ended',     'normal end of term (also set by kicklive_sponsorship_expire_due)'),
  ('sponsorship', 'active',    'archived',  'withdrawn'),
  ('sponsorship', 'paused',    'active',    're-activation re-runs the preconditions'),
  ('sponsorship', 'paused',    'ended',     null),
  ('sponsorship', 'paused',    'archived',  null),
  ('sponsorship', 'ended',     'active',    'a renewal inside the same window; the clock has to allow it'),
  ('sponsorship', 'ended',     'archived',  null)
on conflict (kind, from_status, to_status) do nothing;

comment on table public.sponsorship_status_transitions is 'Two machines in one table, discriminated by `kind`: a sponsor (the brand) and a sponsorship (one placement of that brand) are different lifecycles, and sharing arcs between them is how "archived sponsor can be re-approved" appears in a system that never meant to allow it.';

-- ----------------------------------------------------------------------------
-- 5 · the config row: an epoch for cache invalidation
-- ----------------------------------------------------------------------------

create table if not exists public.sponsorship_config (
  id          smallint primary key check (id = 1),
  epoch       bigint   not null default 1,
  updated_at  timestamptz not null default now(),
  constraint sponsorship_config_singleton check (id = 1)
);
insert into public.sponsorship_config (id, epoch) values (1, 1) on conflict (id) do nothing;

comment on table public.sponsorship_config is 'One row, one counter. Every write that changes what a viewer would see bumps it, and the public read carries it. Without it, "invalidate the cache when the configuration changes" needs a purge API credential in the Worker for one image; with it, an edge entry can be checked against the state of the data that produced it, and the browser''s own cache is tagged and invalidated from the mutation (§11).';

-- ----------------------------------------------------------------------------
-- 6 · triggers
-- ----------------------------------------------------------------------------

create or replace function public.kicklive_sponsor_guard_target()
returns trigger
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
begin
  -- `award` and `event` have no table yet, and that is a decision rather than an omission: a rights record
  -- for "Goal of the Month" must exist before there is a row to point at, and a foreign key to a table that
  -- does not exist would have forced one to be created with the wrong shape. Those two kinds are therefore
  -- validated for *format* only (§0), and the four that do have tables are validated for existence.
  if new.target_kind in ('award', 'event') then
    return new;
  end if;
  if not public.kicklive_sponsor_target_exists(new.target_kind, new.target_id) then
    raise exception 'sponsorship target %/% does not exist', new.target_kind, new.target_id
      using hint = 'the sponsor cannot be associated with a ' || new.target_kind || ' that is not in the database';
  end if;
  return new;
end
$fn$;

create or replace function public.kicklive_sponsor_target_exists(p_kind text, p_id text)
returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- One function, four tables, and no dynamic SQL: a `format('… from %I', …)` built from a user value is
  -- how a lookup function turns into an injection sink, and the set of kinds is closed above anyway.
  select case p_kind
    when 'competition' then exists (select 1 from public.competitions c  where c.id::text = p_id)
    when 'season'      then exists (select 1 from public.seasons s       where s.id::text = p_id)
    when 'team'        then exists (select 1 from public.teams t         where t.id::text = p_id)
    when 'match'       then exists (select 1 from public.matches m       where m.id::text = p_id)
    else false
  end
$fn$;
-- A correction worth keeping in the file, because the reasoning was wrong in a way that a reviewer would
-- otherwise have to rediscover: an earlier draft of this function pointed `season` at `competitions`, on the
-- assertion that the schema has no seasons table. It does — `public.seasons`, which `matches.season_id`
-- already references. Pointing a sponsorship at `competitions.season`, a free-text label, would have meant
-- the competition office renaming "2025/26" to "2025-26" and every title sponsorship silently detaching from
-- the thing it pays for. Ids are the only durable join in this schema, and `target_kind` exists precisely so
-- each kind can be aimed at the table that owns it.

-- The drop carries the *trigger's* name, not the function's, and the difference is the whole failure mode: `drop
-- trigger if exists <function_name>` is a successful no-op, so the create below it fails on a re-run. The
-- names are kept visibly paired (`…_guard_target` → `sponsorships_guard_target`) so the pairing can be read.
drop trigger if exists sponsorships_guard_target on public.sponsorships;
create trigger sponsorships_guard_target
  before insert or update of target_kind, target_id on public.sponsorships
  for each row execute function public.kicklive_sponsor_guard_target();

-- A slug is a URL and a cache key. Once referenced it is immutable, and the reason to enforce that in the
-- database rather than in the form is that the form is not the only writer.
create or replace function public.kicklive_sponsor_guard_slug()
returns trigger
language plpgsql volatile
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if new.slug is distinct from old.slug then
    raise exception 'sponsor slug is immutable once created'
      using hint = 'archive this sponsor and create a new one; a renamed slug breaks every page link and every cached read that used the old one';
  end if;
  return new;
end
$fn$;

drop trigger if exists sponsors_guard_slug on public.sponsors;
create trigger sponsors_guard_slug
  before update of slug on public.sponsors
  for each row execute function public.kicklive_sponsor_guard_slug();

-- A package code is the same kind of promise: `allowed_target_kinds` and `entitlements` may change (that is
-- what re-pricing a package is), but the identifier may not be recycled under an existing assignment.
create or replace function public.kicklive_sponsor_guard_package_code()
returns trigger
language plpgsql volatile
security invoker
set search_path = public, pg_temp
as $fn$
begin
  if new.code is distinct from old.code and exists (
    select 1 from public.sponsorships s where s.package_id = old.id
  ) then
    raise exception 'package % is referenced by % sponsorship(s) and cannot be renamed', old.code, (
      select count(1) from public.sponsorships s where s.package_id = old.id
    );
  end if;
  if not new.is_active and exists (
    select 1 from public.sponsorships s where s.package_id = old.id and s.status in ('scheduled', 'active')
  ) then
    raise exception 'package % still has scheduled or active sponsorships; end those first', new.code;
  end if;
  return new;
end
$fn$;

drop trigger if exists sponsorship_packages_guard_code on public.sponsorship_packages;
create trigger sponsorship_packages_guard_code
  before update on public.sponsorship_packages
  for each row execute function public.kicklive_sponsor_guard_package_code();

-- `updated_at`, same helper every phase has used since Phase 1.
drop trigger if exists sponsors_touch_updated_at on public.sponsors;
create trigger sponsors_touch_updated_at
  before update on public.sponsors
  for each row execute function public.touch_updated_at();
drop trigger if exists sponsorships_touch_updated_at on public.sponsorships;
create trigger sponsorships_touch_updated_at
  before update on public.sponsorships
  for each row execute function public.touch_updated_at();
drop trigger if exists packages_touch_updated_at on public.sponsorship_packages;
create trigger packages_touch_updated_at
  before update on public.sponsorship_packages
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 7 · the public read
-- ----------------------------------------------------------------------------

create or replace function public.kicklive_sponsorship_epoch()
returns bigint
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(max(c.epoch), 1) from public.sponsorship_config c
$fn$;

create or replace function public.kicklive_sponsorship_for(
  p_target_kind text,
  p_target_ids  text[] default null,
  p_limit       integer default 12
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ids   text[];
  v_epoch bigint;
  v_rows  jsonb;
begin
  if not public.kicklive_sponsor_target_kind_ok(p_target_kind) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'kind', 'reason', 'UNKNOWN_TARGET_KIND',
                              'allowed', jsonb_build_array('competition', 'season', 'match', 'team', 'award', 'event'));
  end if;
  -- One page, or one explicit set of ids (a match list page wants its fixtures' sponsors in one round
  -- trip). Never "everything": `p_target_ids` is required for the multi-id form and capped, because an
  -- unbounded "give me the sponsors of all matches" is a season's worth of rows for a page that shows ten.
  if p_target_ids is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ids', 'reason', 'TARGET_IDS_REQUIRED',
                              'detail', 'name the target the page is about; a sponsorship is only meaningful against one thing');
  end if;
  if array_length(p_target_ids, 1) is null or array_length(p_target_ids, 1) > 50 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'ids', 'reason', 'TARGET_IDS_OUT_OF_RANGE',
                              'detail', '1 to 50 ids per call');
  end if;
  v_ids := p_target_ids;
  v_epoch := public.kicklive_sponsorship_epoch();

  -- The projection is written out column by column, and that is the security control for step 10. A
  -- `to_jsonb(s)` would hand a viewer whatever the next migration adds to `sponsors` — including
  -- `contact_email`, which is why this function has an explicit list and why a test asserts that the
  -- private columns are not named in it.
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'sponsorshipId', s.id,
      'sponsorId', sp.id,
      'slug', sp.slug,
      'name', coalesce(nullif(btrim(sp.display_name), ''), sp.legal_name),
      'attribution', coalesce(nullif(btrim(s.attribution), ''), p.label),
      'packageCode', p.code,
      'packageLabel', p.label,
      'packageKind', p.kind,
      'tier', p.tier,
      'logoUrl', coalesce(kicklive_asset_url_for_asset(l.id), sp.logo_url),
      'bannerUrl', coalesce(kicklive_asset_url_for_asset(b.id), sp.banner_url),
      'brandColour', coalesce(s.background_colour, sp.brand_colour),
      'onDark', sp.on_dark,
      -- A sponsor's own link, or the one the assignment chose. https was enforced on write, and it is
      -- re-checked on read: the column predates that rule for any row imported before this migration.
      'href', case when public.kicklive_sponsor_https_ok(coalesce(nullif(s.link_url, ''), sp.website_url))
                   then coalesce(nullif(s.link_url, ''), sp.website_url) end,
      'rel', 'noopener external',
      'namingOverride', nullif(s.naming_override, ''),
      'priority', s.priority,
      'displayOrder', s.display_order,
      'startsAt', s.starts_at,
      'endsAt', s.ends_at,
      'targetKind', s.target_kind,
      'targetId', s.target_id
    ) order by s.priority asc, s.display_order asc, s.starts_at desc, s.id)
      -- Cap first, then aggregate: `limit` inside the aggregate would need a subquery per row, and the
      -- order matters — a truncated answer must be the *highest-priority* rows, not the first ones the
      -- planner happened to visit.
    , '[]'::jsonb
  ) into v_rows
  from (
    select *
      from (
        select x.*, row_number() over (
                 partition by x.target_id
                 order by x.priority asc, x.display_order asc, x.starts_at desc, x.id
               ) as rn
          from (
            select sn.id, sn.sponsor_id, sn.package_id, sn.priority, sn.display_order, sn.starts_at, sn.ends_at,
                   sn.attribution, sn.naming_override, sn.link_url, sn.logo_asset_id, sn.banner_asset_id,
                   sn.background_colour, sn.target_kind, sn.target_id
              from public.sponsorships sn
              join public.sponsors sp2 on sp2.id = sn.sponsor_id and sp2.status = 'approved'
              join public.sponsorship_packages pk on pk.id = sn.package_id and pk.is_active
             where sn.status = 'active'
               and sn.is_active
               and sn.target_kind = p_target_kind
               and sn.target_id = any (v_ids)
               and current_date between sn.starts_at and sn.ends_at
           ) x
       ) ranked
      where ranked.rn <= greatest(1, least(coalesce(p_limit, 12), 24))
      order by ranked.priority asc, ranked.display_order asc, ranked.starts_at desc, ranked.id
  ) s
  join public.sponsors sp          on sp.id = s.sponsor_id
  join public.sponsorship_packages p on p.id = s.package_id
  left  join public.media_assets l  on l.id = s.logo_asset_id
  left  join public.media_assets b  on b.id = s.banner_asset_id;

  return jsonb_build_object(
    'ok', true,
    'sponsors', v_rows,
    'epoch', v_epoch,
    'maxAgeSeconds', 120,
    'note', 'ordered by priority then display order; expired and inactive rows are filtered here, not hidden by the client'
  );
end
$fn$;

-- The one helper the public read needs that Phase 6 does not offer: an asset id rendered as a URL, without
-- the caller having to know the object key. Kept tiny and stable, and named for what it does so nobody
-- mistakes it for the access-control check (`kicklive_asset_authorized` is that one).
create or replace function public.kicklive_asset_url_for_asset(p_asset_id bigint)
returns text
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- SECURITY DEFINER because `media_assets` grants nothing to any client role, and Phase 6's verify block
  -- requires that any `kicklive_*asset*` function be a definer one rather than an invoker one that quietly
  -- returns NULL for everyone outside the owner. The visibility predicate is what makes the definer-ness
  -- safe: an id may not be traded for the key of a private object, which is the one question this function
  -- could otherwise answer.
  select case when a.status in ('ready', 'superseded') and a.object_key is not null and a.visibility = 'public'
              then '/api/media/assets/' || a.object_key end
    from public.media_assets a
   where a.id = p_asset_id
$fn$;

-- ----------------------------------------------------------------------------
-- 8 · the writers
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 5b · the public rate card
-- ----------------------------------------------------------------------------

-- What a package promises, never what it costs. This function exists so that the *projection* is the
-- security control: the columns it selects are the only ones a browser can ask for, so a future writer that
-- adds `price_amount` to the table cannot accidentally publish it through this read, and the admin list can
-- keep carrying the money columns because its reader is the desk. One `select` and no parameters also means
-- there is no argument to validate, which is why the public surface is this small.
create or replace function public.kicklive_sponsor_package_card()
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
           'ok', true,
           'epoch', public.kicklive_sponsorship_epoch(),
           'packages', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'code', p.code,
                      'label', p.label,
                      'description', p.description,
                      'kind', p.kind,
                      'tier', p.tier,
                      'season_label', p.season_label,
                      'exclusivity', p.exclusivity,
                      'allowed_target_kinds', to_jsonb(p.allowed_target_kinds),
                      'entitlements', p.entitlements
                    ) order by p.sort_order, p.tier, p.code)
               from public.sponsorship_packages p
              where p.is_active
           ), '[]'::jsonb)
         )
$fn$;

comment on function public.kicklive_sponsor_package_card() is
  'The published rate card: active packages, description and entitlements only. Price columns are not in the select list, so they are unreachable rather than filtered; the admin list is the surface that carries them.';

create or replace function public.kicklive_sponsor_save(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id      uuid := nullif(p_data->>'id', '')::uuid;
  v_row     public.sponsors;
  v_new     public.sponsors;
  v_caller  uuid := auth.uid();
  v_slug    text;
  v_missing text[] := '{}';
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'BODY_MUST_BE_OBJECT');
  end if;

  -- A caller may not approve their own work, and may not set a status at all from the save path: approval is
  -- `kicklive_sponsor_set_status`, so the audit trail has one door instead of two.
  if p_data ? 'status' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'status', 'reason', 'STATUS_VIA_SET_STATUS_ONLY',
                              'detail', 'a sponsor is approved or suspended by the status route, which records who did it');
  end if;
  if p_data ? 'approved_by' or p_data ? 'approved_at' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'APPROVAL_IS_NOT_EDITABLE');
  end if;
  -- The two branding URLs are derived, never typed. A save that quietly ignored `logoUrl` would be worse than
  -- one that refused it: the desk would read `ok: true`, and the badge would not have changed, with the
  -- reason sitting three tables away in a bucket listing. Uploading is
  -- `kicklive_sponsor_reserve_asset` then `kicklive_sponsor_attach_asset` — which is also the only path where
  -- the URL is known to point at an object that exists and belongs to this sponsor.
  if p_data ? 'logoUrl' or p_data ? 'logo_url' or p_data ? 'bannerUrl' or p_data ? 'banner_url' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
                              'field', case when p_data ? 'bannerUrl' or p_data ? 'banner_url' then 'bannerUrl' else 'logoUrl' end,
                              'reason', 'BRANDING_IS_UPLOADED_NOT_TYPED');
  end if;

  select * into v_row from public.sponsors s where s.id = v_id;
  if v_id is not null and not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'SPONSOR_UNKNOWN');
  end if;

  v_slug := lower(btrim(coalesce(p_data->>'slug', v_row.slug, '')));
  if v_slug = '' then
    -- Derive it from the display name rather than demanding it: the field a human types is the name, and a
    -- slug nobody checked is how `/sponsor/acme-bak-2` ends up in a nav bar.
    v_slug := regexp_replace(lower(btrim(coalesce(p_data->>'displayName', p_data->>'display_name', v_row.display_name, ''))), '[^a-z0-9]+', '-', 'g');
    v_slug := btrim(v_slug, '-');
    v_slug := left(v_slug, 64);
    if v_slug !~ '^[a-z0-9][a-z0-9-]{1,63}$' then
      select array_append(v_missing, 'slug') into v_missing;
    end if;
  end if;
  if v_row.id is not null and v_slug <> v_row.slug then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'slug', 'reason', 'SLUG_IMMUTABLE');
  end if;

  if coalesce(p_data->>'displayName', p_data->>'display_name', v_row.display_name, '') = '' then
    select array_append(v_missing, 'displayName') into v_missing;
  end if;
  if array_length(v_missing, 1) is not null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'reason', 'REQUIRED_FIELDS', 'missing', to_jsonb(v_missing));
  end if;
  -- A cast failure inside the insert arrives as a raised exception, which the Worker can only report as a
  -- 502. `{"defaultPriority": "high"}` is a client bug, and a client bug deserves a field name.
  if public.kicklive_sponsor_field_refuses(p_data, array['defaultPriority', 'valueAmount', 'logoAssetId', 'bannerAssetId']) is not null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', public.kicklive_sponsor_field_refuses(p_data, array['defaultPriority', 'valueAmount', 'logoAssetId', 'bannerAssetId']), 'reason', 'NUMBER_REQUIRED');
  end if;
  if p_data ? 'websiteUrl' and not public.kicklive_sponsor_https_ok(p_data->>'websiteUrl') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'websiteUrl', 'reason', 'HTTPS_URL_WITH_HOST_REQUIRED');
  end if;
  if p_data ? 'brandColour' and coalesce(p_data->>'brandColour', '') !~* '^#[0-9a-f]{6}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'brandColour', 'reason', 'HEX_COLOUR_REQUIRED');
  end if;
  -- Validated *after* normalisation, not before. The table stores `lower(btrim(…))`, so a check against the
  -- raw field would refuse `"ads@flow.example "` — a trailing space from a paste — and then accept exactly
  -- that value on the next keystroke, because the second request has no space. The rule belongs to the form
  -- the value ends up in, which is why it reads the same expression the insert writes.
  if p_data ? 'contactEmail'
     and btrim(coalesce(p_data->>'contactEmail', '')) <> ''
     and lower(btrim(p_data->>'contactEmail')) !~ '^[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]{2,}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'contactEmail', 'reason', 'EMAIL_UNPARSEABLE');
  end if;

  insert into public.sponsors (
    slug, display_name, legal_name, description, website_url,
    contact_name, contact_email, contact_phone, contact_consent_at,
    brand_colour, on_dark, default_priority,
    value_amount, value_currency, value_basis, invoice_reference, renewal_terms, internal_notes,
    status, created_by
  ) values (
    v_slug,
    btrim(coalesce(p_data->>'displayName', p_data->>'display_name', v_row.display_name)),
    nullif(btrim(coalesce(p_data->>'legalName', p_data->>'legal_name', v_row.legal_name, '')), ''),
    nullif(btrim(coalesce(p_data->>'description', v_row.description, '')), ''),
    nullif(btrim(coalesce(p_data->>'websiteUrl', p_data->>'website_url', v_row.website_url, '')), ''),
    nullif(btrim(coalesce(p_data->>'contactName', v_row.contact_name, '')), ''),
    lower(nullif(btrim(coalesce(p_data->>'contactEmail', v_row.contact_email, '')), '')),
    nullif(btrim(coalesce(p_data->>'contactPhone', v_row.contact_phone, '')), ''),
    case when p_data ? 'contactConsentAt' then (p_data->>'contactConsentAt')::timestamptz else v_row.contact_consent_at end,
    nullif(btrim(coalesce(p_data->>'brandColour', v_row.brand_colour, '')), ''),
    coalesce((p_data->>'onDark')::boolean, v_row.on_dark, false),
    greatest(0, least(9999, coalesce((p_data->>'defaultPriority')::smallint, v_row.default_priority, 100))),
    coalesce((p_data->>'valueAmount')::numeric(12,2), v_row.value_amount),
    upper(nullif(btrim(coalesce(p_data->>'valueCurrency', v_row.value_currency, '')), '')),
    nullif(btrim(coalesce(p_data->>'valueBasis', v_row.value_basis, '')), ''),
    nullif(btrim(coalesce(p_data->>'invoiceReference', v_row.invoice_reference, '')), ''),
    nullif(btrim(coalesce(p_data->>'renewalTerms', v_row.renewal_terms, '')), ''),
    nullif(btrim(coalesce(p_data->>'internalNotes', v_row.internal_notes, '')), ''),
    'draft',
    v_caller
  )
  on conflict (slug) do update set
    display_name    = excluded.display_name,
    legal_name      = excluded.legal_name,
    description     = excluded.description,
    website_url     = excluded.website_url,
    contact_name    = excluded.contact_name,
    contact_email   = excluded.contact_email,
    contact_phone   = excluded.contact_phone,
    contact_consent_at = excluded.contact_consent_at,
    brand_colour    = excluded.brand_colour,
    on_dark         = excluded.on_dark,
    default_priority = excluded.default_priority,
    value_amount    = excluded.value_amount,
    value_currency  = excluded.value_currency,
    value_basis     = excluded.value_basis,
    invoice_reference = excluded.invoice_reference,
    renewal_terms   = excluded.renewal_terms,
    internal_notes  = excluded.internal_notes,
    updated_at      = now()
  returning * into v_new;

  -- A *new* sponsor must land as `draft`; the upsert above can only ever change content, so the status of an
  -- existing row survives an edit untouched, which is the property the two-verb API depends on.
  perform public.kicklive_sponsorship_touch_epoch(v_row.id is null);

  return jsonb_build_object(
    'ok', true,
    'created', v_row.id is null,
    'sponsor', to_jsonb(v_new) - 'contact_email' - 'contact_phone' - 'contact_name' - 'internal_notes'
  );
end
$fn$;

-- The epoch writer. Separate because five functions need it and because a trigger that bumps a global row
-- on every write is a lock nobody thought about: `true` for a change a viewer can see, `false` for an
-- internal note.
create or replace function public.kicklive_sponsorship_touch_epoch(p_visible boolean)
returns bigint
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_epoch bigint;
begin
  if not coalesce(p_visible, false) then
    return public.kicklive_sponsorship_epoch();
  end if;
  update public.sponsorship_config c
     set epoch = c.epoch + 1, updated_at = now()
   where c.id = 1
  returning c.epoch into v_epoch;
  return coalesce(v_epoch, 1);
end
$fn$;

create or replace function public.kicklive_sponsor_set_status(p_id uuid, p_status text, p_reason text default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.sponsors;
  v_allowed boolean;
  v_affected integer := 0;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.sponsors s where s.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'SPONSOR_UNKNOWN');
  end if;
  select exists (
    select 1 from public.sponsorship_status_transitions t
     where t.kind = 'sponsor' and t.from_status = v_row.status and t.to_status = p_status
  ) into v_allowed;
  if not v_allowed then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'status', 'reason', 'TRANSITION_NOT_ALLOWED',
                              'detail', v_row.status || ' -> ' || coalesce(p_status, 'null'),
                              -- `coalesce` to an empty array, not NULL: "there is nowhere to go from here" is
                              -- an answer a client can render, and `allowed.map` must not need a guard to find
                              -- out that a record is terminal.
                              'allowed', coalesce(to_jsonb((select array_agg(t.to_status) from public.sponsorship_status_transitions t
                                                              where t.kind = 'sponsor' and t.from_status = v_row.status)), '[]'::jsonb));
  end if;
  if p_status = 'suspended' and p_reason is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'reason', 'reason', 'REASON_REQUIRED',
                              'detail', 'a suspension is a decision with a consequence; write down which one');
  end if;

  update public.sponsors s
     set status = p_status,
         approved_by = case when p_status = 'approved' then auth.uid() else s.approved_by end,
         approved_at = case when p_status = 'approved' then now() else s.approved_at end,
         internal_notes = case when p_reason is not null and p_status = 'suspended'
                              then btrim(coalesce(s.internal_notes || E'\n', '') || 'suspended: ' || p_reason)
                              else s.internal_notes end,
         updated_at = now()
   where s.id = p_id
   returning * into v_row;

  -- The cascade that makes the status mean something: a sponsor that is not approved may not be displayed,
  -- so every live placement of theirs goes off the site in the same transaction. Leaving them `active` is
  -- how a suspended brand stays on the banner for the rest of the season.
  if p_status in ('suspended', 'archived') then
    update public.sponsorships sn
       set status = 'paused', is_active = false, updated_at = now()
     where sn.sponsor_id = p_id and sn.status = 'active';
    get diagnostics v_affected = row_count;
  end if;

  perform public.kicklive_sponsorship_touch_epoch(true);
  return jsonb_build_object('ok', true, 'sponsor', to_jsonb(v_row) - 'contact_email' - 'contact_phone' - 'contact_name',
                            'sponsorships_paused', v_affected);
end
$fn$;

create or replace function public.kicklive_sponsor_package_save(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id   uuid := nullif(p_data->>'id', '')::uuid;
  v_row  public.sponsorship_packages;
  v_new  public.sponsorship_packages;
  v_kinds text[];
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.sponsorship_packages p where p.id = v_id;
  if v_id is not null and not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'PACKAGE_UNKNOWN');
  end if;

  -- An aliased element column, because `array_agg(k)` over an unaliased function-in-FROM is
  -- `column "k" does not exist` at the first call that passes the field — the kind of mistake that installs
  -- happily (the body is not parsed until then) and surfaces as a 502 in front of a user.
  v_kinds := coalesce(
    nullif((select array_agg(v.value) from jsonb_array_elements_text(coalesce(p_data->'allowedTargetKinds', '[]'::jsonb)) as v(value)), '{}'),
    v_row.allowed_target_kinds,
    -- The column default, written again on purpose. A `save` that omitted the field and inherited the
    -- table's default through a different code path than the seed did is how a package ends up narrower or
    -- wider than the row that created it by hand; one list, cited in both places, cannot drift silently.
    array['competition', 'season', 'match', 'team', 'award', 'event']::text[]
  );
  if v_kinds is null or array_length(v_kinds, 1) is null then
    v_kinds := v_row.allowed_target_kinds;
  end if;
  if exists (select 1 from unnest(v_kinds) k(x) where not public.kicklive_sponsor_target_kind_ok(k.x)) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'allowedTargetKinds', 'reason', 'UNKNOWN_TARGET_KIND');
  end if;
  if public.kicklive_sponsor_field_refuses(p_data, array['tier', 'sortOrder', 'priceAmount']) is not null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', public.kicklive_sponsor_field_refuses(p_data, array['tier', 'sortOrder', 'priceAmount']), 'reason', 'NUMBER_REQUIRED');
  end if;
  if p_data ? 'entitlements' and not public.kicklive_sponsor_entitlements_ok(p_data->'entitlements') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'entitlements', 'reason', 'BAD_KEY_SET',
                              'detail', 'see kicklive_sponsor_entitlements_ok for the allowed keys');
  end if;

  insert into public.sponsorship_packages (
    code, label, kind, description, tier, season_label, exclusivity, entitlements, sort_order, is_active,
    price_amount, price_currency, price_basis, allowed_target_kinds
  ) values (
    lower(btrim(coalesce(p_data->>'code', v_row.code, ''))),
    btrim(coalesce(p_data->>'label', v_row.label, '')),
    lower(btrim(coalesce(p_data->>'kind', v_row.kind, coalesce(p_data->>'code', v_row.code, '')))),
    nullif(btrim(coalesce(p_data->>'description', v_row.description, '')), ''),
    greatest(1, least(9, coalesce((p_data->>'tier')::smallint, v_row.tier, 3))),
    nullif(btrim(coalesce(p_data->>'seasonLabel', v_row.season_label, '')), ''),
    coalesce(p_data->>'exclusivity', v_row.exclusivity, 'none'),
    coalesce(p_data->'entitlements', v_row.entitlements, '{}'::jsonb),
    greatest(0, least(9999, coalesce((p_data->>'sortOrder')::smallint, v_row.sort_order, 100))),
    coalesce((p_data->>'isActive')::boolean, v_row.is_active, true),
    coalesce((p_data->>'priceAmount')::numeric(12,2), v_row.price_amount),
    upper(nullif(btrim(coalesce(p_data->>'priceCurrency', v_row.price_currency, '')), '')),
    nullif(btrim(coalesce(p_data->>'priceBasis', v_row.price_basis, '')), ''),
    v_kinds
  )
  on conflict (code) do update set
    label = excluded.label,
    kind = excluded.kind,
    description = excluded.description,
    tier = excluded.tier,
    season_label = excluded.season_label,
    exclusivity = excluded.exclusivity,
    entitlements = excluded.entitlements,
    sort_order = excluded.sort_order,
    is_active = excluded.is_active,
    price_amount = excluded.price_amount,
    price_currency = excluded.price_currency,
    price_basis = excluded.price_basis,
    allowed_target_kinds = excluded.allowed_target_kinds,
    updated_at = now()
  returning * into v_new;

  -- Whether a viewer-facing answer changed: a label or a price is not one, `is_active` and the entitlements
  -- are, and the exclusivity setting decides who else may be shown.
  perform public.kicklive_sponsorship_touch_epoch(
    v_row.id is null
    or v_new.is_active is distinct from v_row.is_active
    or v_new.entitlements is distinct from v_row.entitlements
    or v_new.exclusivity is distinct from v_row.exclusivity
    or v_new.allowed_target_kinds is distinct from v_row.allowed_target_kinds
  );
  return jsonb_build_object('ok', true, 'created', v_row.id is null, 'package', to_jsonb(v_new));
end
$fn$;

create or replace function public.kicklive_sponsorship_save(p_data jsonb)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id        uuid := nullif(p_data->>'id', '')::uuid;
  v_row       public.sponsorships;
  v_new       public.sponsorships;
  v_sponsor   public.sponsors;
  v_package   public.sponsorship_packages;
  v_kind      text;
  v_target    text;
  v_status    text;
  v_start     date;
  v_end       date;
  v_conflict  text;
  v_held      integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_data ? 'status' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'status', 'reason', 'STATUS_VIA_SET_STATUS_ONLY');
  end if;
  -- `is_active` is refused for the `status` reason and for the sponsor's `logoUrl` reason at once. It is a
  -- second door onto a column the status route already owns (with its transition row and its author), and a
  -- save that quietly ignored it would answer `ok: true` to a desk that had just unticked "display" — the
  -- form would look saved, the band would not change, and the reason would be sitting in a column this
  -- function never reads. The switch exists: it is `kicklive_sponsorship_set_status(p_is_active => ...)`.
  if p_data ? 'isActive' or p_data ? 'is_active' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'isActive', 'reason', 'DISPLAY_SWITCH_VIA_SET_STATUS_ONLY',
                              'detail', 'a sponsorship is shown or hidden by the status route, which records who did it');
  end if;
  select * into v_row from public.sponsorships s where s.id = v_id;
  if v_id is not null and not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'SPONSORSHIP_UNKNOWN');
  end if;

  v_kind := lower(btrim(coalesce(p_data->>'targetKind', v_row.target_kind, '')));
  v_target := btrim(coalesce(p_data->>'targetId', p_data->>'target_id', v_row.target_id, ''));
  if not public.kicklive_sponsor_target_kind_ok(v_kind) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'targetKind', 'reason', 'UNKNOWN_TARGET_KIND');
  end if;
  if not public.kicklive_sponsor_target_id_ok(v_kind, v_target) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'targetId', 'reason', 'MALFORMED_TARGET_ID',
                              'detail', 'competition, season, team and match take a numeric id; award and event take a slug');
  end if;

  select * into v_sponsor from public.sponsors s where s.id = coalesce(nullif(p_data->>'sponsorId', '')::uuid, v_row.sponsor_id);
  if v_sponsor.id is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'sponsorId', 'reason', 'SPONSOR_REQUIRED');
  end if;
  select * into v_package from public.sponsorship_packages p where p.id = coalesce(nullif(p_data->>'packageId', '')::uuid, v_row.package_id);
  if v_package.id is null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'packageId', 'reason', 'PACKAGE_REQUIRED');
  end if;
  if not v_package.is_active then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'packageId', 'reason', 'PACKAGE_INACTIVE');
  end if;
  -- Whether the package may be sold against this kind is asked *before* whether the target exists, because
  -- the first is a fact about the request and the second about the database. A form that offers "Season" for
  -- a match-only package should be told that on the first save, not after it has been made to pick a season.
  -- The existence check runs here as well as in the trigger, so the client gets a field error rather than a
  -- raised exception — the trigger is the one that also fires for anything that is not this function.
  if not exists (select 1 from unnest(v_package.allowed_target_kinds) k(x) where k.x = v_kind) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'targetKind', 'reason', 'KIND_NOT_IN_PACKAGE',
                              'detail', 'the ' || v_package.label || ' package is not sold against a ' || v_kind);
  end if;
  if v_kind <> 'award' and v_kind <> 'event' and not public.kicklive_sponsor_target_exists(v_kind, v_target) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'targetId', 'reason', 'TARGET_NOT_FOUND',
                              'detail', 'no ' || v_kind || ' with that id');
  end if;

  if public.kicklive_sponsor_field_refuses(p_data, array['priority', 'displayOrder', 'valueAmount', 'logoAssetId', 'bannerAssetId']) is not null then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', public.kicklive_sponsor_field_refuses(p_data, array['priority', 'displayOrder', 'valueAmount', 'logoAssetId', 'bannerAssetId']), 'reason', 'NUMBER_REQUIRED');
  end if;
  if p_data ? 'attribution' and not public.kicklive_sponsor_label_ok(p_data->>'attribution', 160) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'attribution', 'reason', 'LABEL_UNSAFE');
  end if;
  if p_data ? 'namingOverride' and not public.kicklive_sponsor_label_ok(p_data->>'namingOverride', 120) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'namingOverride', 'reason', 'LABEL_UNSAFE');
  end if;
  if p_data ? 'linkUrl' and not public.kicklive_sponsor_https_ok(p_data->>'linkUrl') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'linkUrl', 'reason', 'HTTPS_URL_WITH_HOST_REQUIRED');
  end if;

  -- The window, resolved once here rather than twice in the VALUES list, so the ordering rule and the stored
  -- row cannot disagree about what the dates were. The table's CHECK stays as the backstop for every writer
  -- that is not this function; the refusal below exists so that this writer answers with a field name.
  if not public.kicklive_sponsor_date_ok(nullif(p_data->>'startsAt', '')) or not public.kicklive_sponsor_date_ok(nullif(p_data->>'endsAt', '')) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED',
                              'field', case when public.kicklive_sponsor_date_ok(nullif(p_data->>'startsAt', '')) then 'endsAt' else 'startsAt' end,
                              'reason', 'DATE_REQUIRED', 'detail', 'expected a calendar date as YYYY-MM-DD');
  end if;
  begin
    v_start := coalesce(nullif(p_data->>'startsAt', '')::date, v_row.starts_at, current_date);
    v_end := coalesce(nullif(p_data->>'endsAt', '')::date, v_row.ends_at, (date_trunc('year', current_date) + interval '1 year - 1 day')::date);
  exception
    -- By SQLSTATE, not by name: PL/pgSQL has no `datetime_field_value_out_of_range` condition, and the two
    -- codes here are the ones a `::date` cast actually raises — 22007 for a value Postgres cannot parse and
    -- 22008 for one that parses and does not exist. Naming a condition that does not exist fails at
    -- *compilation*, which is what the rerun pass with bodies on is for.
    when sqlstate '22007' or sqlstate '22008' then
      return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'endsAt', 'reason', 'DATE_NOT_ON_CALENDAR',
                                'detail', 'the shape is right and the day is not: 2026-02-30 does not exist');
  end;
  if v_end < v_start then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'endsAt', 'reason', 'WINDOW_NOT_ORDERED',
                              'detail', 'a sponsorship that ends before it starts is a date typed into the wrong box');
  end if;

  -- Exclusivity, and the reason it is a query rather than a constraint: "no other *approved sponsor in the
  -- same category* may hold an active title slot on this target" reaches three tables and the calendar. As a
  -- CHECK it would be impossible; as a trigger alone it would be a 500. Here it is a refusal with a name.
  if v_package.exclusivity in ('exclusive', 'package') then
    select pk.label
      into v_conflict
      from public.sponsorships s
      join public.sponsorship_packages pk on pk.id = s.package_id
      join public.sponsors sp on sp.id = s.sponsor_id
     where s.target_kind = v_kind and s.target_id = v_target
       and s.status in ('scheduled', 'active') and s.is_active
       and s.id is distinct from v_id
       and (v_package.exclusivity = 'exclusive'
            or sp.id <> v_sponsor.id)  -- `package`: another sponsor, same package
       and (v_package.exclusivity = 'package' or pk.exclusivity in ('exclusive', 'package'))
     limit 1;
    if v_conflict is not null then
      return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'targetId', 'reason', 'EXCLUSIVITY_TAKEN',
                                'detail', 'this ' || v_kind || ' already carries a ' || v_conflict || ' sponsorship');
    end if;
  end if;
  -- `max_per_target` from the package's entitlements, honoured here rather than in the renderer, because a
  -- limit that only the display respects is a limit that the data will happily exceed.
  if v_package.entitlements ? 'max_per_target' then
    select count(1) into v_held
      from public.sponsorships s
     where s.target_kind = v_kind and s.target_id = v_target
       and s.package_id = v_package.id
       and s.status in ('scheduled', 'active')
       and s.id is distinct from v_id;
    if v_held > coalesce((v_package.entitlements->>'max_per_target')::int, 99) then
      return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'packageId', 'reason', 'PACKAGE_LIMIT_FOR_TARGET',
                                'detail', v_package.label || ' allows ' || (v_package.entitlements->>'max_per_target') ||
                                            ' per ' || v_kind || ' and this one has ' || v_held::text);
    end if;
  end if;

  -- The unique index (`…no_duplicate_key`) is the thing that actually prevents a re-typed renewal, and an
  -- exception from it would reach the API as an untranslatable 23505. Same wrapper Phase 7 uses for a
  -- duplicate creative title: catch it at the write, name the field, and let the envelope stay the contract.
  begin
  insert into public.sponsorships (
    id, sponsor_id, package_id, target_kind, target_id, starts_at, ends_at, attribution, naming_override,
    logo_asset_id, banner_asset_id, logo_variant, background_colour, link_url, priority, display_order,
    value_amount, value_currency, value_basis, invoice_reference, renewal_terms, internal_notes,
    advertisement_campaign_id, status, is_active, created_by
  ) values (
    coalesce(v_id, gen_random_uuid()),
    v_sponsor.id, v_package.id, v_kind, v_target,
    v_start,
    v_end,
    nullif(btrim(coalesce(p_data->>'attribution', v_row.attribution, '')), ''),
    nullif(btrim(coalesce(p_data->>'namingOverride', v_row.naming_override, '')), ''),
    coalesce(nullif(p_data->>'logoAssetId', '')::bigint, v_row.logo_asset_id),
    coalesce(nullif(p_data->>'bannerAssetId', '')::bigint, v_row.banner_asset_id),
    nullif(btrim(coalesce(p_data->>'logoVariant', v_row.logo_variant, '')), ''),
    nullif(btrim(coalesce(p_data->>'backgroundColour', v_row.background_colour, '')), ''),
    nullif(btrim(coalesce(p_data->>'linkUrl', v_row.link_url, '')), ''),
    greatest(0, least(9999, coalesce((p_data->>'priority')::smallint,
                                     (v_package.entitlements->>'priority_default')::smallint,
                                     v_row.priority, v_sponsor.default_priority, 100))),
    greatest(0, least(999999, coalesce((p_data->>'displayOrder')::integer, v_row.display_order, 0))),
    coalesce((p_data->>'valueAmount')::numeric(12,2), v_row.value_amount),
    upper(nullif(btrim(coalesce(p_data->>'valueCurrency', v_row.value_currency, '')), '')),
    nullif(btrim(coalesce(p_data->>'valueBasis', v_row.value_basis, '')), ''),
    nullif(btrim(coalesce(p_data->>'invoiceReference', v_row.invoice_reference, '')), ''),
    nullif(btrim(coalesce(p_data->>'renewalTerms', v_row.renewal_terms, '')), ''),
    nullif(btrim(coalesce(p_data->>'internalNotes', v_row.internal_notes, '')), ''),
    coalesce(nullif(p_data->>'advertisementCampaignId', '')::uuid, v_row.advertisement_campaign_id),
    coalesce(v_row.status, 'draft'),
    coalesce(v_row.is_active, false),
    auth.uid()
  )
  on conflict (id) do update set
    sponsor_id = excluded.sponsor_id,
    package_id = excluded.package_id,
    target_kind = excluded.target_kind,
    target_id = excluded.target_id,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    attribution = excluded.attribution,
    naming_override = excluded.naming_override,
    logo_asset_id = excluded.logo_asset_id,
    banner_asset_id = excluded.banner_asset_id,
    logo_variant = excluded.logo_variant,
    background_colour = excluded.background_colour,
    link_url = excluded.link_url,
    priority = excluded.priority,
    display_order = excluded.display_order,
    value_amount = excluded.value_amount,
    value_currency = excluded.value_currency,
    value_basis = excluded.value_basis,
    invoice_reference = excluded.invoice_reference,
    renewal_terms = excluded.renewal_terms,
    internal_notes = excluded.internal_notes,
    advertisement_campaign_id = excluded.advertisement_campaign_id,
    activation_error = null,
    updated_at = now()
  returning * into v_new;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'startsAt', 'reason', 'DUPLICATE_ASSIGNMENT_IN_WINDOW',
                              'detail', 'this sponsor already holds this package against this target on that start date; renew by extending the existing record');
  end;

  -- Editing the copy or the dates of a sponsorship a viewer can currently see must re-render the page, but
  -- editing only the internal notes must not: an epoch bump is cheap, and doing it anyway would mean the
  -- edge cache is cold for every desk keystroke.
  perform public.kicklive_sponsorship_touch_epoch(
    v_row.id is null
    or v_new.priority is distinct from v_row.priority
    or v_new.display_order is distinct from v_row.display_order
    or v_new.starts_at is distinct from v_row.starts_at
    or v_new.ends_at is distinct from v_row.ends_at
    or v_new.attribution is distinct from v_row.attribution
    or v_new.naming_override is distinct from v_row.naming_override
    or v_new.logo_asset_id is distinct from v_row.logo_asset_id
    or v_new.banner_asset_id is distinct from v_row.banner_asset_id
    or v_new.link_url is distinct from v_row.link_url
  );

  return jsonb_build_object('ok', true, 'created', v_row.id is null, 'sponsorship', to_jsonb(v_new) - 'internal_notes');
end
$fn$;

create or replace function public.kicklive_sponsorship_set_status(p_id uuid, p_status text, p_reason text default null, p_is_active boolean default null)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row public.sponsorships;
  v_sponsor public.sponsors;
  v_package public.sponsorship_packages;
  v_allowed boolean;
  v_missing text[] := '{}';
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  select * into v_row from public.sponsorships s where s.id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'SPONSORSHIP_UNKNOWN');
  end if;
  select exists (
    select 1 from public.sponsorship_status_transitions t
     where t.kind = 'sponsorship' and t.from_status = v_row.status and t.to_status = p_status
  ) into v_allowed;
  if not v_allowed then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'field', 'status', 'reason', 'TRANSITION_NOT_ALLOWED',
                              'detail', v_row.status || ' -> ' || coalesce(p_status, 'null'),
                              'allowed', coalesce(to_jsonb((select array_agg(t.to_status) from public.sponsorship_status_transitions t
                                                              where t.kind = 'sponsorship' and t.from_status = v_row.status)), '[]'::jsonb));
  end if;

  -- The preconditions, gathered rather than short-circuited, so one round trip tells an operator everything
  -- they have to fix. A sponsorship that displays a brand the office has not approved is the failure this
  -- whole phase has to make impossible.
  if p_status = 'active' then
    select * into v_sponsor from public.sponsors s where s.id = v_row.sponsor_id;
    if v_sponsor.status <> 'approved' then
      select array_append(v_missing, 'sponsor:' || coalesce(v_sponsor.status, 'unknown')) into v_missing;
    end if;
    select * into v_package from public.sponsorship_packages p where p.id = v_row.package_id;
    if not v_package.is_active then
      select array_append(v_missing, 'package_inactive') into v_missing;
    end if;
    if v_row.ends_at < current_date then
      select array_append(v_missing, 'window_in_the_past') into v_missing;
    end if;
    if v_row.sponsor_id is null then
      select array_append(v_missing, 'sponsor_missing') into v_missing;
    end if;
    if array_length(v_missing, 1) is not null then
      update public.sponsorships s
         set activation_error = array_to_string(v_missing, ', '), updated_at = now()
       where s.id = p_id;
      return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'NOT_READY_TO_DISPLAY', 'missing', to_jsonb(v_missing),
                                'detail', 'a sponsorship displays a brand, so the brand has to be approved, the package live, and the window not over');
    end if;
  end if;

  update public.sponsorships s
     set status = p_status,
         -- `is_active` is the display switch and it follows the status by default: `active` shows, anything
         -- else does not, and an operator who wants the reverse (a live contract, hidden today) says so with
         -- the explicit parameter rather than by learning the trick.
         is_active = coalesce(p_is_active, p_status = 'active'),
         activated_by = case when p_status = 'active' then auth.uid() else s.activated_by end,
         activated_at = case when p_status = 'active' then now() else s.activated_at end,
         activation_error = null,
         internal_notes = case when p_reason is not null
                              then btrim(coalesce(s.internal_notes || E'\n', '') || p_status || ': ' || p_reason)
                              else s.internal_notes end,
         updated_at = now()
   where s.id = p_id
   returning * into v_row;

  perform public.kicklive_sponsorship_touch_epoch(true);
  return jsonb_build_object('ok', true, 'sponsorship', to_jsonb(v_row) - 'internal_notes', 'isActive', v_row.is_active);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 9 · media (step 6): reserve and attach, on Phase 6's vocabulary
-- ----------------------------------------------------------------------------

create or replace function public.kicklive_sponsor_reserve_asset(
  p_sponsor_id uuid,
  p_slot       text,
  p_content_type text,
  p_byte_size  bigint,
  p_sha256     text,
  p_width      integer default null,
  p_height     integer default null,
  p_alt_text   text default null
)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sponsor public.sponsors;
  v_existing public.media_assets;
  v_ver      integer;
  v_key      text;
  v_ext      text;
  v_max      bigint;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_slot not in ('logo', 'banner') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'slot', 'reason', 'SLOT_UNKNOWN',
                              'allowed', jsonb_build_array('logo', 'banner'));
  end if;
  select * into v_sponsor from public.sponsors s where s.id = p_sponsor_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'SPONSOR_UNKNOWN');
  end if;
  -- An image only, and only what Phase 6 accepts: `svg` is refused here as it is there, because a logo is
  -- the one asset a partner is handed an <img> tag for.
  if p_content_type not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'file', 'reason', 'UNSUPPORTED_TYPE');
  end if;
  v_max := case p_slot when 'banner' then 10485760::bigint else 5242880::bigint end;
  if p_byte_size is null or p_byte_size < 1 or p_byte_size > v_max then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'file', 'reason', 'TOO_LARGE',
                              'maxBytes', v_max);
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'sha256', 'reason', 'DIGEST_REQUIRED');
  end if;

  v_ext := case p_content_type when 'image/png' then 'png' when 'image/jpeg' then 'jpg'
                               when 'image/webp' then 'webp' else 'gif' end;
  -- Same-bytes-same-slot is not a new version: re-uploading the file that is already current returns it,
  -- because a logo re-saved by a nervous operator must not become "v3" and a cache miss on every page.
  select * into v_existing
    from public.media_assets a
   where a.entity_kind = 'sponsors' and a.entity_id = p_sponsor_id::text
     -- `uploading` included, deliberately. A client that retries the same file while the first attempt is
     -- still in flight gets the same row and the same key; restricting this to `ready` would hand the retry a
     -- second key and leave the first object in the bucket with no row pointing at it — the definition of an
     -- orphan, and one nothing but a manual audit would ever find. `failed` is excluded so a genuine re-do
     -- still gets a fresh version. Whether the caller may then *skip* the write is answered separately below,
     -- because the two questions are not the same question.
     and a.variant = p_slot and a.sha256 = p_sha256 and a.status in ('ready', 'uploading')
   order by a.version desc limit 1;
  if found then
    -- Two answers rather than one, and the difference is the whole safety argument. A `ready` row's bytes are
    -- already in the bucket, so the caller may skip the upload: `existing`. An `uploading` row is a reservation
    -- somebody is still writing — reusing its id and key is what stops the retry from orphaning an object, but
    -- skipping *that* upload would publish a URL to bytes that may never arrive, which is the one thing
    -- Phase 6's order-of-operations exists to prevent. So the flag reports what may be skipped, and `reused`
    -- says the key is not new either way.
    return jsonb_build_object('ok', true,
                              'existing', (v_existing.status = 'ready'),
                              'reused', true,
                              'assetId', v_existing.id,
                              'objectKey', v_existing.object_key,
                              'url', '/api/media/assets/' || v_existing.object_key,
                              'version', v_existing.version,
                              'slot', p_slot,
                              'bucket', v_existing.bucket);
  end if;

  select coalesce(max(a.version), 0) + 1 into v_ver
    from public.media_assets a
   where a.entity_kind = 'sponsors' and a.entity_id = p_sponsor_id::text and a.variant = p_slot;
  -- Phase 6's key grammar, with the slot in the variant position: `sponsors/<uuid>/logo/v2-1a2b3c4d.png`.
  v_key := 'sponsors/' || p_sponsor_id::text || '/' || p_slot || '/v' || v_ver::text || '-' || left(p_sha256, 8) || '.' || v_ext;

  insert into public.media_assets (
    entity_kind, entity_id, bucket, object_key, variant, version, content_type, byte_size, sha256,
    width, height, alt_text, visibility, status, created_by
  ) values (
    'sponsors', p_sponsor_id::text, 'media', v_key, p_slot, v_ver, p_content_type, p_byte_size, p_sha256,
    p_width, p_height, nullif(btrim(coalesce(p_alt_text, '')), ''), 'public', 'uploading', auth.uid()
  )
  returning id into v_existing.id;

  return jsonb_build_object('ok', true, 'existing', false, 'assetId', v_existing.id, 'objectKey', v_key,
                            'version', v_ver, 'url', '/api/media/assets/' || v_key,
                            'bucket', 'media', 'slot', p_slot);
end
$fn$;

-- Attaching is a separate call because it is the moment the bytes are known to exist: the Worker writes to
-- R2, verifies with a head, and only then does this move the entity's URL. A failure in between leaves the
-- asset `failed` and the sponsor row showing what it showed before — never a URL to nothing.
create or replace function public.kicklive_sponsor_attach_asset(p_sponsor_id uuid, p_asset_id bigint, p_slot text)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset   public.media_assets;
  v_url     text;
  v_sponsor jsonb;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_slot not in ('logo', 'banner') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'slot', 'reason', 'SLOT_UNKNOWN');
  end if;
  select * into v_asset from public.media_assets a where a.id = p_asset_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'ASSET_UNKNOWN');
  end if;
  if v_asset.entity_kind <> 'sponsors' or v_asset.entity_id <> p_sponsor_id::text or v_asset.variant <> p_slot then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ASSET_FOR_OTHER_ENTITY',
                              'detail', 'an asset may only be attached to the sponsor and slot it was reserved for');
  end if;
  if v_asset.status not in ('ready', 'uploading') then
    return jsonb_build_object('ok', false, 'code', 'CONFLICT', 'reason', 'ASSET_NOT_READY', 'detail', v_asset.status);
  end if;
  v_url := '/api/media/assets/' || v_asset.object_key;

  update public.sponsors s
     set logo_asset_id   = case when p_slot = 'logo'   then p_asset_id else s.logo_asset_id end,
         logo_url        = case when p_slot = 'logo'   then v_url      else s.logo_url end,
         banner_asset_id = case when p_slot = 'banner' then p_asset_id else s.banner_asset_id end,
         banner_url      = case when p_slot = 'banner' then v_url      else s.banner_url end,
         updated_at      = now()
   where s.id = p_sponsor_id;

  -- The previous occupant of the slot becomes `superseded`, so it stays readable for the immutable cache
  -- entries already pointing at it and disappears from history lists as "current". Phase 6's rule, reused.
  update public.media_assets a
     set status = 'superseded', superseded_at = now(), updated_at = now()
   where a.entity_kind = 'sponsors' and a.entity_id = p_sponsor_id::text and a.variant = p_slot
     and a.id <> p_asset_id and a.status = 'ready';
  update public.media_assets a set status = 'ready', ready_at = coalesce(a.ready_at, now()), updated_at = now()
   where a.id = p_asset_id and a.status = 'uploading';

  -- A sponsor's logo appears on live pages, so this is a viewer-visible change.
  perform public.kicklive_sponsorship_touch_epoch(true);
  -- `return jsonb_build_object(…) from public.sponsors` is not a thing a plpgsql function can say: RETURN
  -- takes an expression and no FROM. The row is selected first, and the private columns are removed from
  -- the copy that goes back to the caller.
  select to_jsonb(s) - 'contact_email' - 'contact_phone' - 'contact_name' - 'internal_notes' into v_sponsor
    from public.sponsors s where s.id = p_sponsor_id;
  return jsonb_build_object('ok', true, 'sponsor', v_sponsor, 'assetId', p_asset_id, 'url', v_url);
end
$fn$;

-- ----------------------------------------------------------------------------
-- 10 · the clock, the diagnostics, the admin list
-- ----------------------------------------------------------------------------

create or replace function public.kicklive_sponsorship_expire_due(p_limit integer default 500)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ids      uuid[];
  v_count    integer := 0;
  v_activated integer := 0;
begin
  if auth.uid() is not null and not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- `for update` is legal only on the outer statement, so the rows are locked by id list rather than inside
  -- the CTE — and the list is bounded before anything is touched, because this runs from a cron alongside
  -- the media sweep and must not become the reason a deploy cannot be cancelled.
  select array_agg(x.id) into v_ids
    from (
      select s.id from public.sponsorships s
       where s.status = 'active' and s.ends_at < current_date
       order by s.ends_at, s.id
       limit greatest(1, least(coalesce(p_limit, 500), 2000))
    ) x;
  if v_ids is null then
    return jsonb_build_object('ok', true, 'ended', 0, 'scheduled_activated', 0, 'epoch', public.kicklive_sponsorship_epoch());
  end if;
  update public.sponsorships s
     set status = 'ended', is_active = false, updated_at = now()
   where s.id = any (v_ids) and s.status = 'active' and s.ends_at < current_date;
  get diagnostics v_count = row_count;

  -- A scheduled sponsorship whose window has begun is activated here, and only if it is already ready — the
  -- preconditions are the same function the human path runs, so "the clock did it" and "an operator did it"
  -- cannot disagree about what may be shown.
  with candidates as (
    select sn.id
      from public.sponsorships sn
      join public.sponsors sp on sp.id = sn.sponsor_id and sp.status = 'approved'
      join public.sponsorship_packages pk on pk.id = sn.package_id and pk.is_active
     where sn.status = 'scheduled' and sn.starts_at <= current_date and sn.ends_at >= current_date
     order by sn.starts_at, sn.id
     limit greatest(1, least(coalesce(p_limit, 500), 2000))
  )
  update public.sponsorships s
     set status = 'active', is_active = true, activated_at = now(), activation_error = null, updated_at = now()
    from candidates c
   where s.id = c.id
     and not exists (select 1 from public.sponsors x where x.id = s.sponsor_id and x.status <> 'approved');
  get diagnostics v_activated = row_count;

  if v_count > 0 or v_activated > 0 then
    perform public.kicklive_sponsorship_touch_epoch(true);
  end if;
  return jsonb_build_object('ok', true, 'ended', v_count, 'scheduled_activated', v_activated,
                            'epoch', public.kicklive_sponsorship_epoch(),
                            'note', 'the serving query filters the window too; this pass keeps the statuses honest');
end
$fn$;

create or replace function public.kicklive_sponsorship_diagnostics()
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  -- Counts of states that must not exist, and nothing else: no sponsor names, no contacts, no amounts. The
  -- response is meant to be pasteable into a support channel.
  return jsonb_build_object(
    'ok', true,
    'epoch', public.kicklive_sponsorship_epoch(),
    'active_but_expired',     (select count(1) from public.sponsorships s where s.status = 'active' and s.ends_at < current_date),
    'active_unapproved',      (select count(1) from public.sponsorships s join public.sponsors sp on sp.id = s.sponsor_id
                                where s.status = 'active' and sp.status <> 'approved'),
    'active_inactive_flag',   (select count(1) from public.sponsorships s where s.status = 'active' and not s.is_active),
    'displayed_not_active',   (select count(1) from public.sponsorships s where s.is_active and s.status <> 'active'),
    'active_dead_package',    (select count(1) from public.sponsorships s join public.sponsorship_packages pk on pk.id = s.package_id
                                where s.status = 'active' and not pk.is_active),
    'window_reversed',        (select count(1) from public.sponsorships s where s.ends_at < s.starts_at),
    'target_kind_mismatch',   (select count(1) from public.sponsorships s join public.sponsorship_packages pk on pk.id = s.package_id
                                where not (s.target_kind = any (pk.allowed_target_kinds))),
    'sponsor_without_logo',   (select count(1) from public.sponsors s where s.status = 'approved' and s.logo_url is null),
    'orphan_logo_assets',     (select count(1) from public.media_assets ma where ma.entity_kind = 'sponsors' and ma.status in ('ready','superseded')
                                and not exists (select 1 from public.sponsors s where s.id::text = ma.entity_id
                                                 and (s.logo_asset_id = ma.id or s.banner_asset_id = ma.id))),
    'double_title',           (select count(1) from (
                                 select s.target_kind, s.target_id from public.sponsorships s
                                   join public.sponsorship_packages pk on pk.id = s.package_id
                                  where s.status = 'active' and s.is_active and pk.exclusivity = 'exclusive'
                                  group by 1, 2 having count(1) > 1) d),
    'counts', jsonb_build_object(
      'sponsors',          (select count(1) from public.sponsors),
      'sponsors_approved', (select count(1) from public.sponsors where status = 'approved'),
      'packages',          (select count(1) from public.sponsorship_packages),
      'packages_active',   (select count(1) from public.sponsorship_packages where is_active),
      'sponsorships',      (select count(1) from public.sponsorships),
      'sponsorships_live', (select count(1) from public.sponsorships where status = 'active' and is_active)
    ),
    'definitions', jsonb_build_object(
      'ordering', 'priority asc, display_order asc, starts_at desc — no randomness, no bidding',
      'visibility', 'status = active AND is_active AND current_date between starts_at and ends_at AND sponsor approved AND package active'
    )
  );
end
$fn$;

create or replace function public.kicklive_sponsorship_admin_list(
  p_resource       text,
  p_q              text default null,
  p_status         text default null,
  p_target_kind    text default null,
  p_target_id      text default null,
  p_sponsor_id     uuid default null,
  p_include_expired boolean default false,
  p_limit          integer default 50,
  p_offset         integer default 0
)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows jsonb;
  v_total integer;
begin
  if not (public.is_admin() or public.is_admin_or_media()) then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN', 'reason', 'ADMIN_ONLY');
  end if;
  if p_resource not in ('sponsors', 'packages', 'sponsorships') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'resource', 'reason', 'UNKNOWN_RESOURCE',
                              'allowed', jsonb_build_array('sponsors', 'packages', 'sponsorships'));
  end if;

  if p_resource = 'sponsors' then
    -- The admin view of a sponsor *does* carry the contact fields, because the person reading it is the
    -- person who has to telephone them. `select` privilege on the table is not part of that; the identity
    -- check above is.
    select count(1) into v_total from public.sponsors s
     where (p_q is null or s.display_name ilike '%' || p_q || '%' or s.legal_name ilike '%' || p_q || '%' or s.slug ilike '%' || p_q || '%')
       and (p_status is null or s.status = p_status);
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.default_priority, x.display_name), '[]'::jsonb) into v_rows
      from (
        select s.id, s.slug, s.display_name, s.legal_name, s.description, s.website_url, s.status,
               s.contact_name, s.contact_email, s.contact_phone, s.contact_consent_at,
               s.logo_url, s.banner_url, s.logo_asset_id, s.banner_asset_id, s.brand_colour, s.on_dark,
               s.default_priority, s.value_amount, s.value_currency, s.value_basis, s.invoice_reference,
               s.renewal_terms, s.internal_notes, s.approved_at, s.created_at, s.updated_at,
               (select count(1) from public.sponsorships sn where sn.sponsor_id = s.id) as sponsorship_count,
               (select count(1) from public.sponsorships sn where sn.sponsor_id = s.id and sn.status = 'active' and sn.is_active) as live_count
          from public.sponsors s
         where (p_q is null or s.display_name ilike '%' || p_q || '%' or s.legal_name ilike '%' || p_q || '%' or s.slug ilike '%' || p_q || '%')
           and (p_status is null or s.status = p_status)
         order by s.default_priority, s.display_name
         limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
      ) x;
    return jsonb_build_object('ok', true, 'sponsors', v_rows, 'total', v_total, 'limit', least(coalesce(p_limit, 50), 200), 'offset', p_offset);
  end if;

  if p_resource = 'packages' then
    select count(1) into v_total from public.sponsorship_packages;
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.sort_order, x.tier), '[]'::jsonb) into v_rows
      from (
        select p.id, p.code, p.label, p.kind, p.description, p.tier, p.season_label, p.exclusivity,
               p.entitlements, p.sort_order, p.is_active, p.price_amount, p.price_currency, p.price_basis,
               to_jsonb(p.allowed_target_kinds) as allowed_target_kinds,
               (select count(1) from public.sponsorships s where s.package_id = p.id) as usage_count,
               (select count(1) from public.sponsorships s where s.package_id = p.id and s.status = 'active' and s.is_active) as live_count
          from public.sponsorship_packages p
         where (p_q is null or p.label ilike '%' || p_q || '%' or p.code ilike '%' || p_q || '%')
           and (p_status is null or (p.is_active and p_status = 'active') or (not p.is_active and p_status = 'inactive'))
         order by p.sort_order, p.tier
      ) x;
    return jsonb_build_object('ok', true, 'packages', v_rows, 'total', v_total);
  end if;

  select count(1) into v_total from public.sponsorships s
   where (p_sponsor_id is null or s.sponsor_id = p_sponsor_id)
     and (p_target_kind is null or s.target_kind = p_target_kind)
     and (p_target_id is null or s.target_id = p_target_id)
     and (p_status is null or s.status = p_status)
     and (p_include_expired or s.ends_at >= current_date);
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.target_kind, x.priority, x.display_order, x.ends_at desc), '[]'::jsonb) into v_rows
    from (
      select s.id, s.sponsor_id, s.package_id, s.target_kind, s.target_id, s.starts_at, s.ends_at, s.status,
             s.is_active, s.priority, s.display_order, s.attribution, s.naming_override, s.logo_asset_id,
             s.banner_asset_id, s.logo_variant, s.background_colour, s.link_url, s.activation_error,
             s.value_amount, s.value_currency, s.value_basis, s.invoice_reference, s.renewal_terms,
             s.advertisement_campaign_id, s.activated_at, s.created_at, s.updated_at,
             sp.slug as sponsor_slug, sp.display_name as sponsor_name, sp.status as sponsor_status,
             p.code as package_code, p.label as package_label, p.tier as package_tier,
             (current_date between s.starts_at and s.ends_at) as window_open
        from public.sponsorships s
        join public.sponsors sp on sp.id = s.sponsor_id
        join public.sponsorship_packages p on p.id = s.package_id
       where (p_sponsor_id is null or s.sponsor_id = p_sponsor_id)
         and (p_target_kind is null or s.target_kind = p_target_kind)
         and (p_target_id is null or s.target_id = p_target_id)
         and (p_status is null or s.status = p_status)
         and (p_include_expired or s.ends_at >= current_date)
       order by s.target_kind, s.priority, s.display_order, s.ends_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
    ) x;
  return jsonb_build_object('ok', true, 'sponsorships', v_rows, 'total', v_total, 'epoch', public.kicklive_sponsorship_epoch());
end
$fn$;

-- Why is this page showing what it shows? The same code path the viewer gets, plus the reasons. Phase 7's
-- `kicklive_ad_explain` lesson applies: a preview that agrees with the *form* is a lie, and one that agrees
-- with production is a feature.
create or replace function public.kicklive_sponsorship_explain(p_target_kind text, p_target_id text)
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
  if not public.kicklive_sponsor_target_kind_ok(p_target_kind) then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED', 'field', 'kind', 'reason', 'UNKNOWN_TARGET_KIND');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'sponsorshipId', s.id,
    'sponsor', sp.display_name,
    'package', pk.label,
    'wouldServe', s.status = 'active' and s.is_active
                   and current_date between s.starts_at and s.ends_at
                   and sp.status = 'approved' and pk.is_active,
    'blockers', (
      select nullif(array_to_string(array_remove(array[
        case when s.status <> 'active'      then 'status:' || s.status end,
        case when not s.is_active          then 'display_switch_off' end,
        case when s.ends_at < current_date  then 'window_ended' end,
        case when s.starts_at > current_date then 'window_not_started' end,
        case when sp.status <> 'approved'  then 'sponsor:' || sp.status end,
        case when not pk.is_active         then 'package_inactive' end,
        case when s.activation_error is not null then 'activation:' || s.activation_error end
      ], null), ', '), '')
    ),
    'priority', s.priority,
    'displayOrder', s.display_order
  ) order by s.priority, s.display_order), '[]'::jsonb) into v_rows
    from public.sponsorships s
    join public.sponsors sp on sp.id = s.sponsor_id
    join public.sponsorship_packages pk on pk.id = s.package_id
   where s.target_kind = p_target_kind and s.target_id = p_target_id
     and s.status <> 'archived';
  return jsonb_build_object('ok', true, 'target', p_target_kind || ':' || p_target_id, 'rows', coalesce(v_rows, '[]'::jsonb),
                            'serving', public.kicklive_sponsorship_for(p_target_kind, array[p_target_id]));
end
$fn$;

create or replace function public.kicklive_sponsorship_status_transitions(p_kind text default 'sponsorship')
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'ok', true,
    'kind', p_kind,
    'transitions', coalesce((
      select jsonb_agg(jsonb_build_object('from', t.from_status, 'to', t.to_status, 'note', t.note)
                       order by t.from_status, t.to_status)
        from public.sponsorship_status_transitions t
       where t.kind = p_kind
    ), '[]'::jsonb),
    'statuses', case p_kind
      when 'sponsor' then to_jsonb(array['draft','pending','approved','suspended','archived'])
      else to_jsonb(array['draft','scheduled','active','paused','ended','archived'])
    end
  )
$fn$;

-- ----------------------------------------------------------------------------
-- 11 · row-level security and grants
-- ----------------------------------------------------------------------------

do $rls$
declare
  t text;
begin
  foreach t in array array['sponsors', 'sponsorship_packages', 'sponsorships', 'sponsorship_status_transitions', 'sponsorship_config']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end
$rls$;

-- No policies, on purpose, and for the Phase 7 reason: a read grant under RLS with no policy is a door that
-- answers zero rows, which reads like a bug in the app. Every access is through the functions above, which
-- check who is calling.
--
-- `service_role` gets the write privileges the definer functions need. That is not decoration and it is not
-- "the owner will be superuser": a `SECURITY DEFINER` function runs as its owner, and on a hosted Supabase
-- project that owner is a role with table privileges rather than a bypass, so a migration that forgets these
-- grants installs cleanly and then fails the first time anybody saves a sponsor. Delete is deliberately
-- absent on the two tables that hold agreements — archiving is this system's delete, and it is what lets a
-- report answer "who sponsored what in March" a year later.
grant select, insert, update           on table public.sponsors                       to service_role;
grant select, insert, update           on table public.sponsorship_packages           to service_role;
grant select, insert, update, delete   on table public.sponsorships                   to service_role;
grant select                           on table public.sponsorship_status_transitions  to service_role;
grant select, update                   on table public.sponsorship_config             to service_role;
-- No sequences to grant here: every id in this migration is a uuid with `gen_random_uuid()`, and the one
-- bigint in play (`media_assets.id`) belongs to Phase 6, which already granted it.

-- Explicit grants, per function, in a loop over the catalogue rather than written out by hand: the Phase 7
-- lesson is that a `like` pattern misses the function whose name does not fit it, and that shows up at
-- runtime as a 401 no type checker can see. So the loop carries an explicit `in` list for the names the
-- pattern cannot reach, and the verify block below asserts the same set independently.
do $grant$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure::text as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.proname like 'kicklive_sponsor%' or p.proname like 'kicklive_sponsorship%')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    -- The public surface: three functions a stranger may call, each with its own fixed projection.
    if f.proname in ('kicklive_sponsorship_for', 'kicklive_sponsorship_epoch', 'kicklive_sponsor_package_card') then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname <> 'kicklive_sponsorship_touch_epoch' then
      -- The staff surface, granted to `authenticated` and to nobody else. This is the part that is easy to
      -- get wrong in the comfortable direction: these functions all decide the caller's role from the JWT
      -- (`is_admin()` reads `profiles where id = auth.uid()`), and a call made on the **service-role key has
      -- no subject at all** — PostgREST sends only `authorization: Bearer <service key>`, so `auth.uid()` is
      -- NULL, `is_admin()` is false, and every admin write answers ADMIN_ONLY forever. Granting these to
      -- `authenticated` is what lets the Worker call them *as the signed-in admin*, which is the only way the
      -- database's own check can mean anything. It is not a widening: an anonymous caller still has no
      -- execute, a signed-in fan still trips `is_admin()`, the Worker's capability matrix still refuses before
      -- a request is built, and no client role holds a privilege on a table (asserted below).
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    -- `touch_epoch` matches the LIKE but must not be grantable to anyone who can name a function: it writes the
    -- cache version, and its only caller is another definer function in this file. It is excluded above rather
    -- than revoked afterwards, so that the list of exceptions and the list of grants stay one edit apart.
    --
    -- `kicklive_asset_url_for_asset` is deliberately NOT mentioned here, and that is a correction, not an
    -- omission: this loop reaches a function only through `like 'kicklive_sponsor%'`, and that name does not
    -- match it. An earlier draft of this comment claimed the loop left it service-role-only; the loop never
    -- saw it at all, so it kept Phase 6's default `execute(public)` grant — a definer function that turns an
    -- asset id into a stored object key, callable by any stranger. The verification block below now checks
    -- that by name, and the grant is set by name next to it. Matching the pattern is not the same as being
    -- covered.
    null;
  end loop;
end
$grant$;

-- Named, not pattern-matched, for the reason just written down: Phase 6 granted this helper to PUBLIC and the
-- loop above cannot reach it. It answers only for `visibility = 'public'` assets, and it exists so that the
-- band's projection can prefer a freshly uploaded object over the column that was copied from — a caller with
-- the table privilege does not need it, and a caller without one must not be able to use it as an oracle.
revoke all on function public.kicklive_asset_url_for_asset(bigint) from public, anon, authenticated;
grant execute on function public.kicklive_asset_url_for_asset(bigint) to service_role;

-- The three primitives this file calls that other phases own: they must be executable by the definer
-- functions here, and `security definer` does not change what the *function's own* role may execute.
grant execute on function public.is_admin() to service_role;
grant execute on function public.is_admin_or_media() to service_role;
grant execute on function public.touch_updated_at() to service_role;

-- ----------------------------------------------------------------------------
-- 12 · media plane: admit the `sponsors` kind Phase 6 reserved
-- ----------------------------------------------------------------------------

alter table public.media_assets drop constraint if exists media_assets_kind_check;
alter table public.media_assets add constraint media_assets_kind_check check (
  entity_kind in ('teams','players','competitions','seasons','news','team_news','matches','users','advertisements','sponsors')
);

-- ----------------------------------------------------------------------------
-- 13 · verification
-- ----------------------------------------------------------------------------

do $verify$
declare
  n integer;
  k text;
  expected text[] := array[
    'kicklive_sponsor_https_ok',
    'kicklive_sponsor_target_kind_ok',
    'kicklive_sponsor_target_id_ok',
    'kicklive_sponsor_label_ok',
    'kicklive_sponsor_entitlements_ok',
    'kicklive_sponsor_target_exists',
    'kicklive_sponsor_guard_target',
    'kicklive_sponsor_guard_slug',
    'kicklive_sponsor_guard_package_code',
    'kicklive_sponsorship_epoch',
    'kicklive_sponsorship_for',
    'kicklive_sponsor_package_card',
    'kicklive_sponsorship_touch_epoch',
    'kicklive_sponsor_save',
    'kicklive_sponsor_set_status',
    'kicklive_sponsor_package_save',
    'kicklive_sponsorship_save',
    'kicklive_sponsorship_set_status',
    'kicklive_sponsor_reserve_asset',
    'kicklive_sponsor_attach_asset',
    'kicklive_sponsorship_expire_due',
    'kicklive_sponsorship_diagnostics',
    'kicklive_sponsorship_admin_list',
    'kicklive_sponsorship_explain',
    'kicklive_sponsorship_status_transitions',
    'kicklive_asset_url_for_asset'
  ];
  names text[];
begin
  select array_agg(distinct p.proname) into names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like any (array['kicklive_sponsor%', 'kicklive_sponsorship%', 'kicklive_asset_url_for_asset']);
  foreach k in array expected loop
    if not (k = any (names)) then
      raise exception 'kicklive migration verification failed: function % is missing', k;
    end if;
  end loop;
  -- The `touch` function is not in the pattern above, and this is the exact mistake the Phase 7 grant loop
  -- was written to avoid: a name the LIKE cannot reach. Assert it rather than trusting the glob.
  if not exists (select 1 from pg_proc p join pg_namespace nn on nn.oid = p.pronamespace
                   where nn.nspname = 'public' and p.proname = 'kicklive_sponsorship_touch_epoch') then
    raise exception 'kicklive migration verification failed: the epoch writer is missing, so no cache could be invalidated';
  end if;

  -- RLS on every new table, and no client privilege on any of them.
  select count(1) into n from pg_class c join pg_namespace nn on nn.oid = c.relnamespace
   where nn.nspname = 'public' and c.relname in ('sponsors','sponsorship_packages','sponsorships','sponsorship_status_transitions','sponsorship_config')
     and c.relrowsecurity;
  if n <> 5 then
    raise exception 'kicklive migration verification failed: % of 5 sponsorship tables have RLS enabled', n;
  end if;
  if exists (
    select 1 from information_schema.role_table_grants g
     where g.table_schema = 'public'
       and g.table_name in ('sponsors','sponsorship_packages','sponsorships','sponsorship_status_transitions','sponsorship_config')
       and g.grantee in ('anon','authenticated')
  ) then
    raise exception 'kicklive migration verification failed: a client role holds a table privilege on a sponsorship table';
  end if;

  -- The public surface is exactly three functions: the band for a target, the epoch, and the rate card. If a
  -- fourth one day answers `anon`, that is a review, not a refactor — the count is asserted rather than
  -- enumerated because a list of names here is a second place to remember them, and the grants loop above is
  -- where they are actually decided.
  select count(1) into n from pg_proc p join pg_namespace nn on nn.oid = p.pronamespace
   where nn.nspname = 'public' and public.kicklive_has_grant('anon', p.oid::regprocedure::text, 'X')
     and p.proname like 'kicklive_sponsor%';
  if n <> 3 then
    raise exception 'kicklive migration verification failed: anon may execute % sponsorship function(s), expected 3 (the read, the epoch and the rate card)', n;
  end if;

  -- And the shape of the staff grant, stated as the two facts that matter rather than as a count: an
  -- authenticated caller can reach the writers (so `is_admin()` has a subject to judge), and cannot reach the
  -- cache-version writer or the private-object helper at all.
  if not public.kicklive_has_grant('authenticated', 'public.kicklive_sponsor_save(jsonb)', 'X') then
    raise exception 'kicklive migration verification failed: the staff surface is not executable as `authenticated`, so every admin write would arrive with auth.uid() = NULL and be refused by its own is_admin() check';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.kicklive_sponsorship_touch_epoch(boolean)', 'X') then
    raise exception 'kicklive migration verification failed: a client role may bump the sponsorship cache epoch directly';
  end if;
  if public.kicklive_has_grant('authenticated', 'public.kicklive_asset_url_for_asset(bigint)', 'X') then
    raise exception 'kicklive migration verification failed: a client role may trade an asset id for a stored key';
  end if;

  -- The seeded rate card, and the reason a count is checked rather than a name: this migration may be
  -- applied to a database where an operator has already renamed a package, and a label test would fail for
  -- the correct reason. Codes are the stable identity, so codes are what is asserted.
  select count(1) into n from public.sponsorship_packages p
   where p.code = any (array['title','main','match','team','award','media_partner']);
  if n <> 6 then
    raise exception 'kicklive migration verification failed: % of the 6 seeded packages are present', n;
  end if;

  -- The kind the whole media story depends on, and the CHECK that carries it.
  if not exists (
    select 1 from pg_constraint c join pg_namespace nn on nn.oid = c.connamespace
     where c.conname = 'media_assets_kind_check'
       and pg_get_constraintdef(c.oid) like '%sponsors%'
  ) then
    raise exception 'kicklive migration verification failed: media_assets still refuses the sponsors kind, so no logo could be stored';
  end if;

  -- The transitions table: a sponsor may be approved, and a sponsorship may not go from `archived` to
  -- anything. Read as exists(), so absence is the assertion.
  if not exists (select 1 from public.sponsorship_status_transitions t
                  where t.kind = 'sponsor' and t.from_status = 'pending' and t.to_status = 'approved') then
    raise exception 'kicklive migration verification failed: the approval arc is missing';
  end if;
  if exists (select 1 from public.sponsorship_status_transitions t where t.to_status = 'draft' and t.from_status = 'archived') then
    raise exception 'kicklive migration verification failed: an archived record may not be revived into a draft';
  end if;

  -- The singleton config row must exist with a readable epoch, or every cache check below is meaningless.
  select count(1) into n from public.sponsorship_config where id = 1;
  if n <> 1 then
    raise exception 'kicklive migration verification failed: sponsorship_config has no singleton row';
  end if;
end
$verify$;

commit;

-- ----------------------------------------------------------------------------
-- Rollback (deliberately commented; run by hand, in this order, and read it before you run it):
--
--   begin;
--   -- Do not drop the tables if any sponsor has ever been paid: `sponsorships` carries the contract text
--   -- that nothing else in the database holds. Rename them instead, and let Phase 9 decide.
--   alter table public.sponsors rename to sponsors_phase8_retired;
--   alter table public.sponsorships rename to sponsorships_phase8_retired;
--   alter table public.sponsorship_packages rename to sponsorship_packages_phase8_retired;
--   alter table public.sponsorship_status_transitions rename to sponsorship_status_transitions_phase8_retired;
--   alter table public.sponsorship_config rename to sponsorship_config_phase8_retired;
--   drop function public.kicklive_asset_url_for_asset(bigint);
--   -- The media kind CHECK goes back to Phase 7's list, and any `sponsors` assets must be deleted first or
--   -- the constraint will refuse to be added. `media_assets` rows are the only place those keys exist, so
--   -- delete the rows *after* removing the objects from the bucket, not before.
--   delete from public.media_assets where entity_kind = 'sponsors';
--   alter table public.media_assets drop constraint if exists media_assets_kind_check;
--   alter table public.media_assets add constraint media_assets_kind_check check (
--     entity_kind in ('teams','players','competitions','seasons','news','team_news','matches','users','advertisements'));
--   rollback;  -- inspect, then commit
-- ----------------------------------------------------------------------------
