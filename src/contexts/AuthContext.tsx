import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, UserProfile, UserRole } from '../lib/supabase';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string, phone?: string) => Promise<{ error: string | null; role?: UserRole }>;
  signUp: (email: string, password: string, username: string, phone: string, role: UserRole) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isFan: boolean;
  isTeamManager: boolean;
  isMedia: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .limit(1);

      if (error) {
        console.warn('Profile fetch error:', error.message);
        return null;
      }
      return data && data.length > 0 ? data[0] as UserProfile : null;
    } catch (err) {
      console.error('Profile fetch failed:', err);
      return null;
    }
  };

  useEffect(() => {
    let isMounted = true;

    const initAuth = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (!isMounted) return;
        
        if (error) {
          console.warn('Supabase session error:', error.message);
          setLoading(false);
          return;
        }

        setSession(session);
        setUser(session?.user ?? null);
        
        if (session?.user) {
          const profile = await fetchProfile(session.user.id);
          if (isMounted && profile) setProfile(profile);
        }
        
        setLoading(false);
      } catch (err) {
        console.error('Auth init failed:', err);
        if (isMounted) setLoading(false);
      }
    };

    initAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;
      
      setSession(session);
      setUser(session?.user ?? null);
      
      if (session?.user) {
        const profile = await fetchProfile(session.user.id);
        if (profile) setProfile(profile);
      } else {
        setProfile(null);
      }
      
      setLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string, phone?: string) => {
    try {
      // If phone is provided, try phone+password login
      if (phone) {
        const { data, error } = await supabase.auth.signInWithPassword({ 
          phone, 
          password 
        });
        
        if (error) return { error: error.message };
        
        if (data.user) {
          const profile = await fetchProfile(data.user.id);
          setProfile(profile);
          return { error: null, role: profile?.role };
        }
        
        return { error: 'Login failed' };
      }
      
      // Otherwise use email/username+password
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      
      if (error) return { error: error.message };
      
      if (data.user) {
        const profile = await fetchProfile(data.user.id);
        setProfile(profile);
        return { error: null, role: profile?.role };
      }
      
      return { error: 'Login failed' };
    } catch (err: any) {
      return { error: err.message || 'Sign in failed' };
    }
  };

  const signUp = async (email: string, password: string, username: string, phone: string, role: UserRole) => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username, role }
        },
      });

      if (error) return { error: error.message };

      if (data.user) {
        await supabase.from('profiles').insert({
          id: data.user.id,
          email,
          username,
          phone,
          role,
        });
      }

      return { error: null };
    } catch (err: any) {
      return { error: err.message || 'Sign up failed' };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setSession(null);
  };

  const value = {
    user,
    profile,
    session,
    loading,
    signIn,
    signUp,
    signOut,
    isAdmin: profile?.role === 'admin',
    isFan: profile?.role === 'fan',
    isTeamManager: profile?.role === 'team_manager',
    isMedia: profile?.role === 'media',
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
