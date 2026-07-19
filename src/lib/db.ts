import { supabase } from './supabase';
import { matches, players, mediaItems } from '../data/mockData';

export async function getMatches() {
  try {
    // Only fetch necessary columns, limit to 20 matches, order by recent
    const { data, error } = await supabase
      .from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, competition_id')
      .order('start_time', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || matches;
  } catch {
    return matches;
  }
}

export async function getPlayers() {
  try {
    // Only fetch necessary columns, limit to 50 players, order by goals
    const { data, error } = await supabase
      .from('players')
      .select('id, name, team_id, position, goals, assists, nationality')
      .order('goals', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || players;
  } catch {
    return players;
  }
}

export async function getMedia() {
  try {
    // Only fetch necessary columns, limit to 10 media items
    const { data, error } = await supabase
      .from('media')
      .select('id, title, category, image_url, created_at, excerpt')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    return data || mediaItems;
  } catch {
    return mediaItems;
  }
}
