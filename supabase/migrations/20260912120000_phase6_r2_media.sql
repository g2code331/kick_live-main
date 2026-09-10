-- ============================================================================
-- Kick Live — Phase 6 migration: media registry for R2 storage
-- ============================================================================
-- Apply with:  supabase db reset            (local, destructive by design)
--              supabase db push             (staging, then production)
-- or paste this whole file into the Supabase SQL editor and run it once.
--
-- WHAT THIS MIGRATION DOES
--   * Creates public.media_assets — one row per stored object, the registry that
--     makes R2 keys, versions and ownership queryable instead of being folklore
--     inside a URL column.
--   * Creates public.media_operations — the audit trail for destructive and
--     bulk media actions (delete, purge, migration runs, retention sweeps).
--   * Adds public.can_manage_team(integer), the SQL mirror of
--     workers/src/services/teamAccess.ts. Media authorization is a row predicate
--     ("is this club yours?"), not a role name, and it has to be evaluated in SQL
--     because that is where the write happens.
--   * Adds the kicklive_* functions the Cloudflare Worker calls: reserve an
--     upload slot, finalize it, look a key up for the read-through, list an
--     entity's assets, soft-delete / restore / purge, reconcile orphans,
--     diagnose, and migrate one already-published Supabase Storage object.
--   * Grants media.* only to the service role (the Worker). No client key, no
--     client credential: the browser talks to the Worker and the Worker talks to
--     the database.
--
-- WHAT THIS MIGRATION NEVER DOES
--   * No drop table / drop column / delete. Every one of the eight existing
--     `*_url` columns stays exactly where it is and keeps its current meaning,
--     so all ~35 read sites keep rendering. New rows simply hold
--     /api/media/assets/<key> instead of a storage URL, and legacy absolute
--     URLs keep working because nothing inspects them.
--   * No row in media_assets implies a row elsewhere is deleted. `superseded`
--     and `deleted` are statuses, not destruction: an object that is no longer
--     referenced by a row can still be restored until retention expires, and
--     nothing here deletes an R2 object — the Worker does that, only when asked,
--     and only after recording it in media_operations.
--   * Does not force RLS on any table (see 9.6 of
--     docs/NOTIFICATIONS_ARCHITECTURE.md for why the policy set, not the force
--     flag, is what matters for this app's access paths), and does not add any
--     client-visible policy to media_assets: clients go through the functions.
--
-- Ordering matters. media_assets is created first because the functions depend
-- on the table and the verification block at the bottom depends on the
-- functions. Everything is wrapped in begin/commit so a failure mid-way leaves
-- the schema untouched instead of half-built.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1.  media_assets — the registry
-- ---------------------------------------------------------------------------
-- Two things this table exists to make impossible:
--   * an object with no owner and no reason (every row names the entity it
--     belongs to, the actor who stored it, and the version slot it fills);
--   * a URL that points at nothing (the URL a client renders is derived from a
--     row whose status is 'ready', and finalizing a failed upload never touches
--     the entity row at all).
-- entity_id is TEXT on purpose: teams/players/media ids are serial integers and
-- profile ids are uuids. A polymorphic reference cannot be a foreign key, so
-- referential integrity is enforced by the per-kind authorization queries below
-- and by the reconciliation function, not by a constraint. The alternative —
-- six nullable FK columns — would not be more honest and is much harder to read.
create table if not exists public.media_assets (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind     TEXT        NOT NULL,
  entity_id       TEXT        NOT NULL,
  bucket          TEXT        NOT NULL,
  object_key      TEXT        NOT NULL,
  variant         TEXT        NOT NULL DEFAULT 'original',
  version         INTEGER     NOT NULL DEFAULT 1,
  content_type    TEXT,
  byte_size       BIGINT,
  width           INTEGER,
  height          INTEGER,
  sha256          TEXT,
  etag            TEXT,
  visibility      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'uploading',
  alt_text        TEXT,
  source_url      TEXT,
  error           TEXT,
  created_by      UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at        TIMESTAMPTZ,
  superseded_at   TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  media_assets_kind_check check (entity_kind in
    ('teams', 'players', 'competitions', 'seasons', 'news', 'team_news', 'matches', 'users')),
  -- sponsors/ and advertisements/ are documented as reserved prefixes in
  -- docs/R2_MEDIA_ARCHITECTURE.md but are deliberately NOT legal here yet:
  -- there is no table to attach them to, and a CHECK that allows a kind nothing
  -- can authorize is how orphaned objects get made. Phase 7 adds them alongside
  -- its own tables with one alter statement.
  media_assets_variant_check    check (variant ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  media_assets_visibility_check check (visibility in ('public', 'private')),
  media_assets_status_check     check (status in
    ('uploading', 'ready', 'failed', 'superseded', 'deleted', 'purged')),
  -- Only the terminal, storage-holding states carry a digest or dimensions.
  -- Allowing NULL everywhere instead makes it impossible to tell "not an image"
  -- from "nobody looked", which is exactly the question a media bug asks.
  media_assets_digest_check     check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  media_assets_key_check        check (object_key ~ '^[a-z0-9][a-z0-9._/-]{2,509}$'),
  media_assets_size_check       check (byte_size is null or (byte_size > 0 and byte_size <= 26214400)),
  -- Every state transition has a timestamp and no state is silent.
  media_assets_ready_at_check   check (status <> 'ready' or ready_at is not null),
  media_assets_entity_id_check  check (entity_id ~ '^[0-9a-fA-F-]{1,64}$')
);
comment on table public.media_assets is
  'Registry of objects in the R2 media bucket: key, owner entity, version, digest, lifecycle status. Not the render path — the *_url columns on the entities are, and they hold /api/media/assets/<key> for rows created here.';
comment on column public.media_assets.object_key is
  'Full R2 key, unique. Derived by kicklive_asset_object_key, never accepted from a client; the prefix is what authorization decisions are made on.';
comment on column public.media_assets.status is
  'uploading = reserved, no object confirmed. ready = object written and referenced. failed = rejected or write failed. superseded = replaced by a later version, still restorable. deleted = soft-deleted row, object retained. purged = object deleted; terminal.';
comment on column public.media_assets.source_url is
  'The Supabase Storage URL an object was migrated from, kept so migration is idempotent and so a migration can be rolled back by URL rather than by guesswork.';

-- The unique index that makes replacement safe: at most one *ready* asset per
-- entity and variant. Finalizing supersedes the previous one in the same
-- statement, so a retry of the same finalize is a no-op rather than a second
-- logo, and a race between two uploads for the same slot fails on this index
-- instead of silently keeping whichever object landed last.
create unique index if not exists media_assets_one_ready_per_slot_idx
  on public.media_assets (entity_kind, entity_id, variant)
  where status = 'ready';
create index if not exists media_assets_entity_idx
  on public.media_assets (entity_kind, entity_id, status);
create index if not exists media_assets_creator_idx
  on public.media_assets (created_by, status, created_at desc);
-- Two schedulers read this shape: the stale-reservation sweep and the retention
-- sweep. Both ask "which rows have been in a non-ready state since before X".
create index if not exists media_assets_status_created_idx
  on public.media_assets (status, created_at)
  where status in ('uploading', 'failed', 'superseded', 'deleted');

-- ---------------------------------------------------------------------------
-- 2.  media_operations — audit of the destructive and bulk actions
-- ---------------------------------------------------------------------------
-- A media system that can delete user content has to be able to answer "who did
-- this and why" years later. Rows here are insert-only and never updated.
create table if not exists public.media_operations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor        UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,
  asset_id     BIGINT,
  entity_kind  TEXT,
  entity_id    TEXT,
  object_key   TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  media_operations_action_check check (action in
    ('reserve', 'finalize', 'failed', 'soft_delete', 'restore', 'purge',
     'retention_sweep', 'migration_run', 'migration_attach', 'reconcile'))
);
comment on table public.media_operations is
  'Insert-only audit trail for media deletes, purges, retention sweeps and migration runs. Never updated, never deleted by application code.';

-- ---------------------------------------------------------------------------
-- 3.  can_manage_team — the row predicate, in SQL
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_team(p_team_id integer)
returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- Mirror of managedTeamOrNull(): admin is a bypass, a manager only for their own club.
  select public.is_admin() or exists (
    select 1 from public.teams t where t.id = p_team_id and t.owner_id = auth.uid()
  );
$fn$;
comment on function public.can_manage_team(integer) is
  'SQL mirror of workers/src/services/teamAccess.ts: may the current session act on this club? SECURITY DEFINER so the team owner can see a club they manage without any policy change to teams.';

-- ---------------------------------------------------------------------------
-- 4.  Object key derivation
-- ---------------------------------------------------------------------------
-- The one place a key is assembled. Deterministic, and deliberately not
-- configurable: the browser never sends a key, so a compromise of a client
-- cannot put an object somewhere it should not be. `<hash8>` is the first eight
-- hex characters of the content digest, so re-uploading the same bytes to the
-- same slot produces the same key (and therefore no new row), while a different
-- upload to the same slot produces a different key and can be published before
-- the old one is superseded — the object the entity URL points at always exists.
create or replace function public.kicklive_asset_object_key(
  p_entity_kind text,
  p_entity_id   text,
  p_variant     text,
  p_version     integer,
  p_sha256      text,
  p_extension   text
) returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  select trim(both '/' from
    p_entity_kind || '/' || p_entity_id || '/'
    || p_variant || '/v' || p_version::text || '-' || left(lower(p_sha256), 8) || '.' || p_extension
  );
$fn$;
comment on function public.kicklive_asset_object_key(text, text, text, integer, text, text) is
  'The only place an R2 key is assembled: <entity-kind>/<entity-id>/<variant>/v<version>-<hash8>.<ext>. Callers pass components, never a key.';

-- ---------------------------------------------------------------------------
-- 5.  Per-kind policy, in SQL
-- ---------------------------------------------------------------------------
-- Mirrors workers/src/lib/mediaPolicy.ts. Two copies is a smell, and the
-- alternative — the Worker telling the database what the rules are — is worse:
-- a policy that can be passed in is a policy that can be passed wrong. The
-- phase6-media test asserts both sides agree, so a drift fails a test rather
-- than shipping a hole.
create or replace function public.kicklive_asset_visibility(p_entity_kind text)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- Every kind this app has today is public, and the reason is a browser fact rather
  -- than a judgement about privacy: an <img> tag sends no Authorization header, so an
  -- object that is only fetchable with a token cannot be a logo, an avatar or a news
  -- photo at all. Avatars are the closest call and still public, because a profile
  -- picture is already rendered next to a public username for anonymous fans.
  --
  -- 'private' is therefore a supported *state* — the read route refuses it without a
  -- session, `kicklive_asset_authorized` decides it against auth.uid(), the cache class
  -- says no-store, and retention forgets it in 30 days instead of 30 years — and no
  -- entity kind selects it yet. The first kind that needs it (a verification document,
  -- a contract scan) is one line here, and it must be fetched into a blob URL rather
  -- than dropped in a src attribute.
  select 'public';
$fn$;

create or replace function public.kicklive_asset_url_column(p_entity_kind text)
returns text
language sql immutable
set search_path = public, pg_temp
as $fn$
  -- Which column holds the render path for this kind, or NULL when the kind is
  -- asset-only and the caller keeps the URL wherever it likes.
  select case p_entity_kind
    when 'teams'      then 'logo_url'
    when 'players'    then 'photo_url'
    when 'competitions' then 'logo_url'
    when 'news'       then 'image_url'
    when 'team_news'  then 'image_url'
    when 'users'      then 'avatar_url'
    else null
  end;
$fn$;

create or replace function public.kicklive_upload_quota_bytes(p_role text)
returns bigint
language sql stable
as $fn$
  -- Per rolling 24 h. Admin is unlimited because "admin" here is the club of one
  -- person with a checklist, and a quota that trips during a tournament import
  -- would be a support call rather than a protection.
  select case p_role
    when 'admin' then null
    when 'media' then 268435456::bigint
    when 'team_manager' then 134217728::bigint
    when 'referee' then 33554432::bigint
    else 16777216::bigint
  end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6.  reserve — authorize, check quotas, create the uploading row
-- ---------------------------------------------------------------------------
-- Called BEFORE the bytes are written. The row it returns is the upload's
-- reservation: it carries the key, the version slot and the authorization
-- decision, so the Worker writes to a key the database chose.
--
-- Dedupe: a matching (key, sha256) already ready ⇒ skip_upload, because R2 is
-- content-addressed within a slot and storing the same bytes twice buys nothing.
create or replace function public.kicklive_reserve_asset_upload(
  p_entity_kind text,
  p_entity_id   text,
  p_variant     text,
  p_content_type text,
  p_byte_size   bigint,
  p_sha256      text,
  p_width       integer default null,
  p_height      integer default null,
  p_alt_text    text default null
) returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid        uuid := auth.uid();
  v_role       text;
  v_owner      text;
  v_quota      bigint;
  v_used       bigint;
  v_kind       text;
  v_url_col    text;
  v_visibility text;
  v_bucket     text;
  v_version    integer;
  v_key        text;
  v_ext        text;
  v_dup        public.media_assets%rowtype;
  v_row        public.media_assets;
  v_reason     text;
begin
  -- The bucket name is data, not configuration: an environment whose storage is
  -- not bound cannot write a row that claims otherwise.
  v_bucket := nullif(current_setting('kicklive.storage_bucket', true), '');
  if v_bucket is null then
    v_bucket := 'media';
  end if;

  if v_uid is null then
    return jsonb_build_object('status', 'unauthenticated');
  end if;
  if p_variant is distinct from 'original' then
    -- Thumbnails exist in the key space and in the schema, and will be written
    -- by a producer, not by a browser. Accepting a client-supplied variant now
    -- would let a client claim a slot nothing can fill.
    v_reason := 'VARIANT_UNSUPPORTED';
  elsif p_byte_size is null or p_byte_size < 1 or p_byte_size > 26214400 then
    v_reason := 'TOO_LARGE';
  elsif p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    v_reason := 'DIGEST_REQUIRED';
  elsif p_entity_kind not in ('teams', 'players', 'competitions', 'seasons', 'news', 'team_news', 'matches', 'users') then
    v_reason := 'KIND_UNKNOWN';
  end if;
  if v_reason is not null then
    return jsonb_build_object('status', 'rejected', 'reason', v_reason);
  end if;

  v_ext := case lower(coalesce(p_content_type, ''))
    when 'image/png' then 'png'
    when 'image/jpeg' then 'jpg'
    when 'image/webp' then 'webp'
    when 'image/gif' then 'gif'
    when 'video/mp4' then 'mp4'
    else 'bin'
  end;

  select p.role::text into v_role from public.profiles p where p.id = v_uid;
  if v_role is null then
    -- No profile row means no product role; the JWT alone is not a permission.
    return jsonb_build_object('status', 'forbidden', 'reason', 'NO_PROFILE');
  end if;

  -- ── authorization, per kind, as a row predicate ───────────────────────────
  if p_entity_kind = 'users' then
    if p_entity_id <> v_uid::text and not public.is_admin() then
      return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_SELF');
    end if;
  elsif p_entity_kind = 'teams' then
    if not public.can_manage_team(p_entity_id::integer) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_YOUR_CLUB');
    end if;
  elsif p_entity_kind = 'players' then
    if not exists (
      select 1 from public.players pl
      join public.teams t on t.id = pl.team_id
      where pl.id::text = p_entity_id
        and (public.is_admin() or t.owner_id = v_uid)
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_YOUR_CLUB');
    end if;
  elsif p_entity_kind = 'team_news' then
    if not exists (
      select 1 from public.team_news tn
      join public.teams t on t.id = tn.team_id
      where tn.id::text = p_entity_id
        and (public.is_admin() or t.owner_id = v_uid)
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_YOUR_CLUB');
    end if;
  elsif p_entity_kind = 'news' then
    if not exists (
      select 1 from public.media m
      where m.id::text = p_entity_id
        and (public.is_admin_or_media() or m.author_id = v_uid)
    ) then
      return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_YOUR_ARTICLE');
    end if;
  else
    -- competitions, seasons, matches: staff kinds. An upload is a write to
    -- content the club does not own.
    if not public.is_admin_or_media() then
      return jsonb_build_object('status', 'forbidden', 'reason', 'ADMIN_REQUIRED');
    end if;
  end if;

  -- ── duplicate upload: same bytes, same slot ───────────────────────────────
  select * into v_dup from public.media_assets
   where object_key = public.kicklive_asset_object_key(
             p_entity_kind, p_entity_id, p_variant,
             coalesce((select max(a.version) from public.media_assets a
                        where a.entity_kind = p_entity_kind and a.entity_id = p_entity_id), 1),
             p_sha256, v_ext);
  if found then
    return jsonb_build_object('status', 'skip_upload', 'asset', to_jsonb(v_dup));
  end if;

  -- Same content already stored for this entity, any version, any key: nothing
  -- to write, and the entity URL can point at the existing row.
  select * into v_dup from public.media_assets
   where entity_kind = p_entity_kind and entity_id = p_entity_id and variant = p_variant
     and status = 'ready' and sha256 = p_sha256
   order by id desc limit 1;
  if found then
    return jsonb_build_object('status', 'skip_upload', 'asset', to_jsonb(v_dup));
  end if;

  -- ── quota: per role per rolling 24 hours ─────────────────────────────────
  v_quota := public.kicklive_upload_quota_bytes(v_role);
  if v_quota is not null then
    select coalesce(sum(coalesce(byte_size, 0)), 0) into v_used
      from public.media_assets
     where created_by = v_uid and created_at > now() - interval '24 hours'
       and status <> 'failed';
    if v_used + p_byte_size > v_quota then
      return jsonb_build_object(
        'status', 'rejected', 'reason', 'QUOTA_EXCEEDED',
        'quota_bytes', v_quota, 'used_bytes', v_used, 'requested_bytes', p_byte_size
      );
    end if;
  end if;

  v_visibility := public.kicklive_asset_visibility(p_entity_kind);
  v_kind := p_entity_kind;
  select coalesce(max(a.version), 0) + 1 into v_version
    from public.media_assets a
   where a.entity_kind = v_kind and a.entity_id = p_entity_id;

  v_key := public.kicklive_asset_object_key(v_kind, p_entity_id, p_variant, v_version, p_sha256, v_ext);

  insert into public.media_assets (
    entity_kind, entity_id, bucket, object_key, variant, version,
    content_type, byte_size, width, height, sha256, visibility, status, alt_text, created_by
  ) values (
    v_kind, p_entity_id, v_bucket, v_key, p_variant, v_version,
    p_content_type, p_byte_size, p_width, p_height, p_sha256, v_visibility, 'uploading',
    nullif(btrim(coalesce(p_alt_text, '')), ''), v_uid
  ) returning * into v_row;

  insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
  values (v_uid, 'reserve', v_row.id, v_kind, p_entity_id, v_key,
          jsonb_build_object('bytes', p_byte_size, 'content_type', p_content_type, 'version', v_version));

  return jsonb_build_object('status', 'proceed', 'asset', to_jsonb(v_row));
exception
  -- A reserved-but-unused row is a leak, so a refusal that comes from a
  -- constraint or a cast is reported as a rejection, not as a 500: the client
  -- sees the same shape either way and nothing is left in 'ready'.
  when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('status', 'rejected', 'reason', 'RESERVATION_REFUSED');
end;
$fn$;
comment on function public.kicklive_reserve_asset_upload(text, text, text, text, bigint, text, integer, integer, text) is
  'Authorize an upload, apply the per-role 24 h quota, and create the uploading row carrying the key. The browser never chooses a key, a version, a bucket or a visibility.';

-- ---------------------------------------------------------------------------
-- 7.  finalize — record the outcome, then (and only then) publish
-- ---------------------------------------------------------------------------
-- Two shapes of caller: a fresh upload, and a "nothing to write" completion for
-- an object that already exists (which is how a skip_upload reservation is
-- closed out). `p_outcome = 'failed'` records why and leaves the entity row
-- completely alone, which is what "no partially published entity" means in
-- practice: there is no half-published state to roll back because the entity was
-- never touched.
create or replace function public.kicklive_finalize_asset_upload(
  p_asset_id    bigint,
  p_outcome     text,
  p_etag        text default null,
  p_actual_size bigint default null,
  p_reason      text default null
) returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset      public.media_assets%rowtype;
  v_uid        uuid := auth.uid();
  v_url        text;
  v_url_col    text;
  v_sql        text;
  v_attached   boolean := false;
begin
  if p_outcome not in ('stored', 'existing', 'failed') then
    return jsonb_build_object('status', 'rejected', 'reason', 'OUTCOME_UNKNOWN');
  end if;

  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'ASSET_NOT_FOUND');
  end if;
  -- The reservation belongs to whoever made it (and to staff). Finalizing
  -- somebody else's slot would be publishing content into their club.
  if v_asset.created_by is distinct from v_uid and not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_RESERVER');
  end if;
  if v_asset.status = 'ready' then
    -- Idempotent close: a retried finalize reports the asset it already
    -- published instead of duplicating a version or erroring.
    return jsonb_build_object('status', 'ok', 'asset', to_jsonb(v_asset), 'idempotent', true);
  end if;
  if v_asset.status not in ('uploading', 'failed') then
    return jsonb_build_object('status', 'rejected', 'reason', 'ASSET_NOT_PENDING', 'actual', v_asset.status);
  end if;

  -- The size the client claimed and the size the bucket holds must agree. A
  -- mismatch means the bytes were swapped between sniffing and writing, which
  -- is exactly when a quota stops meaning anything — so it is a failure, not a
  -- warning.
  if p_outcome = 'stored' and p_actual_size is not null and p_actual_size is distinct from v_asset.byte_size then
    p_outcome := 'failed';
    p_reason := 'SIZE_MISMATCH';
  end if;

  if p_outcome = 'failed' then
    update public.media_assets
       set status = 'failed', error = left(coalesce(p_reason, 'CLIENT_REPORTED_FAILURE'), 64),
           updated_at = now()
     where id = v_asset.id;
    insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
    values (v_uid, 'failed', v_asset.id, v_asset.entity_kind, v_asset.entity_id, v_asset.object_key,
            jsonb_build_object('reason', p_reason));
    return jsonb_build_object('status', 'failed', 'asset_id', v_asset.id);
  end if;

  -- Supersede the previous occupant of the slot first: the partial unique index
  -- allows exactly one ready row per (kind, entity, variant), so ordering is
  -- the difference between a replacement and a constraint violation. The
  -- superseded object is not deleted: the old version stays restorable, and any
  -- URL still pointing at it keeps working.
  update public.media_assets a
     set status = 'superseded', superseded_at = now(), updated_at = now()
   where a.entity_kind = v_asset.entity_kind
     and a.entity_id = v_asset.entity_id
     and a.variant = v_asset.variant
     and a.status = 'ready'
     and a.id <> v_asset.id;

  update public.media_assets
     set status = 'ready',
         ready_at = now(),
         updated_at = now(),
         error = null,
         etag = coalesce(nullif(p_etag, ''), etag)
   where id = v_asset.id;

  v_url := '/api/media/assets/' || v_asset.object_key;
  v_url_col := public.kicklive_asset_url_column(v_asset.entity_kind);
  if v_url_col is not null then
    -- `v_url_col` comes from a two-branch CASE over a fixed list, so there is
    -- nothing injectable in it; it is dynamic SQL only because the target table
    -- and column vary per kind.
    v_sql := format('update public.%I set %I = $1 where id::text = $2',
      case v_asset.entity_kind when 'users' then 'profiles' else v_asset.entity_kind end, v_url_col);
    execute v_sql using v_url, v_asset.entity_id;
    get diagnostics v_attached = row_count;
  end if;

  insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
  values (v_uid, 'finalize', v_asset.id, v_asset.entity_kind, v_asset.entity_id, v_asset.object_key,
          jsonb_build_object('url', v_url, 'attached', v_attached, 'outcome', p_outcome));

  select * into v_asset from public.media_assets where id = v_asset.id;
  return jsonb_build_object('status', 'ok', 'asset', to_jsonb(v_asset), 'url', v_url, 'attached', v_attached);
end;
$fn$;
comment on function public.kicklive_finalize_asset_upload(bigint, text, text, bigint, text) is
  'Close out a reservation. On failure nothing outside media_assets changes. On success the previous version is superseded and the entity URL column is repointed at /api/media/assets/<key>.';

-- ---------------------------------------------------------------------------
-- 8.  resolve — what the read-through route needs, and nothing more
-- ---------------------------------------------------------------------------
create or replace function public.kicklive_asset_for_key(p_object_key text)
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- One row, three facts, no metadata a stranger can mine: the route needs to
  -- know whether to serve, for how long to cache, and with what content type.
  -- The outer coalesce matters: a lookup that returns no rows is the common
  -- case for a stale link, and the route should read 'unknown' rather than NULL.
  select coalesce(
    (select jsonb_build_object(
        'status', 'ok',
        'id', a.id,
        'visibility', a.visibility,
        'content_type', a.content_type,
        'byte_size', a.byte_size,
        'etag', a.etag,
        -- No `cache_class` here on purpose. How long a byte string may be held by a
        -- shared cache follows from the shape of the key (a versioned key is
        -- immutable), which is an HTTP concern and lives in
        -- workers/src/lib/mediaPolicy.ts. Duplicating it in SQL would give two
        -- answers to one question and only one of them would be the header a client
        -- actually receives.
        'entity_kind', a.entity_kind,
        'entity_id', a.entity_id
      )
      from public.media_assets a
      -- A superseded object stays readable on purpose: old documents, old push
      -- payloads and old shared links still reference it, and it is immutable by
      -- key, so serving it is both safe and the point of keeping it.
      where a.object_key = p_object_key
        and a.status in ('ready', 'superseded')),
    jsonb_build_object('status', 'unknown')
  );
$fn$;
comment on function public.kicklive_asset_for_key(text) is
  'Read-through lookup for GET /media/assets/*: status, visibility, content type, size, etag and the cache class. Returns unknown/gone rather than metadata for anything not serveable.';

create or replace function public.kicklive_asset_authorized(p_object_key text)
returns boolean
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- Private means private: the owner and staff, never the world, and the check
  -- runs on every request rather than being baked into an unguessable URL.
  select case a.visibility
           when 'public' then true
           else a.created_by = auth.uid() or public.is_admin()
         end
  from public.media_assets a
  where a.object_key = p_object_key and a.status in ('ready', 'superseded');
$fn$;

-- ---------------------------------------------------------------------------
-- 9.  list / delete / restore / purge
-- ---------------------------------------------------------------------------
create or replace function public.kicklive_entity_assets(p_entity_kind text, p_entity_id text)
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  -- Every version the caller is allowed to see, newest first. `deleted_ok`
  -- decides whether the caller may even ask about this entity, which is the same
  -- predicate reserve used, so the list cannot leak a club somebody else owns.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id, 'version', a.version, 'variant', a.variant, 'status', a.status,
        'object_key', a.object_key, 'content_type', a.content_type, 'byte_size', a.byte_size,
        'width', a.width, 'height', a.height, 'visibility', a.visibility,
        'created_at', a.created_at, 'ready_at', a.ready_at, 'superseded_at', a.superseded_at
      ) order by a.version desc, a.id desc
    ), '[]'::jsonb
  )
  from public.media_assets a
  where a.entity_kind = p_entity_kind
    and a.entity_id = p_entity_id
    and (
      public.is_admin()
      or (p_entity_kind = 'users' and (a.entity_id = auth.uid()::text or a.created_by = auth.uid()))
      or (p_entity_kind = 'teams' and public.can_manage_team(a.entity_id::integer))
      or (p_entity_kind in ('players', 'team_news') and exists (
            select 1 from public.teams t
            where t.owner_id = auth.uid()
              and t.id = case when p_entity_kind = 'players'
                              then (select pl.team_id from public.players pl where pl.id::text = a.entity_id)
                              else (select tn.team_id from public.team_news tn where tn.id::text = a.entity_id)
                          end))
      or (p_entity_kind = 'news' and exists (
            select 1 from public.media m where m.id::text = a.entity_id and m.author_id = auth.uid()))
      or (a.created_by = auth.uid() and a.status = 'uploading')
    );
$fn$;
comment on function public.kicklive_entity_assets(text, text) is
  'Version history for one entity, filtered by the same ownership predicate that authorizes uploads. Returns [] rather than an error when the caller may not see the entity.';

create or replace function public.kicklive_delete_asset(p_asset_id bigint, p_purge boolean default false)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_uid   uuid := auth.uid();
  v_sql   text;
begin
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'ASSET_NOT_FOUND');
  end if;
  if v_asset.created_by is distinct from v_uid and not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_OWNER');
  end if;
  if p_purge and not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'PURGE_ADMIN_ONLY');
  end if;
  if v_asset.status = 'purged' then
    return jsonb_build_object('status', 'ok', 'idempotent', true, 'action', 'purged');
  end if;

  update public.media_assets
     set status = 'deleted', deleted_at = now(), updated_at = now()
   where id = v_asset.id and v_asset.status <> 'deleted';

  if p_purge then
    update public.media_assets set status = 'purged', updated_at = now() where id = v_asset.id;
    insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
    values (v_uid, 'purge', v_asset.id, v_asset.entity_kind, v_asset.entity_id, v_asset.object_key,
            jsonb_build_object('bytes', v_asset.byte_size));
    -- The registry row survives with status 'purged' rather than being deleted:
    -- "we stored this, it is gone now, here is who removed it" is the answer an
    -- investigation needs, and the row costs nothing.
  else
    insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
    values (v_uid, 'soft_delete', v_asset.id, v_asset.entity_kind, v_asset.entity_id, v_asset.object_key, null);
  end if;

  -- Deleting the current version must not leave the entity pointing at an
  -- object that is being purged. The partial unique index guarantees no other
  -- ready row for this slot, so the honest behaviour is to clear the column and
  -- let the UI fall back to its placeholder — inventing a "previous" URL here
  -- would mean guessing which superseded version the owner wanted back.
  if v_asset.status = 'ready' and public.kicklive_asset_url_column(v_asset.entity_kind) is not null then
    v_sql := format('update public.%I set %I = null where id::text = $1',
      case v_asset.entity_kind when 'users' then 'profiles' else v_asset.entity_kind end,
      public.kicklive_asset_url_column(v_asset.entity_kind));
    execute v_sql using v_asset.entity_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'action', case when p_purge then 'purged' else 'soft_deleted' end,
    'object_key', v_asset.object_key,
    'bucket', v_asset.bucket,
    'delete_object', p_purge,
    'restore_days', case when p_purge then 0 else 30 end
  );
end;
$fn$;
comment on function public.kicklive_delete_asset(bigint, boolean) is
  'Soft delete by default: the row and the object both stay, the URL stops resolving to it, and restore is available for 30 days. Purge (admin only) marks the row purged and asks the caller to delete the object; nothing here deletes an object.';

create or replace function public.kicklive_restore_asset(p_asset_id bigint)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_uid   uuid := auth.uid();
begin
  select * into v_asset from public.media_assets where id = p_asset_id for update;
  if not found then
    return jsonb_build_object('status', 'rejected', 'reason', 'ASSET_NOT_FOUND');
  end if;
  if v_asset.created_by is distinct from v_uid and not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'NOT_OWNER');
  end if;
  if v_asset.status not in ('deleted', 'superseded') then
    return jsonb_build_object('status', 'rejected', 'reason', 'NOT_RESTORABLE', 'actual', v_asset.status);
  end if;

  -- Restoring supersedes whatever took the slot, because "one current version"
  -- is the invariant the render path relies on.
  update public.media_assets a set status = 'superseded', superseded_at = now(), updated_at = now()
   where a.entity_kind = v_asset.entity_kind and a.entity_id = v_asset.entity_id
     and a.variant = v_asset.variant and a.status = 'ready' and a.id <> v_asset.id;

  update public.media_assets
     set status = 'ready', ready_at = coalesce(ready_at, now()), superseded_at = null,
         deleted_at = null, updated_at = now()
   where id = v_asset.id;

  insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
  values (v_uid, 'restore', v_asset.id, v_asset.entity_kind, v_asset.entity_id, v_asset.object_key, null);

  return jsonb_build_object('status', 'ok', 'asset_id', v_asset.id);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 10.  retention sweep and orphan reconciliation
-- ---------------------------------------------------------------------------
-- Which rows are old enough to forget is a database decision (it needs created_at
-- and status); which objects to actually delete is a storage decision (it needs
-- the bucket). So the function returns keys and the Worker deletes them, once
-- per hour, inside a batch.
create or replace function public.kicklive_sweep_media(p_limit integer default 500)
returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows jsonb;
  v_n    integer;
begin
  if not public.is_admin() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  -- Abandoned reservations: 'uploading' rows older than 24 h are a client that
  -- never came back. They expire to 'failed' rather than being deleted, because
  -- the object may well exist and an unexplained disappearance is worse than a
  -- recorded failure. Bounded, because this runs on a cron next to everything
  -- else the Worker does at :00.
  update public.media_assets
     set status = 'failed', error = 'RESERVATION_EXPIRED', updated_at = now()
   where id in (
     select a.id from public.media_assets a
      where a.status = 'uploading' and a.created_at < now() - interval '24 hours'
      order by a.id limit p_limit
   );
  get diagnostics v_n = row_count;

  -- Expired soft deletes and superseded versions, past their retention window.
  -- Private objects are forgotten sooner than public ones: "delete" for a private
  -- upload has to mean the bytes stop being served, not just that the URL moved.
  -- No kind is private today, so this branch is the mechanism waiting for the first
  -- one rather than a rule anybody can observe, which is why the media tests
  -- exercise it directly against a fake registry.
  update public.media_assets
     set status = 'purged', updated_at = now()
   where id in (
     select a.id from public.media_assets a
      where (a.status in ('deleted', 'superseded')
             and coalesce(a.deleted_at, a.superseded_at) < now() - interval '30 days')
         or (a.status in ('ready', 'deleted', 'superseded')
             and a.visibility = 'private'
             and a.created_at < now() - interval '30 days')
      order by a.id limit p_limit
   );

  select coalesce(jsonb_agg(jsonb_build_object('object_key', x.object_key, 'id', x.id)), '[]'::jsonb) into v_rows
  from (
    select a.id, a.object_key from public.media_assets a
     where a.status = 'purged' and a.updated_at > now() - interval '10 minutes'
     order by a.id limit p_limit
  ) x;

  insert into public.media_operations (actor, action, detail)
  values (auth.uid(), 'retention_sweep', jsonb_build_object('expired_reservations', v_n, 'purged', v_rows));

  return jsonb_build_object('status', 'ok', 'expired_reservations', v_n, 'keys_to_delete', v_rows);
end;
$fn$;
comment on function public.kicklive_sweep_media(integer) is
  'Hourly retention step: expires stale reservations, retires objects past their retention window, and returns the object keys the Worker must delete from R2. Admin-only because it is the only function that decides something should stop existing.';

-- The other half of reconciliation: the Worker lists the bucket, the database
-- says which of those keys are known and which registry rows have no object.
-- Doing the set difference in SQL keeps the comparison exact instead of
-- "downloaded a few hundred rows and eyeballed it".
create or replace function public.kicklive_reconcile_assets(p_live_keys jsonb, p_prefix text default null)
returns jsonb
language plpgsql stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_orphans jsonb;
  v_missing jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('status', 'forbidden');
  end if;

  select coalesce(jsonb_agg(k.value), '[]'::jsonb) into v_orphans
  from jsonb_array_elements_text(coalesce(p_live_keys, '[]'::jsonb)) as k(value)
  where not exists (select 1 from public.media_assets a where a.object_key = k.value);

  select coalesce(jsonb_agg(a.object_key), '[]'::jsonb) into v_missing
  from public.media_assets a
  where a.status in ('ready', 'superseded')
    and (p_prefix is null or a.object_key like replace(p_prefix, '*', '') || '%')
    and not exists (
      select 1 from jsonb_array_elements_text(coalesce(p_live_keys, '[]'::jsonb)) as k(value)
      where k.value = a.object_key
    );

  return jsonb_build_object(
    'status', 'ok',
    'objects_without_rows', v_orphans,
    'rows_without_objects', v_missing,
    'compared', jsonb_array_length(coalesce(p_live_keys, '[]'::jsonb))
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 11.  diagnostics
-- ---------------------------------------------------------------------------
create or replace function public.kicklive_asset_diagnostics()
returns jsonb
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'status', 'ok',
    'by_status', (
      select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
      from (select a.status, count(*) n from public.media_assets a group by a.status) s
    ),
    'by_kind', (
      select coalesce(jsonb_object_agg(k.entity_kind, k.n), '{}'::jsonb)
      from (select a.entity_kind, count(*) n from public.media_assets a where a.status = 'ready' group by a.entity_kind) k
    ),
    'total_bytes', (select coalesce(sum(a.byte_size), 0) from public.media_assets a where a.status in ('ready', 'superseded')),
    'uploading_over_1h', (select count(*) from public.media_assets a where a.status = 'uploading' and a.created_at < now() - interval '1 hour'),
    'ready_missing_digest', (select count(*) from public.media_assets a where a.status = 'ready' and a.sha256 is null),
    'still_url_pointing_at_storage', (
      select coalesce(jsonb_object_agg(t.kind, t.n), '{}'::jsonb)
      from (
        select 'media' kind, count(*) n from public.media where image_url like '%/storage/v1/object/%'
        union all select 'team_news', count(*) from public.team_news where image_url like '%/storage/v1/object/%'
        union all select 'teams', count(*) from public.teams where logo_url like '%/storage/v1/object/%'
        union all select 'players', count(*) from public.players where photo_url like '%/storage/v1/object/%'
        union all select 'competitions', count(*) from public.competitions where logo_url like '%/storage/v1/object/%'
        union all select 'profiles', count(*) from public.profiles where avatar_url like '%/storage/v1/object/%'
      ) t
    ),
    'operations_last_24h', (
      select coalesce(jsonb_object_agg(o.action, o.n), '{}'::jsonb)
      from (select m.action, count(*) n from public.media_operations m where m.created_at > now() - interval '24 hours' group by m.action) o
    )
  );
$fn$;

-- The migration's cheap question. `failed` rows are deliberately *not* an answer:
-- a re-run is the recovery step for an object whose copy broke halfway, so only a
-- settled state (in the bucket, or consciously skipped) counts as "seen".
create or replace function public.kicklive_migration_seen(p_source_url text)
returns text
language sql stable
security definer
set search_path = public, pg_temp
as $fn$
  select a.object_key
  from public.media_assets a
  where a.source_url = p_source_url and a.status in ('ready', 'deleted')
  order by a.id desc
  limit 1;
$fn$;

-- ---------------------------------------------------------------------------
-- 12.  migration record — one row per already-published object
-- ---------------------------------------------------------------------------
-- The migration itself reads and writes the bucket, which only the Worker can
-- do. What the database owns is the *record*: this function is idempotent on the
-- source URL, so a migration run that dies halfway can be re-run and only the
-- objects that are actually in R2 become attached to entities.
create or replace function public.kicklive_record_migrated_asset(
  p_entity_kind text,
  p_entity_id   text,
  p_object_key  text,
  p_content_type text,
  p_byte_size   bigint,
  p_sha256      text,
  p_source_url  text,
  p_outcome     text,
  p_reason      text default null
) returns jsonb
language plpgsql volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_asset   public.media_assets%rowtype;
  v_uid     uuid := auth.uid();
  v_url     text;
  v_url_col text;
begin
  if not public.is_admin() then
    return jsonb_build_object('status', 'forbidden', 'reason', 'ADMIN_REQUIRED');
  end if;
  if p_outcome not in ('migrated', 'skipped', 'failed') then
    return jsonb_build_object('status', 'rejected', 'reason', 'OUTCOME_UNKNOWN');
  end if;

  -- Same source URL, seen before: report it, change nothing. This is what makes
  -- re-running the migration safe rather than merely unlikely to duplicate.
  select * into v_asset from public.media_assets
   where source_url = p_source_url and entity_kind = p_entity_kind and entity_id = p_entity_id
   order by id desc limit 1;
  if found then
    return jsonb_build_object('status', 'ok', 'idempotent', true, 'asset', to_jsonb(v_asset),
                              'prior_status', v_asset.status);
  end if;

  if p_outcome = 'failed' then
    insert into public.media_assets (
      entity_kind, entity_id, bucket, object_key, variant, content_type, byte_size, sha256,
      visibility, status, source_url, error, created_by
    ) values (
      p_entity_kind, p_entity_id, 'media', p_object_key, 'original', p_content_type, p_byte_size, p_sha256,
      public.kicklive_asset_visibility(p_entity_kind), 'failed', p_source_url,
      left(coalesce(p_reason, 'MIGRATION_FAILED'), 64), v_uid
    );
    return jsonb_build_object('status', 'recorded', 'state', 'failed');
  end if;

  if p_outcome = 'skipped' then
    -- A skipped object is recorded as 'deleted' rather than inventing a status:
    -- it is registered, not in R2, and must not be counted as an orphan.
    insert into public.media_assets (
      entity_kind, entity_id, bucket, object_key, variant, content_type, byte_size, sha256,
      visibility, status, source_url, error, created_by
    ) values (
      p_entity_kind, p_entity_id, 'supabase-storage', p_object_key, 'original', p_content_type, p_byte_size, p_sha256,
      public.kicklive_asset_visibility(p_entity_kind), 'deleted', p_source_url,
      left(coalesce(p_reason, 'SKIPPED'), 64), v_uid
    );
    return jsonb_build_object('status', 'recorded', 'state', 'skipped');
  end if;

  insert into public.media_assets (
    entity_kind, entity_id, bucket, object_key, variant, version, content_type, byte_size, sha256,
    visibility, status, source_url, ready_at, created_by
  ) values (
    p_entity_kind, p_entity_id, 'media', p_object_key, 'original', 1, p_content_type, p_byte_size, p_sha256,
    public.kicklive_asset_visibility(p_entity_kind), 'ready', p_source_url, now(), v_uid
  ) returning * into v_asset;

  v_url := '/api/media/assets/' || v_asset.object_key;
  v_url_col := public.kicklive_asset_url_column(p_entity_kind);
  if v_url_col is not null then
    execute format('update public.%I set %I = $1 where id::text = $2',
      case p_entity_kind when 'users' then 'profiles' else p_entity_kind end, v_url_col)
      using v_url, p_entity_id;
    insert into public.media_operations (actor, action, asset_id, entity_kind, entity_id, object_key, detail)
    values (v_uid, 'migration_attach', v_asset.id, p_entity_kind, p_entity_id, p_object_key,
            jsonb_build_object('from', p_source_url, 'to', v_url));
  end if;

  return jsonb_build_object('status', 'migrated', 'asset', to_jsonb(v_asset), 'url', v_url);
end;
$fn$;
comment on function public.kicklive_record_migrated_asset(text, text, text, text, bigint, text, text, text, text) is
  'Idempotent record of one migrated Supabase Storage object. Attaches the entity URL only for outcome=migrated, so a failure leaves the working legacy URL in place.';

-- ---------------------------------------------------------------------------
-- 13.  RLS posture + grants
-- ---------------------------------------------------------------------------
-- media_assets has no policies and no direct grants: it is readable only through
-- the functions above, which carry their own authorization. Enabling RLS anyway
-- means "deny by default" is true even if a later migration grants `select` and
-- forgets a policy — the failure mode that RLS exists to catch.
alter table public.media_assets enable row level security;
alter table public.media_operations enable row level security;

revoke all on table public.media_assets from anon, authenticated, service_role;
revoke all on table public.media_operations from anon, authenticated, service_role;

-- The Worker uses the service role and cannot be denied by a client policy, but
-- it does need the grant, and it is deliberately narrow: insert and select, no
-- update and no delete. `update` and `delete` on the registry belong to the
-- functions, which is what keeps a status transition from skipping its
-- bookkeeping. media_operations is insert/select only for the same reason — an
-- audit trail an application can edit is a suggestion.
grant select, insert on table public.media_assets to service_role;
grant select, insert on table public.media_operations to service_role;

-- Deliberately no grant to `anon` or `authenticated`: every client-facing read
-- of the registry is a function that filters by owner, and every write is a
-- function that authorizes per kind. A table grant would be a second, unfiltered
-- door that the checks above would then have to police.
do $grant$
declare
  r record;
  n integer := 0;
begin
  for r in
    select p.proname,
           pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind = 'f'
      -- The sweep and the migration pre-check are named for what they do, not for
      -- `media_assets`, and a grant loop that misses a function is a 401 on a
      -- route that typechecks — so the list is explicit instead of pattern-only.
      and (p.proname like 'kicklive_%asset%' or p.proname in
           ('kicklive_sweep_media', 'kicklive_migration_seen', 'kicklive_upload_quota_bytes'))
  loop
    execute format('revoke all on function public.%I(%s) from public', r.proname, r.args);
    execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
    -- The four the browser calls directly, with identity from auth.uid() inside.
    if r.proname in ('kicklive_reserve_asset_upload', 'kicklive_finalize_asset_upload',
                     'kicklive_entity_assets', 'kicklive_delete_asset', 'kicklive_restore_asset') then
      execute format('grant execute on function public.%I(%s) to authenticated', r.proname, r.args);
    end if;
    n := n + 1;
  end loop;
  raise notice 'kicklive: media grants applied to % asset functions', n;
end
$grant$;

-- ---------------------------------------------------------------------------
-- 14.  verification
-- ---------------------------------------------------------------------------
-- The Phase 5 lesson, applied: every check below is derived from the catalog, so
-- a function that was renamed or forgotten fails this block rather than shipping.
do $verify$
declare
  r record;
  n bigint;
  expected text[] := array[
    'kicklive_asset_object_key', 'kicklive_asset_visibility', 'kicklive_asset_url_column',
    'kicklive_upload_quota_bytes', 'kicklive_reserve_asset_upload', 'kicklive_finalize_asset_upload',
    'kicklive_asset_for_key', 'kicklive_asset_authorized', 'kicklive_entity_assets',
    'kicklive_delete_asset', 'kicklive_restore_asset', 'kicklive_sweep_media',
    'kicklive_reconcile_assets', 'kicklive_asset_diagnostics', 'kicklive_record_migrated_asset',
    'kicklive_migration_seen'
  ];
begin
  for r in select unnest(expected) as name loop
    if to_regclass('public.media_assets') is null then
      raise exception 'kicklive migration verification failed: public.media_assets does not exist (function %)', r.name;
    end if;
    select count(*) into n from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = r.name;
    if n = 0 then
      raise exception 'kicklive migration verification failed: public.% is missing', r.name;
    end if;
  end loop;

  -- The definer invariant, the same one as Phase 5: a function that reads the
  -- registry on a client's behalf must pin its search_path or a malicious
  -- `media_assets` in another schema wins.
  for r in
    select p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind = 'f'
      and (p.proname like 'kicklive_%asset%' or p.proname in ('kicklive_sweep_media', 'kicklive_migration_seen', 'can_manage_team'))
      and p.prosecdef = false
      -- The four pure helpers have no privilege to inherit and nothing to leak.
      and p.proname not in ('kicklive_asset_object_key', 'kicklive_asset_visibility',
                            'kicklive_asset_url_column', 'kicklive_upload_quota_bytes')
  loop
    raise exception 'kicklive migration verification failed: % must be security definer', r.proname;
  end loop;
  for r in
    select p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind = 'f'
      and p.proname like 'kicklive_%asset%'
      and p.proconfig::text not like '%search_path=public%'
  loop
    raise exception 'kicklive migration verification failed: % must pin search_path', r.proname;
  end loop;

  -- No policy on media_assets: the table is reachable only through functions.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'media_assets';
  if n <> 0 then
    raise exception 'kicklive migration verification failed: media_assets must have no policies, found %', n;
  end if;

  -- The invariant that makes replacement safe, and the one that makes an
  -- idempotent finalize possible.
  select count(*) into n from pg_indexes where schemaname = 'public' and tablename = 'media_assets'
   and indexname = 'media_assets_one_ready_per_slot_idx';
  if n <> 1 then
    raise exception 'kicklive migration verification failed: media_assets_one_ready_per_slot_idx missing';
  end if;

  -- No client role holds any table privilege on the registry: writes go through
  -- the functions, which is what keeps a status transition from skipping its
  -- bookkeeping, and reads go through functions that filter by owner. If this
  -- ever fires, a later migration has handed the browser a path around the
  -- authorization checks.
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'media_assets'
     and grantee in ('anon', 'authenticated');
  if n <> 0 then
    raise exception 'kicklive migration verification failed: client roles hold % grant(s) on media_assets', n;
  end if;

  raise notice 'kicklive: media registry verified (% functions, % policies on media_assets)',
    array_length(expected, 1), n;
end
$verify$;

commit;

notify pgrst, 'reload schema';
