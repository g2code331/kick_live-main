-- =============================================
-- KICKLIVE - NEW SUPABASE PROJECT SETUP
-- Run this in NEW Supabase project SQL Editor
-- =============================================

-- 1. PROFILES TABLE
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

-- 2. TEAMS TABLE
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

-- 3. PLAYERS TABLE
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position TEXT NOT NULL,
  number INTEGER NOT NULL,
  nationality TEXT,
  goals INTEGER DEFAULT 0,
  assists INTEGER DEFAULT 0,
  photo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. COMPETITIONS TABLE
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  season TEXT DEFAULT '2025',
  start_date DATE,
  end_date DATE,
  format TEXT,
  status TEXT DEFAULT 'upcoming',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. MATCHES TABLE (WITH TIMESTAMP COLUMNS FOR FREE TIMER!)
CREATE TABLE IF NOT EXISTS matches (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  home_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  away_team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  home_score INTEGER DEFAULT 0,
  away_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'scheduled',
  start_time TIMESTAMPTZ NOT NULL,
  venue TEXT,
  minute INTEGER DEFAULT 0,
  matchday INTEGER DEFAULT 1,
  "group" TEXT,
  round TEXT,
  -- TIMESTAMP PHYSICS COLUMNS (ZERO BANDWIDTH TIMER!)
  match_start_time TIMESTAMPTZ,
  elapsed_seconds_before_pause INTEGER DEFAULT 0,
  is_locked BOOLEAN DEFAULT FALSE,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. MATCH EVENTS TABLE
CREATE TABLE IF NOT EXISTS match_events (
  id SERIAL PRIMARY KEY,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id),
  player_id INTEGER REFERENCES players(id),
  assist_player_id INTEGER REFERENCES players(id),
  event_type TEXT NOT NULL,
  minute INTEGER NOT NULL,
  extra_minute INTEGER DEFAULT 0,
  description TEXT,
  goal_type TEXT,
  card_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. MATCH COMMENTARY TABLE
CREATE TABLE IF NOT EXISTS match_commentary (
  id SERIAL PRIMARY KEY,
  match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. MEDIA TABLE
CREATE TABLE IF NOT EXISTS media (
  id SERIAL PRIMARY KEY,
  author_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  content TEXT,
  excerpt TEXT,
  category TEXT DEFAULT 'News',
  image_url TEXT,
  published BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. ACTIVITY LOGS TABLE
CREATE TABLE IF NOT EXISTS activity_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_name TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ENABLE ROW LEVEL SECURITY
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_commentary ENABLE ROW LEVEL SECURITY;
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs ENABLE ROW LEVEL SECURITY;

-- CREATE POLICIES (PUBLIC READ, ADMIN WRITE)
CREATE POLICY "Public read teams" ON teams FOR SELECT USING (true);
CREATE POLICY "Admin manage teams" ON teams FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Public read players" ON players FOR SELECT USING (true);
CREATE POLICY "Admin manage players" ON players FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Public read competitions" ON competitions FOR SELECT USING (true);
CREATE POLICY "Admin manage competitions" ON competitions FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Public read matches" ON matches FOR SELECT USING (true);
CREATE POLICY "Admin manage matches" ON matches FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Public read match_events" ON match_events FOR SELECT USING (true);
CREATE POLICY "Admin manage match_events" ON match_events FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Public read media" ON media FOR SELECT USING (published = true);
CREATE POLICY "Admin manage media" ON media FOR ALL USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'media')));

-- CREATE PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_matches_competition ON matches(competition_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_start_time ON matches(start_time);
CREATE INDEX IF NOT EXISTS idx_match_events_match_id ON match_events(match_id);

-- =============================================
-- ✅ NEW PROJECT READY - ZERO BANDWIDTH TIMER!
-- =============================================
