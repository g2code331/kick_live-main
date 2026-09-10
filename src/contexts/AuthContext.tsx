import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { User, Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { UserProfile, UserRole } from "../lib/supabase";
import { log } from "../lib/log";
import { invalidate, noteAuthIdentity } from "../lib/data";

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string, phone?: string) => Promise<{ error: string | null; role?: UserRole }>;
  /**
   * Public registration. There is deliberately no `role` parameter: the database trigger
   * (`handle_new_user`) inserts the profile as a `fan`, and privileged roles are granted only by an
   * admin (see `src/lib/access.ts`). Passing a role here used to be the whole privilege-escalation
   * path, so the type will not accept one.
   */
  signUp: (email: string, password: string, username: string, phone: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isFan: boolean;
  isTeamManager: boolean;
  isMedia: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * One row, one primary key, RLS-restricted to `id = auth.uid()`.
 *
 * Module scope rather than inside the provider: it closes over nothing but the client, so the auth
 * callbacks can depend on it without a per-render identity, and the named columns are the point — the row
 * is already bounded, and this is about the *next* column somebody adds to `profiles` not silently arriving
 * in a bundle that reads five fields (KICKLIVE_FINAL_SCHEMA.sql §3.1).
 */
async function fetchProfile(userId: string): Promise<UserProfile | null> {
  try {
    const { data, error } = await supabase.from("profiles").select("id, email, username, phone, role, avatar_url, team_id, created_at, updated_at").eq("id", userId).limit(1);
    if (error) {
      log.warn("Profile fetch error:", error.message);
      return null;
    }
    return data && data.length > 0 ? (data[0] as UserProfile) : null;
  } catch (err) {
    log.error("Profile fetch failed:", err);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const initAuth = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (!isMounted) return;

        if (error) {
          log.warn("Supabase session error:", error.message);
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
        log.error("Auth init failed:", err);
        if (isMounted) setLoading(false);
      }
    };

    initAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
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

  const signIn = useCallback(async (email: string, password: string, phone?: string) => {
    try {
      // If phone is provided, try phone+password login
      if (phone) {
        const { data, error } = await supabase.auth.signInWithPassword({
          phone,
          password,
        });

        if (error) return { error: error.message };

        if (data.user) {
          const profile = await fetchProfile(data.user.id);
          setProfile(profile);
          return { error: null, role: profile?.role };
        }

        return { error: "Login failed" };
      }

      // Otherwise use email/username+password
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) return { error: error.message };

      if (data.user) {
        const profile = await fetchProfile(data.user.id);
        setProfile(profile);
        return { error: null, role: profile?.role };
      }

      return { error: "Login failed" };
    } catch (err: any) {
      return { error: err.message || "Sign in failed" };
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string, username: string, phone: string) => {
    try {
      // Only non-privileged, self-owned data goes up. `role` in user metadata used to be read by
      // the profile trigger; it is ignored server-side now and is never sent from here.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username },
        },
      });

      if (error) return { error: error.message };

      if (data.user) {
        // The `on_auth_user_created` trigger already created this row as a fan; this upsert only
        // fills in the display fields. No `role` key, by design.
        const { error: profileError } = await supabase.from("profiles").upsert({ id: data.user.id, email, username, phone }, { onConflict: "id" });
        if (profileError) {
          log.error("Profile upsert failed:", profileError.message);
          return { error: `Account created, but the profile could not be saved: ${profileError.message}` };
        }
      }

      return { error: null };
    } catch (err: any) {
      return { error: err.message || "Sign up failed" };
    }
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setSession(null);
    // A shared read cache is only safe if it is single-identity: the rows in it are whatever RLS let *this*
    // user see. `noteAuthIdentity` clears on the change; this also drops anything a stale token cached.
    invalidate("*");
  }, []);

  // Memoised (audit F-10): the value object used to be new on every render, so all twelve consumers of
  // `useAuth()` re-rendered whenever the provider did — on a portal with a 30 s poll that is the whole tree
  // every half minute, whatever it contains.
  const value = useMemo<AuthContextType>(
    () => ({
      user,
      profile,
      session,
      loading,
      signIn,
      signUp,
      signOut,
      isAdmin: profile?.role === "admin",
      isFan: profile?.role === "fan",
      isTeamManager: profile?.role === "team_manager",
      isMedia: profile?.role === "media",
    }),
    [user, profile, session, loading, signIn, signUp, signOut],
  );

  useEffect(() => {
    // The data layer keys are cached answers produced with this user's token. Bind them to it.
    noteAuthIdentity(user?.id ?? null);
  }, [user?.id]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
