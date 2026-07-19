import { createClient } from '@supabase/supabase-js';

// Use environment variables for Vercel deployment
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://xvksxqrmdbbinlrjctri.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuZWZwY2plZWJhd3NlYnhqaGNmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNDAyMTQsImV4cCI6MjA5OTYxNjIxNH0.YkPu5IxtEPZHK9i0oiMTRROrwCT3ZdF1RgCEhaqDhwo';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type UserRole = 'admin' | 'fan' | 'team_manager' | 'media';

export interface UserProfile {
  id: string;
  email: string;
  username: string;
  phone?: string;
  role: UserRole;
  avatar_url?: string;
  team_id?: number;
  created_at: string;
  updated_at: string;
}
