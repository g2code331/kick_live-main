-- =============================================
-- KICKLIVE COMPLETE DATABASE SCHEMA
-- Professional Football Management System
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- 1. PROFILES TABLE (User Management)
-- =============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'fan', 'team_manager', 'media')),
  avatar_url TEXT,
  team_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 2. TEAMS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  city TEXT,
  venue TEXT,
  coach TEXT,
  primary_color TEXT DEFAULT '#39FF14',
  secondary_color TEXT DEFAULT '#000000',
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 3. PLAYERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  number INTEGER NOT NULL,
  nationality TEXT,
  date_of_birth DATE,
  height INTEGER, -- in cm
  weight INTEGER, -- in kg
  photo_url TEXT,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  yellow_cards INTEGER DEFAULT 0,
  red_cards INTEGER DEFAULT 0,
  appearances INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'injured', 'suspended', 'transferred')),
  market_value INTEGER, -- in currency
  contract_until DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 4. COMPETITIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('league', 'cup', 'knockout')),
  season TEXT DEFAULT '2025',
  start_date DATE,
  end_date DATE,
  format TEXT,
  status TEXT DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'completed', 'cancelled')),
  logo_url TEXT,
  prize_money INTEGER,
  current_round TEXT,
  total_teams INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 5. MATCHES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  home_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  home_score INTEGER DEFAULT 0,
  away_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'waiting', 'first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout', 'full_time', 'suspended', 'postponed', 'abandoned', 'cancelled', 'completed', 'live')),
  start_time TIMESTAMPTZ NOT NULL,
  venue TEXT,
  minute INTEGER DEFAULT 0,
  matchday INTEGER DEFAULT 1,
  "group" TEXT,
  round TEXT,
  attendance INTEGER,
  referee TEXT,
  match_start_time TIMESTAMPTZ,
  elapsed_seconds_before_pause INTEGER DEFAULT 0,
  is_locked BOOLEAN DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  weather TEXT,
  temperature INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 6. MATCH_EVENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS match_events (
  id SERIAL PRIMARY KEY,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  assist_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'kickoff', 'goal', 'own_goal', 'penalty_goal', 'penalty_missed',
    'yellow_card', 'second_yellow', 'red_card',
    'substitution', 'substitution_off', 'substitution_on',
    'corner', 'offside', 'free_kick', 'throw_in', 'goal_kick',
    'var_check', 'var_overturned', 'injury', 'water_break',
    'half_time', 'second_half_start', 'extra_time_start', 'extra_time_half_time',
    'penalty_shootout_start', 'full_time', 'match_abandoned'
  )),
  minute INTEGER NOT NULL,
  extra_minute INTEGER DEFAULT 0,
  description TEXT,
  goal_type TEXT CHECK (goal_type IN ('normal', 'header', 'penalty', 'free_kick', 'own_goal', 'volley', 'long_shot', 'tap_in')),
  card_reason TEXT,
  video_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 7. MATCH_COMMENTARY TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS match_commentary (
  id SERIAL PRIMARY KEY,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  comment TEXT NOT NULL,
  is_important BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 8. MATCH_STATISTICS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS match_statistics (
  id SERIAL PRIMARY KEY,
  match_id INTEGER UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
  home_possession INTEGER DEFAULT 50,
  away_possession INTEGER DEFAULT 50,
  home_shots INTEGER DEFAULT 0,
  away_shots INTEGER DEFAULT 0,
  home_shots_on_target INTEGER DEFAULT 0,
  away_shots_on_target INTEGER DEFAULT 0,
  home_corners INTEGER DEFAULT 0,
  away_corners INTEGER DEFAULT 0,
  home_offsides INTEGER DEFAULT 0,
  away_offsides INTEGER DEFAULT 0,
  home_fouls INTEGER DEFAULT 0,
  away_fouls INTEGER DEFAULT 0,
  home_yellow_cards INTEGER DEFAULT 0,
  away_yellow_cards INTEGER DEFAULT 0,
  home_red_cards INTEGER DEFAULT 0,
  away_red_cards INTEGER DEFAULT 0,
  home_saves INTEGER DEFAULT 0,
  away_saves INTEGER DEFAULT 0,
  home_passes INTEGER DEFAULT 0,
  away_passes INTEGER DEFAULT 0,
  home_pass_accuracy INTEGER DEFAULT 0,
  away_pass_accuracy INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 9. MEDIA TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT,
  excerpt TEXT,
  category TEXT DEFAULT 'News' CHECK (category IN ('News', 'Match Report', 'Interview', 'Announcement', 'Transfer', 'Opinion')),
  image_url TEXT,
  video_url TEXT,
  published BOOLEAN DEFAULT TRUE,
  views INTEGER DEFAULT 0,
  featured BOOLEAN DEFAULT FALSE,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 10. ACTIVITY_LOGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_name TEXT,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 11. STANDINGS TABLE (for league tables)
-- =============================================
CREATE TABLE IF NOT EXISTS standings (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  "group" TEXT,
  played INTEGER DEFAULT 0,
  won INTEGER DEFAULT 0,
  drawn INTEGER DEFAULT 0,
  lost INTEGER DEFAULT 0,
  goals_for INTEGER DEFAULT 0,
  goals_against INTEGER DEFAULT 0,
  goal_difference INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  form TEXT[], -- last 5 matches: ['W', 'D', 'L', 'W', 'W']
  position INTEGER,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(competition_id, team_id, "group")
);

-- =============================================
-- 12. TEAM_STAFF TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS team_staff (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('head_coach', 'assistant_coach', 'goalkeeper_coach', 'fitness_coach', 'medical_staff', 'analyst', 'manager')),
  nationality TEXT,
  date_of_birth DATE,
  contract_until DATE,
  photo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- INDEXES FOR PERFORMANCE
-- =============================================
CREATE INDEX IF NOT EXISTS idx_matches_competition ON matches(competition_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_start_time ON matches(start_time);
CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_team_id, away_team_id);
CREATE INDEX IF NOT EXISTS idx_match_events_match_id ON match_events(match_id);
CREATE INDEX IF NOT EXISTS idx_match_events_player ON match_events(player_id);
CREATE INDEX IF NOT EXISTS idx_match_events_type ON match_events(event_type);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
CREATE INDEX IF NOT EXISTS idx_standings_competition ON standings(competition_id);
CREATE INDEX IF NOT EXISTS idx_standings_team ON standings(team_id);
CREATE INDEX IF NOT EXISTS idx_media_category ON media(category);
CREATE INDEX IF NOT EXISTS idx_media_published ON media(published);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at);

-- =============================================
-- TRIGGERS
-- =============================================

-- Auto-create profile when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, username, role)
  VALUES (NEW.id, NEW.email, SPLIT_PART(NEW.email, '@', 1), 'fan');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-create match statistics when match is created
CREATE OR REPLACE FUNCTION public.handle_new_match_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.match_statistics (match_id)
  VALUES (NEW.id)
  ON CONFLICT (match_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_match_created_add_stats ON public.matches;
CREATE TRIGGER on_match_created_add_stats
  AFTER INSERT ON public.matches
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_match_stats();

-- Update standings after match result
CREATE OR REPLACE FUNCTION public.update_standings_after_match()
RETURNS TRIGGER AS $$
BEGIN
  -- This would be called after a match is completed
  -- Implementation depends on your competition format
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- RLS POLICIES (Row Level Security)
-- =============================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_commentary ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE standings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_staff ENABLE ROW LEVEL SECURITY;

-- Helper functions for role checks
CREATE OR REPLACE FUNCTION public.check_is_admin(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = user_id AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.check_is_admin_or_media(user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = user_id AND role IN ('admin', 'media')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Profiles Policies
DROP POLICY IF EXISTS "Public read profiles" ON profiles;
DROP POLICY IF EXISTS "Users update own profile" ON profiles;
DROP POLICY IF EXISTS "Admin manage profiles" ON profiles;

CREATE POLICY "Public read profiles" ON profiles FOR SELECT USING (true);
CREATE POLICY "Users update own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admin manage profiles" ON profiles FOR ALL USING (public.check_is_admin(auth.uid()));

-- Teams Policies
DROP POLICY IF EXISTS "Public read teams" ON teams;
DROP POLICY IF EXISTS "Admin manage teams" ON teams;

CREATE POLICY "Public read teams" ON teams FOR SELECT USING (true);
CREATE POLICY "Admin manage teams" ON teams FOR ALL USING (public.check_is_admin(auth.uid()));

-- Players Policies
DROP POLICY IF EXISTS "Public read players" ON players;
DROP POLICY IF EXISTS "Admin manage players" ON players;

CREATE POLICY "Public read players" ON players FOR SELECT USING (true);
CREATE POLICY "Admin manage players" ON players FOR ALL USING (public.check_is_admin(auth.uid()));

-- Competitions Policies
DROP POLICY IF EXISTS "Public read competitions" ON competitions;
DROP POLICY IF EXISTS "Admin manage competitions" ON competitions;

CREATE POLICY "Public read competitions" ON competitions FOR SELECT USING (true);
CREATE POLICY "Admin manage competitions" ON competitions FOR ALL USING (public.check_is_admin(auth.uid()));

-- Matches Policies
DROP POLICY IF EXISTS "Public read matches" ON matches;
DROP POLICY IF EXISTS "Admin manage matches" ON matches;

CREATE POLICY "Public read matches" ON matches FOR SELECT USING (true);
CREATE POLICY "Admin manage matches" ON matches FOR ALL USING (public.check_is_admin(auth.uid()));

-- Match Events Policies
DROP POLICY IF EXISTS "Public read match events" ON match_events;
DROP POLICY IF EXISTS "Admin manage match events" ON match_events;

CREATE POLICY "Public read match events" ON match_events FOR SELECT USING (true);
CREATE POLICY "Admin manage match events" ON match_events FOR ALL USING (public.check_is_admin(auth.uid()));

-- Match Commentary Policies
DROP POLICY IF EXISTS "Public read match commentary" ON match_commentary;
DROP POLICY IF EXISTS "Admin manage match commentary" ON match_commentary;

CREATE POLICY "Public read match commentary" ON match_commentary FOR SELECT USING (true);
CREATE POLICY "Admin manage match commentary" ON match_commentary FOR ALL USING (public.check_is_admin(auth.uid()));

-- Match Statistics Policies
DROP POLICY IF EXISTS "Public read match statistics" ON match_statistics;
DROP POLICY IF EXISTS "Admin manage match statistics" ON match_statistics;

CREATE POLICY "Public read match statistics" ON match_statistics FOR SELECT USING (true);
CREATE POLICY "Admin manage match statistics" ON match_statistics FOR ALL USING (public.check_is_admin(auth.uid()));

-- Media Policies
DROP POLICY IF EXISTS "Public read published media" ON media;
DROP POLICY IF EXISTS "Admin manage media" ON media;

CREATE POLICY "Public read published media" ON media FOR SELECT USING (published = true);
CREATE POLICY "Admin manage media" ON media FOR ALL USING (public.check_is_admin_or_media(auth.uid()));

-- Activity Logs Policies
DROP POLICY IF EXISTS "Admin read logs" ON activity_logs;
DROP POLICY IF EXISTS "Admin manage logs" ON activity_logs;

CREATE POLICY "Admin read logs" ON activity_logs FOR SELECT USING (public.check_is_admin(auth.uid()));
CREATE POLICY "Admin manage logs" ON activity_logs FOR ALL USING (public.check_is_admin(auth.uid()));

-- Standings Policies
DROP POLICY IF EXISTS "Public read standings" ON standings;
DROP POLICY IF EXISTS "Admin manage standings" ON standings;

CREATE POLICY "Public read standings" ON standings FOR SELECT USING (true);
CREATE POLICY "Admin manage standings" ON standings FOR ALL USING (public.check_is_admin(auth.uid()));

-- Team Staff Policies
DROP POLICY IF EXISTS "Public read team staff" ON team_staff;
DROP POLICY IF EXISTS "Admin manage team staff" ON team_staff;

CREATE POLICY "Public read team staff" ON team_staff FOR SELECT USING (true);
CREATE POLICY "Admin manage team staff" ON team_staff FOR ALL USING (public.check_is_admin(auth.uid()));

-- =============================================
-- SAMPLE DATA (Optional - for testing)
-- =============================================

-- Insert sample teams
INSERT INTO teams (name, short_name, city, venue, coach, primary_color, secondary_color) VALUES
('Black Stars FC', 'BSF', 'Accra', 'Accra Sports Stadium', 'Otto Addo', '#FFD700', '#000000'),
('Kumasi United', 'KMU', 'Kumasi', 'Baba Yara Stadium', 'Michael Osei', '#FF4500', '#FFFFFF'),
('Cape Coast Lions', 'CCL', 'Cape Coast', 'Cape Coast Stadium', 'Samuel Boadu', '#1E90FF', '#FFFFFF'),
('Tamale Warriors', 'TMW', 'Tamale', 'Tamale Stadium', 'Karim Abdul', '#32CD32', '#000000')
ON CONFLICT DO NOTHING;

-- =============================================
-- COMPLETED!
-- =============================================
