import { createClient } from '@supabase/supabase-js';
import { getSupabaseEnv } from './env';
import { log } from './log';

/**
 * The single Supabase client every browser entry point uses.
 *
 * There is no default project on purpose — see `./env.ts`. If the env vars are missing the app
 * refuses to boot with a readable message instead of quietly using someone else's database.
 *
 * What the browser is allowed to do is decided by Postgres row-level security (and, from Phase 2,
 * by the Worker layer). The client here is an *untrusted* caller: it holds an anon key plus the
 * signed-in user's JWT, and it must never assert a role of its own choosing.
 */
const { url, anonKey, projectRef } = getSupabaseEnv();

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Detect a session handed over by an email link / OAuth redirect.
    detectSessionInUrl: true,
  },
  global: {
    // Tag every request so it can be attributed (and rate-limited) at the edge later.
    headers: { 'x-kicklive-client': 'web' },
  },
});

log.debug(`[supabase] client ready for project ${projectRef}`);

export type UserRole = 'admin' | 'fan' | 'team_manager' | 'media';

/** Every role the `profiles.role` CHECK constraint accepts. Keep in sync with the migration. */
export const ALL_ROLES: readonly UserRole[] = ['fan', 'team_manager', 'media', 'admin'];

/**
 * Roles that self-service signup can never produce. They exist only because an admin (or an
 * approved access request) set them server-side; the client has no path that writes them.
 */
export const PRIVILEGED_ROLES: readonly UserRole[] = ['admin', 'team_manager', 'media'];

/** The only role the registration form can create. */
export const SIGNUP_ROLE: UserRole = 'fan';

/** Roles a signed-up user may *ask* for through the admin-reviewed request flow. */
export const REQUESTABLE_ROLES: readonly Exclude<UserRole, 'admin' | 'fan'>[] = ['team_manager', 'media'];

export function isPrivilegedRole(role: unknown): role is Exclude<UserRole, 'fan'> {
  return typeof role === 'string' && (PRIVILEGED_ROLES as readonly string[]).includes(role);
}

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
