/**
 * Read helpers for the public pages, plus the one anonymous write the site makes.
 *
 * Two deliberate rules here:
 *  - every read names its columns and sets a `limit()` — no `select('*')` over a whole table
 *    (the pattern `src/lib/DataLoader.ts` still uses, see docs/PRODUCTION_ARCHITECTURE.md §7);
 *  - mock data is a *development* convenience only. Returning `data/mockData.ts` after a Supabase
 *    failure made an outage look like a successful load — supporters saw invented scores on a live
 *    product. In a production build the caller now gets an empty list plus a logged error.
 */
import { supabase } from './supabase';
import { log } from './log';
import { matches, players, mediaItems } from '../data/mockData';

/** Fabricated rows are allowed in dev/preview builds, never in `vite build --mode production`. */
const MAY_USE_MOCK_DATA = import.meta.env.DEV;

function onFailed<T>(error: { message?: string } | null | undefined, mock: T[], label: string): T[] {
  log.error(`[db] ${label} read failed:`, error?.message ?? 'unknown error');
  return MAY_USE_MOCK_DATA ? mock : [];
}

export async function getMatches() {
  try {
    // Only fetch necessary columns, limit to 20 matches, order by recent
    const { data, error } = await supabase
      .from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, competition_id')
      .order('start_time', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || (MAY_USE_MOCK_DATA ? matches : []);
  } catch (err) {
    return onFailed(
      err as { message?: string } | null,
      matches,
      'matches',
    );
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
    return data || (MAY_USE_MOCK_DATA ? players : []);
  } catch (err) {
    return onFailed(err as { message?: string } | null, players, 'players');
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
    return data || (MAY_USE_MOCK_DATA ? mediaItems : []);
  } catch (err) {
    return onFailed(err as { message?: string } | null, mediaItems, 'media');
  }
}

/**
 * Count one article view.
 *
 * The browser used to do `update({ views: (data.views || 0) + 1 })` — a read-modify-write on a
 * counter, from an anonymous session, with no authorisation: two readers on the same article lost a
 * count, and any signed-in media user could set an article to a million views. The increment now
 * happens inside Postgres (`kicklive_record_media_view`), on one row, one column, atomically, and it
 * is the only anonymous write the app performs.
 *
 * Best-effort by design: a view counter is not worth an error banner, and it must not be worth a
 * DoS surface either — the endpoint gets rate-limited when it moves behind the Worker (Phase 2).
 */
export async function recordMediaView(mediaId: number): Promise<void> {
  try {
    const { error } = await supabase.rpc('kicklive_record_media_view', { p_media_id: mediaId });
    if (error) log.debug('[db] view not counted:', error.message);
  } catch (err) {
    log.debug('[db] view not counted:', err instanceof Error ? err.message : err);
  }
}
