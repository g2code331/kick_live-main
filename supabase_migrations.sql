-- ============================================================
-- KickLive — Complete Supabase SQL Migrations
-- Run ALL of this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- ── 1. Teams table: add required columns ─────────────────────────────────────

-- owner_id: links a team to a team-manager user
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- status: approval workflow ('pending' | 'active' | 'rejected')
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

-- coach: head coach name
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS coach TEXT;

-- venue: stadium / ground name
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS venue TEXT;

-- city: club city / town
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS city TEXT;

-- ── 2. Matches table: timer persistence ──────────────────────────────────────

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS match_start_time TIMESTAMPTZ;

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS elapsed_seconds_before_pause INTEGER DEFAULT 0;

-- ── 3. Players table: assists column (for squad display) ─────────────────────

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS assists INTEGER DEFAULT 0;

-- ── 4. Teams table: lineup JSONB (starting XI saved by team manager) ──────────

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS lineup JSONB;

-- After adding this column, reload PostgREST schema cache:
NOTIFY pgrst, 'reload schema';

-- ── 4. Performance indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_matches_competition_id ON matches(competition_id);
CREATE INDEX IF NOT EXISTS idx_matches_status        ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_start_time    ON matches(start_time);
CREATE INDEX IF NOT EXISTS idx_teams_owner_id        ON teams(owner_id);
CREATE INDEX IF NOT EXISTS idx_teams_status          ON teams(status);
CREATE INDEX IF NOT EXISTS idx_players_team_id       ON players(team_id);

-- ── 5. Row Level Security (RLS) for teams ────────────────────────────────────
-- These fix the 403 Forbidden errors when team managers create / read teams.

-- Enable RLS if not already enabled
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

-- Public (anon + authenticated) can read ALL active teams
--   (needed for standings, match display, fan portal)
DROP POLICY IF EXISTS "Public can read teams" ON teams;
CREATE POLICY "Public can read teams"
  ON teams FOR SELECT
  USING (true);

-- Authenticated users can INSERT a team (they become the owner)
DROP POLICY IF EXISTS "Authenticated users can create teams" ON teams;
CREATE POLICY "Authenticated users can create teams"
  ON teams FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Team owners can UPDATE their own team
DROP POLICY IF EXISTS "Team owners can update their team" ON teams;
CREATE POLICY "Team owners can update their team"
  ON teams FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- Admins can UPDATE any team (needed for approval/reject)
-- ⚠ Set your admin user's UUID below, or use a role check if you have one
-- DROP POLICY IF EXISTS "Admins can update any team" ON teams;
-- CREATE POLICY "Admins can update any team"
--   ON teams FOR UPDATE
--   TO authenticated
--   USING (
--     EXISTS (
--       SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
--     )
--   );

-- ── 6. RLS for players table ─────────────────────────────────────────────────

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can read players" ON players;
CREATE POLICY "Public can read players"
  ON players FOR SELECT USING (true);

DROP POLICY IF EXISTS "Team managers can manage their players" ON players;
CREATE POLICY "Team managers can manage their players"
  ON players FOR ALL
  TO authenticated
  USING (
    team_id IN (
      SELECT id FROM teams WHERE owner_id = auth.uid()
    )
  );

-- ── 7. Profiles join for pending team approval (optional) ────────────────────
-- If you want to see the team manager's name in the admin approval panel,
-- grant the join from teams to profiles:
-- (Usually this works automatically via PostgREST foreign key introspection
--  as long as profiles.id = auth.users.id)

-- ── 8. Verify: run these SELECT queries to confirm everything worked ─────────

-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'teams'
-- ORDER BY ordinal_position;

-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'matches'
-- ORDER BY ordinal_position;

-- SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'teams';

-- ── 9. Quick-check for pending teams after running ───────────────────────────
-- SELECT id, name, status, owner_id FROM teams WHERE status = 'pending';

-- Competition editor persistence: schedule, format, and match rules.
ALTER TABLE public.competitions ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Allow the Friendly tournament format.
DO $$ BEGIN
  ALTER TABLE public.competitions DROP CONSTRAINT IF EXISTS competitions_type_check;
  ALTER TABLE public.competitions ADD CONSTRAINT competitions_type_check CHECK (type IN ('league', 'cup', 'knockout', 'friendly'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Team manager starting XI used by the fan/team profile pitch.
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS lineup JSONB;
NOTIFY pgrst, 'reload schema';
