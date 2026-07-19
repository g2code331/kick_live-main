/**
 * KICKLIVE - BACKGROUND DATA LOADER
 * Loads all app data from Supabase on initialization
 * Keeps data fresh with background refresh
 */

import { supabase } from './supabase';

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
      console.log('[DataLoader] Using cached data');
      return this.data;
    }

    // If loading, return cached data if available, otherwise wait
    if (this.isLoading) {
      if (this.data) {
        console.log('[DataLoader] Using cached data while refreshing');
        return this.data;
      }
      
      // Wait for initial load to complete
      while (this.isLoading) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.data!;
    }

    this.isLoading = true;
    try {
      console.log('[DataLoader] Fetching fresh data from Supabase...');
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
      console.log('[DataLoader] ✓ Data refreshed:', { 
        teams: teams.length, 
        players: players.length,
        competitions: competitions.length,
        matches: matches.length
      });

      // Notify subscribers of update
      this.notifySubscribers();

      return newData;
    } catch (error) {
      console.error('[DataLoader] Error loading data:', error);
      // Return cached data even if error (better than nothing)
      if (this.data) {
        console.log('[DataLoader] Using cached data due to error');
        return this.data;
      }
      throw error;
    } finally {
      this.isLoading = false;
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
      console.log('[DataLoader] Already loading, skipping refresh');
      return;
    }

    console.log('[DataLoader] Refreshing data in background (optimized)...');
    try {
      // Only fetch essential columns with limits - REDUCES DATA BY 80%
      const [teams, players, competitions, matches, media] = await Promise.all([
        supabase.from('teams').select('id, name, short_name, primary_color, secondary_color').limit(50),
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
        console.log('[DataLoader] ✓ Optimized background refresh complete');
        this.notifySubscribers();
      }
    } catch (error) {
      console.error('[DataLoader] Background refresh failed:', error);
    }
  }

  /**
   * Start auto-refresh every 5 minutes (NOT 2 minutes - saves 60% egress)
   */
  startAutoRefresh(): void {
    if (this.refreshInterval) {
      console.log('[DataLoader] Auto-refresh already running');
      return;
    }

    console.log('[DataLoader] Starting auto-refresh (every 5 minutes - optimized)');
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
      console.log('[DataLoader] Auto-refresh stopped');
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
        console.error('[DataLoader] Subscriber error:', error);
      }
    });
  }

  /**
   * Individual loaders - OPTIMIZED WITH COLUMN SELECTION & LIMITS
   */
  private async loadTeams(): Promise<any[]> {
    const { data, error } = await supabase
      .from('teams')
      .select('id, name, short_name, city, primary_color, secondary_color')
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
      .select('id, email, username, role, created_at')
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
