/**
 * KICKLIVE · BACKGROUND DATA LOADER — retained, not started (finding F-01)
 *
 * `App.tsx` used to call `loadAll()` on mount and `startAutoRefresh()` (six queries per cold start, six more
 * every five minutes per visible tab). Nothing ever called `getTeams()`, `getMatches()`, `getPlayers()`,
 * `getMedia()`, `getUsers()` or `subscribe()`: the warmest cache in the app had no readers, which is why the
 * Phase 4 audit records it as a load generator rather than a cache. The boot effect now calls
 * `initDataLayer()`, and reads go through `src/lib/data/` — one keyed cache, one shared ticker, TTLs per
 * freshness class (`docs/PHASE4_DATA_ARCHITECTURE.md` §4).
 *
 * The class stays on disk on purpose, for two reasons: it is the shape of the answer if a portal ever wants a
 * genuinely global index (and that index should live in the new cache, not here), and deleting a component
 * because a grep found no readers is how a phase like this one acquires a bug nobody noticed. If you want it
 * gone, deleting this file and its export line is the whole change — no screen depends on it.
 *
 * Its own reads were already bounded and column-named; what they were not was *used*.
 */

import { supabase } from './supabase';
import { log } from './log';

export interface AppData {
  teams: any[];
  players: any[];
  competitions: any[];
  matches: any[];
  media: any[];
  users: any[];
  lastLoaded: Date;
}

class DataLoader {
  private static instance: DataLoader;
  private data: AppData | null = null;
  private isLoading: boolean = false;
  private pending: Promise<AppData> | null = null;
  private refreshInterval: any = null;
  private subscribers: ((data: AppData) => void)[] = [];

  private constructor() {}

  static getInstance(): DataLoader {
    if (!DataLoader.instance) {
      DataLoader.instance = new DataLoader();
    }
    return DataLoader.instance;
  }

  /**
   * Load all data from Supabase
   */
  async loadAll(): Promise<AppData> {
    // Return cached data immediately if available (don't wait for refresh)
    if (this.data && !this.isStale()) {
      log.debug('[DataLoader] Using cached data');
      return this.data;
    }

    // A second caller must not start a parallel identical fetch, and must not spin on a timer
    // either: it just awaits the in-flight promise. (This used to be `while (isLoading) sleep(100)`,
    // which woke the tab every 100 ms and could outlive the request it was waiting for.)
    if (this.pending) {
      if (this.data) {
        log.debug('[DataLoader] Using cached data while refreshing');
        return this.data;
      }
      return this.pending;
    }

    this.isLoading = true;
    const run = this.fetchAll();
    this.pending = run;
    try {
      return await run;
    } finally {
      this.pending = null;
      this.isLoading = false;
    }
  }

  /** One whole-cache load; separated from `loadAll` so concurrent callers can share it. */
  private async fetchAll(): Promise<AppData> {
    try {
      log.debug('[DataLoader] Fetching fresh data from Supabase...');
      const [teams, players, competitions, matches, media, users] = await Promise.all([
        this.loadTeams(),
        this.loadPlayers(),
        this.loadCompetitions(),
        this.loadMatches(),
        this.loadMedia(),
        this.loadUsers()
      ]);

      const newData: AppData = {
        teams,
        players,
        competitions,
        matches,
        media,
        users,
        lastLoaded: new Date()
      };

      // Update cache
      this.data = newData;
      log.debug('[DataLoader] Data refreshed:', {
        teams: teams.length,
        players: players.length,
        competitions: competitions.length,
        matches: matches.length
      });

      // Notify subscribers of update
      this.notifySubscribers();

      return newData;
    } catch (error) {
      log.error('[DataLoader] Error loading data:', error);
      // Return cached data even if error (better than nothing)
      if (this.data) {
        log.debug('[DataLoader] Using cached data due to error');
        return this.data;
      }
      throw error;
    }
  }

  /**
   * Get cached data
   */
  getData(): AppData | null {
    return this.data;
  }

  /**
   * Check if data is stale (older than 5 minutes)
   */
  isStale(): boolean {
    if (!this.data) return true;
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return this.data.lastLoaded < fiveMinutesAgo;
  }

  /**
   * Silent background refresh - OPTIMIZED FOR LOW EGRESS
   */
  async refresh(): Promise<void> {
    if (this.isLoading) {
      log.debug('[DataLoader] Already loading, skipping refresh');
      return;
    }

    log.debug('[DataLoader] Refreshing data in background (optimized)...');
    try {
      // Only fetch essential columns with limits - REDUCES DATA BY 80%
      const [teams, players, competitions, matches, media] = await Promise.all([
        supabase.from('teams').select('id, name, short_name, primary_color, secondary_color, status').in('status', ['active', null as any]).limit(50),
        supabase.from('players').select('id, name, team_id, goals, assists').order('goals', { ascending: false }).limit(100),
        supabase.from('competitions').select('id, name, type, season, status').order('created_at', { ascending: false }).limit(20),
        supabase.from('matches').select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time').order('start_time', { ascending: false }).limit(100),
        supabase.from('media').select('id, title, category, image_url, created_at').order('created_at', { ascending: false }).limit(20)
        // NOTE: Not fetching profiles in background - too heavy, only fetch when needed
      ]);

      if (this.data) {
        this.data = {
          teams: teams.data || [],
          players: players.data || [],
          competitions: competitions.data || [],
          matches: matches.data || [],
          media: media.data || [],
          users: this.data.users, // Keep cached users
          lastLoaded: new Date()
        };
        log.debug('[DataLoader] Optimized background refresh complete');
        this.notifySubscribers();
      }
    } catch (error) {
      log.error('[DataLoader] Background refresh failed:', error);
    }
  }

  /**
   * Start auto-refresh every 5 minutes (NOT 2 minutes - saves 60% egress)
   */
  startAutoRefresh(): void {
    if (this.refreshInterval) {
      log.debug('[DataLoader] Auto-refresh already running');
      return;
    }

    log.debug('[DataLoader] Starting auto-refresh (every 5 minutes - optimized)');
    this.refreshInterval = setInterval(() => {
      this.refresh();
    }, 5 * 60 * 1000); // 5 minutes - MUCH BETTER FOR EGRESS
  }

  /**
   * Stop auto-refresh
   */
  stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      log.debug('[DataLoader] Auto-refresh stopped');
    }
  }

  /**
   * Subscribe to data changes
   */
  subscribe(callback: (data: AppData) => void): () => void {
    this.subscribers.push(callback);
    
    // Immediately call with current data if available
    if (this.data) {
      callback(this.data);
    }

    // Return unsubscribe function
    return () => {
      this.subscribers = this.subscribers.filter(cb => cb !== callback);
    };
  }

  /**
   * Notify all subscribers of data changes
   */
  private notifySubscribers(): void {
    this.subscribers.forEach(callback => {
      try {
        if (this.data) {
          callback(this.data);
        }
      } catch (error) {
        log.error('[DataLoader] Subscriber error:', error);
      }
    });
  }

  /**
   * Individual loaders - OPTIMIZED WITH COLUMN SELECTION & LIMITS
   */
  private async loadTeams(): Promise<any[]> {
    const { data, error } = await supabase
      .from('teams')
      .select('id, name, short_name, city, primary_color, secondary_color, status')
      .in('status', ['active', null as any])
      .order('name')
      .limit(50);
    if (error) throw error;
    return data || [];
  }

  private async loadPlayers(): Promise<any[]> {
    const { data, error } = await supabase
      .from('players')
      .select('id, name, team_id, position, number, goals, assists, nationality')
      .order('goals', { ascending: false })
      .limit(100);
    if (error) throw error;
    return data || [];
  }

  private async loadCompetitions(): Promise<any[]> {
    const { data, error } = await supabase
      .from('competitions')
      .select('id, name, type, season, status, start_date, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || [];
  }

  private async loadMatches(): Promise<any[]> {
    const { data, error } = await supabase
      .from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, competition_id')
      .order('start_time', { ascending: false })
      .limit(100);
    if (error) throw error;
    return data || [];
  }

  private async loadMedia(): Promise<any[]> {
    const { data, error } = await supabase
      .from('media')
      .select('id, title, category, image_url, created_at, excerpt')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data || [];
  }

  private async loadUsers(): Promise<any[]> {
    // Only fetch essential user columns - NO large text/blob fields
    const { data, error } = await supabase
      .from('profiles')
      // No `email`: Phase 10 narrowed the columns `authenticated` may project from `profiles`. Nothing calls
      // this loader (see the F-01 note above), so the change is hygiene — a revived class must not come back
      // with a query the database now refuses.
      .select('id, username, role, created_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data || [];
  }

  /**
   * Get specific data type
   */
  getTeams(): any[] {
    return this.data?.teams || [];
  }

  getPlayers(): any[] {
    return this.data?.players || [];
  }

  getCompetitions(): any[] {
    return this.data?.competitions || [];
  }

  getMatches(): any[] {
    return this.data?.matches || [];
  }

  getMedia(): any[] {
    return this.data?.media || [];
  }

  getUsers(): any[] {
    return this.data?.users || [];
  }
}

// Export singleton instance
export const dataLoader = DataLoader.getInstance();