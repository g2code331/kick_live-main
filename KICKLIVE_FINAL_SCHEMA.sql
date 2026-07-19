-- ================================================================
-- KICKLIVE — COMPLETE DATABASE SQL
-- ================================================================
-- Run this ONCE in: Supabase Dashboard → SQL Editor → New Query
--
-- ✅ Safe on an EXISTING database — every statement uses
--    IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE
--    so nothing is dropped or overwritten accidentally.
--
-- ✅ Safe on a BRAND-NEW database — creates everything from scratch.
--
-- Tables covered (15 total):
--   profiles · teams · players · seasons · competitions · matches
--   match_events · match_commentary · match_statistics · media
--   team_news · notifications · activity_logs · standings · team_staff
-- ================================================================


-- ────────────────────────────────────────────────────────────────
-- SECTION 1 — EXTENSION
-- ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ────────────────────────────────────────────────────────────────
-- SECTION 2 — HELPER FUNCTIONS (role checks used by RLS)
-- SECURITY DEFINER means they bypass RLS internally → no recursion
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_media()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'media')
  );
$$;


-- ────────────────────────────────────────────────────────────────
-- SECTION 3 — CREATE TABLES (idempotent)
-- ────────────────────────────────────────────────────────────────

-- ── 3.1  profiles ───────────────────────────────────────────────
--  One row per authenticated user. Created automatically by trigger.
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT        UNIQUE NOT NULL,
  username    TEXT        NOT NULL,
  phone       TEXT,
  role        TEXT        NOT NULL DEFAULT 'fan'
                          CHECK (role IN ('admin', 'fan', 'team_manager', 'media')),
  avatar_url  TEXT,
  team_id     INTEGER,            -- soft link to teams.id (display only)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.2  teams ──────────────────────────────────────────────────
--  A club / team. Can be created by a team_manager (status = 'pending')
--  and approved by an admin (status = 'active').
CREATE TABLE IF NOT EXISTS public.teams (
  id              SERIAL      PRIMARY KEY,
  name            TEXT        NOT NULL,
  short_name      TEXT        NOT NULL,
  city            TEXT,
  venue           TEXT,                          -- stadium / ground
  coach           TEXT,                          -- head coach name
  primary_color   TEXT        DEFAULT '#39FF14',
  secondary_color TEXT        DEFAULT '#000000',
  logo_url        TEXT,
  owner_id        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  status          TEXT        DEFAULT 'active'
                              CHECK (status IN ('pending', 'active', 'rejected')),
  gallery         JSONB,      -- [{url, caption}] — team photo gallery
  lineup          JSONB,      -- {formation, players:[]} — starting XI set by manager
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.3  players ────────────────────────────────────────────────
--  Squad members belonging to a team.
CREATE TABLE IF NOT EXISTS public.players (
  id              SERIAL      PRIMARY KEY,
  team_id         INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  position        TEXT        NOT NULL,          -- e.g. 'Goalkeeper', 'Midfielder'
  number          INTEGER     NOT NULL,          -- shirt number
  nationality     TEXT,
  age             INTEGER,                       -- stored directly (quick display)
  date_of_birth   DATE,
  height          INTEGER,                       -- cm
  weight          INTEGER,                       -- kg
  photo_url       TEXT,
  goals           INTEGER     DEFAULT 0,
  assists         INTEGER     DEFAULT 0,
  yellow_cards    INTEGER     DEFAULT 0,
  red_cards       INTEGER     DEFAULT 0,
  appearances     INTEGER     DEFAULT 0,
  status          TEXT        DEFAULT 'active'
                              CHECK (status IN ('active', 'injured', 'suspended', 'transferred')),
  market_value    INTEGER,                       -- in local currency
  contract_until  DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.4  seasons ────────────────────────────────────────────────
--  Season management (used by SeasonManagement admin panel).
CREATE TABLE IF NOT EXISTS public.seasons (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL,              -- e.g. 'Season 2025'
  year        TEXT        NOT NULL,              -- e.g. '2025'
  status      TEXT        DEFAULT 'active'
                          CHECK (status IN ('active', 'completed', 'archived')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.5  competitions ───────────────────────────────────────────
--  Tournaments / leagues.
CREATE TABLE IF NOT EXISTS public.competitions (
  id              SERIAL      PRIMARY KEY,
  season_id       INTEGER     REFERENCES public.seasons(id) ON DELETE SET NULL,
  name            TEXT        NOT NULL,
  type            TEXT        NOT NULL
                              CHECK (type IN ('league', 'cup', 'knockout')),
  season          TEXT        DEFAULT '2025',   -- human-readable label
  start_date      DATE,
  end_date        DATE,
  format          TEXT,
  status          TEXT        DEFAULT 'upcoming'
                              CHECK (status IN ('upcoming', 'live', 'completed', 'cancelled')),
  logo_url        TEXT,
  prize_money     INTEGER,
  current_round   TEXT,
  total_teams     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.6  matches ────────────────────────────────────────────────
--  Individual match fixture with live-score support.
CREATE TABLE IF NOT EXISTS public.matches (
  id                              SERIAL      PRIMARY KEY,
  competition_id                  INTEGER     REFERENCES public.competitions(id) ON DELETE CASCADE,
  season_id                       INTEGER     REFERENCES public.seasons(id) ON DELETE SET NULL,
  home_team_id                    INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  away_team_id                    INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  home_score                      INTEGER     DEFAULT 0,
  away_score                      INTEGER     DEFAULT 0,
  status                          TEXT        DEFAULT 'scheduled'
                                              CHECK (status IN (
                                                'scheduled', 'waiting',
                                                'first_half', 'half_time', 'second_half',
                                                'extra_time', 'penalty_shootout',
                                                'full_time', 'suspended', 'postponed',
                                                'abandoned', 'cancelled', 'completed', 'live'
                                              )),
  start_time                      TIMESTAMPTZ NOT NULL,
  venue                           TEXT,
  minute                          INTEGER     DEFAULT 0,
  matchday                        INTEGER     DEFAULT 1,
  "group"                         TEXT,
  round                           TEXT,
  attendance                      INTEGER,
  referee                         TEXT,
  -- Timer physics columns (zero-bandwidth live timer)
  match_start_time                TIMESTAMPTZ,
  elapsed_seconds_before_pause    INTEGER     DEFAULT 0,
  -- Admin controls
  is_locked                       BOOLEAN     DEFAULT FALSE,
  confirmed_at                    TIMESTAMPTZ,
  -- Environmental
  weather                         TEXT,
  temperature                     INTEGER,
  created_at                      TIMESTAMPTZ DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.7  match_events ───────────────────────────────────────────
--  Goals, cards, substitutions, etc.
CREATE TABLE IF NOT EXISTS public.match_events (
  id                SERIAL  PRIMARY KEY,
  match_id          INTEGER REFERENCES public.matches(id) ON DELETE CASCADE,
  team_id           INTEGER REFERENCES public.teams(id) ON DELETE SET NULL,
  player_id         INTEGER REFERENCES public.players(id) ON DELETE SET NULL,
  assist_player_id  INTEGER REFERENCES public.players(id) ON DELETE SET NULL,
  event_type        TEXT    NOT NULL
                            CHECK (event_type IN (
                              'kickoff', 'goal', 'own_goal', 'penalty_goal', 'penalty_missed',
                              'yellow_card', 'second_yellow', 'red_card',
                              'substitution', 'substitution_off', 'substitution_on',
                              'corner', 'offside', 'free_kick', 'throw_in', 'goal_kick',
                              'var_check', 'var_overturned', 'injury', 'water_break',
                              'half_time', 'second_half_start',
                              'extra_time_start', 'extra_time_half_time',
                              'penalty_shootout_start', 'full_time', 'match_abandoned'
                            )),
  minute            INTEGER NOT NULL,
  extra_minute      INTEGER DEFAULT 0,
  description       TEXT,
  goal_type         TEXT    CHECK (goal_type IN (
                              'normal', 'header', 'penalty', 'free_kick',
                              'own_goal', 'volley', 'long_shot', 'tap_in'
                            )),
  card_reason       TEXT,
  video_url         TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.8  match_commentary ───────────────────────────────────────
--  Live text commentary lines for a match.
CREATE TABLE IF NOT EXISTS public.match_commentary (
  id            SERIAL      PRIMARY KEY,
  match_id      INTEGER     REFERENCES public.matches(id) ON DELETE CASCADE,
  minute        INTEGER     NOT NULL,
  comment       TEXT        NOT NULL,
  is_important  BOOLEAN     DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.9  match_statistics ───────────────────────────────────────
--  Aggregated stats per match (one row per match).
CREATE TABLE IF NOT EXISTS public.match_statistics (
  id                    SERIAL      PRIMARY KEY,
  match_id              INTEGER     UNIQUE REFERENCES public.matches(id) ON DELETE CASCADE,
  home_possession       INTEGER     DEFAULT 50,
  away_possession       INTEGER     DEFAULT 50,
  home_shots            INTEGER     DEFAULT 0,
  away_shots            INTEGER     DEFAULT 0,
  home_shots_on_target  INTEGER     DEFAULT 0,
  away_shots_on_target  INTEGER     DEFAULT 0,
  home_corners          INTEGER     DEFAULT 0,
  away_corners          INTEGER     DEFAULT 0,
  home_offsides         INTEGER     DEFAULT 0,
  away_offsides         INTEGER     DEFAULT 0,
  home_fouls            INTEGER     DEFAULT 0,
  away_fouls            INTEGER     DEFAULT 0,
  home_yellow_cards     INTEGER     DEFAULT 0,
  away_yellow_cards     INTEGER     DEFAULT 0,
  home_red_cards        INTEGER     DEFAULT 0,
  away_red_cards        INTEGER     DEFAULT 0,
  home_saves            INTEGER     DEFAULT 0,
  away_saves            INTEGER     DEFAULT 0,
  home_passes           INTEGER     DEFAULT 0,
  away_passes           INTEGER     DEFAULT 0,
  home_pass_accuracy    INTEGER     DEFAULT 0,
  away_pass_accuracy    INTEGER     DEFAULT 0,
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.10  media ─────────────────────────────────────────────────
--  News articles / media posts (written by admin or media role).
CREATE TABLE IF NOT EXISTS public.media (
  id          SERIAL      PRIMARY KEY,
  author_id   UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title       TEXT        NOT NULL,
  content     TEXT,
  excerpt     TEXT,
  category    TEXT        DEFAULT 'News'
                          CHECK (category IN (
                            'News', 'Match Report', 'Interview',
                            'Announcement', 'Transfer', 'Opinion'
                          )),
  image_url   TEXT,
  video_url   TEXT,
  published   BOOLEAN     DEFAULT TRUE,
  views       INTEGER     DEFAULT 0,
  featured    BOOLEAN     DEFAULT FALSE,
  tags        TEXT[],
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.11  team_news ─────────────────────────────────────────────
--  Posts written by team managers for their own fans.
CREATE TABLE IF NOT EXISTS public.team_news (
  id          SERIAL      PRIMARY KEY,
  team_id     INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  body        TEXT,
  author_name TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.12  notifications ─────────────────────────────────────────
--  System / match-event notifications (e.g. goal alerts).
CREATE TABLE IF NOT EXISTS public.notifications (
  id          SERIAL      PRIMARY KEY,
  title       TEXT,
  body        TEXT,
  match_id    INTEGER     REFERENCES public.matches(id) ON DELETE CASCADE,
  event_type  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.13  activity_logs ─────────────────────────────────────────
--  Admin audit trail.
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id          SERIAL      PRIMARY KEY,
  user_id     UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   INTEGER,
  entity_name TEXT,
  details     JSONB,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── 3.14  standings ─────────────────────────────────────────────
--  Pre-computed league table cache (one row per team per competition).
CREATE TABLE IF NOT EXISTS public.standings (
  id              SERIAL      PRIMARY KEY,
  competition_id  INTEGER     REFERENCES public.competitions(id) ON DELETE CASCADE,
  team_id         INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  "group"         TEXT,
  played          INTEGER     DEFAULT 0,
  won             INTEGER     DEFAULT 0,
  drawn           INTEGER     DEFAULT 0,
  lost            INTEGER     DEFAULT 0,
  goals_for       INTEGER     DEFAULT 0,
  goals_against   INTEGER     DEFAULT 0,
  goal_difference INTEGER     DEFAULT 0,
  points          INTEGER     DEFAULT 0,
  form            TEXT[],                        -- last 5: ['W','D','L','W','W']
  position        INTEGER,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (competition_id, team_id, "group")
);

-- ── 3.15  team_staff ────────────────────────────────────────────
--  Coaching / backroom staff per team.
CREATE TABLE IF NOT EXISTS public.team_staff (
  id              SERIAL      PRIMARY KEY,
  team_id         INTEGER     REFERENCES public.teams(id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  role            TEXT        NOT NULL
                              CHECK (role IN (
                                'head_coach', 'assistant_coach', 'goalkeeper_coach',
                                'fitness_coach', 'medical_staff', 'analyst', 'manager'
                              )),
  nationality     TEXT,
  date_of_birth   DATE,
  contract_until  DATE,
  photo_url       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ────────────────────────────────────────────────────────────────
-- SECTION 4 — ADD MISSING COLUMNS TO EXISTING TABLES
-- Safe: ADD COLUMN IF NOT EXISTS is a no-op when column already exists
-- ────────────────────────────────────────────────────────────────

-- teams (columns added since the original schema was deployed)
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS owner_id        UUID        REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS status          TEXT        DEFAULT 'active';
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS gallery         JSONB;
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS lineup          JSONB;
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

-- players
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS age            INTEGER;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS assists        INTEGER     DEFAULT 0;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS date_of_birth  DATE;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS height         INTEGER;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS weight         INTEGER;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS photo_url      TEXT;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS yellow_cards   INTEGER     DEFAULT 0;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS red_cards      INTEGER     DEFAULT 0;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS appearances    INTEGER     DEFAULT 0;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS status         TEXT        DEFAULT 'active';
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS market_value   INTEGER;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS contract_until DATE;
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

-- competitions
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS season_id     INTEGER REFERENCES public.seasons(id) ON DELETE SET NULL;
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS logo_url       TEXT;
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS prize_money    INTEGER;
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS current_round  TEXT;
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS total_teams    INTEGER;
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

-- matches
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS season_id                    INTEGER REFERENCES public.seasons(id) ON DELETE SET NULL;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS match_start_time             TIMESTAMPTZ;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS elapsed_seconds_before_pause INTEGER     DEFAULT 0;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS is_locked                    BOOLEAN     DEFAULT FALSE;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS confirmed_at                 TIMESTAMPTZ;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS attendance                   INTEGER;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS referee                      TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS weather                      TEXT;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS temperature                  INTEGER;
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS updated_at                   TIMESTAMPTZ DEFAULT NOW();

-- match_events
ALTER TABLE public.match_events ADD COLUMN IF NOT EXISTS assist_player_id INTEGER REFERENCES public.players(id) ON DELETE SET NULL;
ALTER TABLE public.match_events ADD COLUMN IF NOT EXISTS extra_minute      INTEGER DEFAULT 0;
ALTER TABLE public.match_events ADD COLUMN IF NOT EXISTS goal_type         TEXT;
ALTER TABLE public.match_events ADD COLUMN IF NOT EXISTS card_reason       TEXT;
ALTER TABLE public.match_events ADD COLUMN IF NOT EXISTS video_url         TEXT;

-- match_commentary
ALTER TABLE public.match_commentary ADD COLUMN IF NOT EXISTS is_important BOOLEAN DEFAULT FALSE;

-- media
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS published  BOOLEAN     DEFAULT TRUE;
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS video_url  TEXT;
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS views      INTEGER     DEFAULT 0;
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS featured   BOOLEAN     DEFAULT FALSE;
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS tags       TEXT[];
ALTER TABLE public.media ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- team_news (image + excerpt support for team posts)
ALTER TABLE public.team_news ADD COLUMN IF NOT EXISTS image_url  TEXT;
ALTER TABLE public.team_news ADD COLUMN IF NOT EXISTS excerpt    TEXT;
ALTER TABLE public.team_news ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();


-- ────────────────────────────────────────────────────────────────
-- SECTION 5 — PERFORMANCE INDEXES
-- ────────────────────────────────────────────────────────────────

-- matches — most frequently queried table
CREATE INDEX IF NOT EXISTS idx_matches_competition        ON public.matches(competition_id);
CREATE INDEX IF NOT EXISTS idx_matches_season             ON public.matches(season_id);
CREATE INDEX IF NOT EXISTS idx_matches_status             ON public.matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_start_time         ON public.matches(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_matches_home_team          ON public.matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team          ON public.matches(away_team_id);

-- match_events
CREATE INDEX IF NOT EXISTS idx_match_events_match         ON public.match_events(match_id);
CREATE INDEX IF NOT EXISTS idx_match_events_player        ON public.match_events(player_id);
CREATE INDEX IF NOT EXISTS idx_match_events_type          ON public.match_events(event_type);

-- match_commentary
CREATE INDEX IF NOT EXISTS idx_match_commentary_match     ON public.match_commentary(match_id);

-- players
CREATE INDEX IF NOT EXISTS idx_players_team               ON public.players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_position           ON public.players(position);

-- teams
CREATE INDEX IF NOT EXISTS idx_teams_owner                ON public.teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_status               ON public.teams(status);

-- competitions
CREATE INDEX IF NOT EXISTS idx_competitions_season        ON public.competitions(season_id);
CREATE INDEX IF NOT EXISTS idx_competitions_status        ON public.competitions(status);

-- standings
CREATE INDEX IF NOT EXISTS idx_standings_competition      ON public.standings(competition_id);
CREATE INDEX IF NOT EXISTS idx_standings_team             ON public.standings(team_id);

-- media
CREATE INDEX IF NOT EXISTS idx_media_published            ON public.media(published);
CREATE INDEX IF NOT EXISTS idx_media_category             ON public.media(category);
CREATE INDEX IF NOT EXISTS idx_media_created              ON public.media(created_at DESC);

-- team_news
CREATE INDEX IF NOT EXISTS idx_team_news_team             ON public.team_news(team_id);
CREATE INDEX IF NOT EXISTS idx_team_news_created          ON public.team_news(created_at DESC);

-- notifications
CREATE INDEX IF NOT EXISTS idx_notifications_match        ON public.notifications(match_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created      ON public.notifications(created_at DESC);

-- activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_user         ON public.activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created      ON public.activity_logs(created_at DESC);


-- ────────────────────────────────────────────────────────────────
-- SECTION 6 — TRIGGERS
-- ────────────────────────────────────────────────────────────────

-- 6.1  Auto-create a profile row when a new auth user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER                                -- bypasses RLS
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, role)
  VALUES (
    NEW.id,
    NEW.email,
    SPLIT_PART(NEW.email, '@', 1),
    'fan'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 6.2  Auto-create a match_statistics row when a match is created
CREATE OR REPLACE FUNCTION public.handle_new_match_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.match_statistics (match_id)
  VALUES (NEW.id)
  ON CONFLICT (match_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_match_created_add_stats ON public.matches;
CREATE TRIGGER on_match_created_add_stats
  AFTER INSERT ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_match_stats();


-- ────────────────────────────────────────────────────────────────
-- SECTION 7 — ROW LEVEL SECURITY (RLS)
-- ────────────────────────────────────────────────────────────────
-- Pattern:
--   • Everyone (anon + authenticated) can SELECT public data
--   • Authenticated team managers can manage their own team's data
--   • Admins (role = 'admin') can do everything
-- ────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_commentary ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_news        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.standings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_staff       ENABLE ROW LEVEL SECURITY;

-- ── profiles ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles: public read"  ON public.profiles;
DROP POLICY IF EXISTS "profiles: own insert"   ON public.profiles;
DROP POLICY IF EXISTS "profiles: own update"   ON public.profiles;
DROP POLICY IF EXISTS "profiles: admin all"    ON public.profiles;
-- legacy names from older schema files
DROP POLICY IF EXISTS "Public read profiles"   ON public.profiles;
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admin manage profiles"  ON public.profiles;

CREATE POLICY "profiles: public read"
  ON public.profiles FOR SELECT USING (true);

CREATE POLICY "profiles: own insert"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles: own update"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "profiles: admin all"
  ON public.profiles FOR ALL
  USING (public.is_admin());

-- ── teams ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "teams: public read"          ON public.teams;
DROP POLICY IF EXISTS "teams: managers create"      ON public.teams;
DROP POLICY IF EXISTS "teams: managers update own"  ON public.teams;
DROP POLICY IF EXISTS "teams: admin all"            ON public.teams;
-- legacy
DROP POLICY IF EXISTS "Public read teams"           ON public.teams;
DROP POLICY IF EXISTS "Admin manage teams"          ON public.teams;
DROP POLICY IF EXISTS "Public can read teams"       ON public.teams;
DROP POLICY IF EXISTS "Authenticated users can create teams" ON public.teams;
DROP POLICY IF EXISTS "Team owners can update their team"    ON public.teams;

CREATE POLICY "teams: public read"
  ON public.teams FOR SELECT USING (true);

-- Any logged-in user can register a new team (arrives as 'pending')
CREATE POLICY "teams: managers create"
  ON public.teams FOR INSERT TO authenticated
  WITH CHECK (true);

-- Team managers can update their own team (profile, lineup, gallery, news, etc.)
CREATE POLICY "teams: managers update own"
  ON public.teams FOR UPDATE TO authenticated
  USING   (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- Admins can do anything (approve/reject/delete)
CREATE POLICY "teams: admin all"
  ON public.teams FOR ALL
  USING (public.is_admin());

-- ── players ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "players: public read"       ON public.players;
DROP POLICY IF EXISTS "players: managers all"      ON public.players;
DROP POLICY IF EXISTS "players: admin all"         ON public.players;
-- legacy
DROP POLICY IF EXISTS "Public read players"        ON public.players;
DROP POLICY IF EXISTS "Admin manage players"       ON public.players;
DROP POLICY IF EXISTS "Public can read players"    ON public.players;
DROP POLICY IF EXISTS "Team managers can manage their players" ON public.players;

CREATE POLICY "players: public read"
  ON public.players FOR SELECT USING (true);

-- Team managers can fully manage players in their own team
CREATE POLICY "players: managers all"
  ON public.players FOR ALL TO authenticated
  USING (
    team_id IN (SELECT id FROM public.teams WHERE owner_id = auth.uid())
  )
  WITH CHECK (
    team_id IN (SELECT id FROM public.teams WHERE owner_id = auth.uid())
  );

CREATE POLICY "players: admin all"
  ON public.players FOR ALL
  USING (public.is_admin());

-- ── seasons ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "seasons: public read"  ON public.seasons;
DROP POLICY IF EXISTS "seasons: admin all"    ON public.seasons;

CREATE POLICY "seasons: public read"
  ON public.seasons FOR SELECT USING (true);

CREATE POLICY "seasons: admin all"
  ON public.seasons FOR ALL
  USING (public.is_admin());

-- ── competitions ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "competitions: public read"  ON public.competitions;
DROP POLICY IF EXISTS "competitions: admin all"    ON public.competitions;
-- legacy
DROP POLICY IF EXISTS "Public read competitions"   ON public.competitions;
DROP POLICY IF EXISTS "Admin manage competitions"  ON public.competitions;

CREATE POLICY "competitions: public read"
  ON public.competitions FOR SELECT USING (true);

CREATE POLICY "competitions: admin all"
  ON public.competitions FOR ALL
  USING (public.is_admin());

-- ── matches ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "matches: public read"  ON public.matches;
DROP POLICY IF EXISTS "matches: admin all"    ON public.matches;
-- legacy
DROP POLICY IF EXISTS "Public read matches"   ON public.matches;
DROP POLICY IF EXISTS "Admin manage matches"  ON public.matches;

CREATE POLICY "matches: public read"
  ON public.matches FOR SELECT USING (true);

CREATE POLICY "matches: admin all"
  ON public.matches FOR ALL
  USING (public.is_admin());

-- ── match_events ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "match_events: public read"   ON public.match_events;
DROP POLICY IF EXISTS "match_events: admin all"     ON public.match_events;
-- legacy
DROP POLICY IF EXISTS "Public read match events"    ON public.match_events;
DROP POLICY IF EXISTS "Admin manage match events"   ON public.match_events;
DROP POLICY IF EXISTS "Public read match_events"    ON public.match_events;
DROP POLICY IF EXISTS "Admin manage match_events"   ON public.match_events;

CREATE POLICY "match_events: public read"
  ON public.match_events FOR SELECT USING (true);

CREATE POLICY "match_events: admin all"
  ON public.match_events FOR ALL
  USING (public.is_admin());

-- ── match_commentary ─────────────────────────────────────────────
DROP POLICY IF EXISTS "match_commentary: public read"  ON public.match_commentary;
DROP POLICY IF EXISTS "match_commentary: admin all"    ON public.match_commentary;
-- legacy
DROP POLICY IF EXISTS "Public read match commentary"   ON public.match_commentary;
DROP POLICY IF EXISTS "Admin manage match commentary"  ON public.match_commentary;

CREATE POLICY "match_commentary: public read"
  ON public.match_commentary FOR SELECT USING (true);

CREATE POLICY "match_commentary: admin all"
  ON public.match_commentary FOR ALL
  USING (public.is_admin());

-- ── match_statistics ─────────────────────────────────────────────
DROP POLICY IF EXISTS "match_statistics: public read"  ON public.match_statistics;
DROP POLICY IF EXISTS "match_statistics: admin all"    ON public.match_statistics;
-- legacy
DROP POLICY IF EXISTS "Public read match statistics"   ON public.match_statistics;
DROP POLICY IF EXISTS "Admin manage match statistics"  ON public.match_statistics;

CREATE POLICY "match_statistics: public read"
  ON public.match_statistics FOR SELECT USING (true);

CREATE POLICY "match_statistics: admin all"
  ON public.match_statistics FOR ALL
  USING (public.is_admin());

-- ── media ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "media: public read"          ON public.media;
DROP POLICY IF EXISTS "media: admin and media all"  ON public.media;
-- legacy
DROP POLICY IF EXISTS "Public read published media" ON public.media;
DROP POLICY IF EXISTS "Admin manage media"          ON public.media;
DROP POLICY IF EXISTS "Public read media"           ON public.media;
DROP POLICY IF EXISTS "Admin manage media"          ON public.media;

-- Published articles are readable by anyone; unpublished visible to admin/media only
CREATE POLICY "media: public read"
  ON public.media FOR SELECT
  USING (published = true OR public.is_admin_or_media());

CREATE POLICY "media: admin and media all"
  ON public.media FOR ALL
  USING (public.is_admin_or_media());

-- ── team_news ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "team_news: public read"    ON public.team_news;
DROP POLICY IF EXISTS "team_news: managers all"   ON public.team_news;
DROP POLICY IF EXISTS "team_news: admin all"      ON public.team_news;

CREATE POLICY "team_news: public read"
  ON public.team_news FOR SELECT USING (true);

-- Team managers can post / delete news for their own club only
CREATE POLICY "team_news: managers all"
  ON public.team_news FOR ALL TO authenticated
  USING (
    team_id IN (SELECT id FROM public.teams WHERE owner_id = auth.uid())
  )
  WITH CHECK (
    team_id IN (SELECT id FROM public.teams WHERE owner_id = auth.uid())
  );

CREATE POLICY "team_news: admin all"
  ON public.team_news FOR ALL
  USING (public.is_admin());

-- ── notifications ────────────────────────────────────────────────
DROP POLICY IF EXISTS "notifications: public read"  ON public.notifications;
DROP POLICY IF EXISTS "notifications: admin all"    ON public.notifications;

CREATE POLICY "notifications: public read"
  ON public.notifications FOR SELECT USING (true);

CREATE POLICY "notifications: admin all"
  ON public.notifications FOR ALL
  USING (public.is_admin());

-- ── activity_logs ────────────────────────────────────────────────
DROP POLICY IF EXISTS "activity_logs: admin read"   ON public.activity_logs;
DROP POLICY IF EXISTS "activity_logs: auth insert"  ON public.activity_logs;
DROP POLICY IF EXISTS "activity_logs: admin all"    ON public.activity_logs;
-- legacy
DROP POLICY IF EXISTS "Admin read logs"             ON public.activity_logs;
DROP POLICY IF EXISTS "Admin manage logs"           ON public.activity_logs;

-- Only admins can read logs
CREATE POLICY "activity_logs: admin read"
  ON public.activity_logs FOR SELECT
  USING (public.is_admin());

-- Any authenticated user can write a log entry (audit trail)
CREATE POLICY "activity_logs: auth insert"
  ON public.activity_logs FOR INSERT TO authenticated
  WITH CHECK (true);

-- Admins can update/delete logs
CREATE POLICY "activity_logs: admin all"
  ON public.activity_logs FOR ALL
  USING (public.is_admin());

-- ── standings ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "standings: public read"  ON public.standings;
DROP POLICY IF EXISTS "standings: admin all"    ON public.standings;
-- legacy
DROP POLICY IF EXISTS "Public read standings"   ON public.standings;
DROP POLICY IF EXISTS "Admin manage standings"  ON public.standings;

CREATE POLICY "standings: public read"
  ON public.standings FOR SELECT USING (true);

CREATE POLICY "standings: admin all"
  ON public.standings FOR ALL
  USING (public.is_admin());

-- ── team_staff ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "team_staff: public read"  ON public.team_staff;
DROP POLICY IF EXISTS "team_staff: admin all"    ON public.team_staff;
-- legacy
DROP POLICY IF EXISTS "Public read team staff"   ON public.team_staff;
DROP POLICY IF EXISTS "Admin manage team staff"  ON public.team_staff;

CREATE POLICY "team_staff: public read"
  ON public.team_staff FOR SELECT USING (true);

CREATE POLICY "team_staff: admin all"
  ON public.team_staff FOR ALL
  USING (public.is_admin());


-- ────────────────────────────────────────────────────────────────
-- SECTION 8 — SCHEMA CACHE RELOAD
-- Tells PostgREST to pick up any new columns immediately
-- ────────────────────────────────────────────────────────────────

NOTIFY pgrst, 'reload schema';


-- ────────────────────────────────────────────────────────────────
-- SECTION 9 — VERIFICATION QUERIES (optional, run separately)
-- ────────────────────────────────────────────────────────────────
-- Uncomment each block and run it independently to verify.

-- Check all columns on the teams table:
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'teams'
-- ORDER BY ordinal_position;

-- Check all columns on the players table:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'players'
-- ORDER BY ordinal_position;

-- Check all columns on the matches table:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'matches'
-- ORDER BY ordinal_position;

-- List all tables created:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
-- ORDER BY table_name;

-- List all active RLS policies:
-- SELECT tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE schemaname = 'public'
-- ORDER BY tablename, policyname;

-- Check pending teams:
-- SELECT id, name, status, owner_id FROM public.teams WHERE status = 'pending';

-- ================================================================
-- ✅ DONE — KickLive database is fully set up.
-- ================================================================
