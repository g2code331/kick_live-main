/**
 * The profile projection the API is willing to return.
 *
 * One list of columns, one list of fields, in one place: `profiles` carries `email`, `phone` and
 * `avatar_url`, and the audit (F-05) is about this table being read more widely than it should be. A
 * route that needs a profile calls `toSafeProfile`, so "what the API returns about a user" cannot
 * drift per endpoint.
 *
 * `phone` is deliberately absent even from `/api/me`: the SPA already has it via Supabase, and a
 * convenience field here is one more surface to forget about.
 */
import type { AppRole } from "../env.ts";
import { capabilitiesFor } from "../lib/capabilities.ts";
import type { Principal } from "../middleware/auth.ts";

/** The exact columns the Worker may read out of `public.profiles` for identity purposes. */
export const PROFILE_COLUMNS = "id, email, username, role";

export interface ProfileRow {
  id: string;
  email: string | null;
  username: string | null;
  role: string;
}

export interface SafeProfile {
  userId: string;
  email: string | null;
  username: string | null;
  role: AppRole;
  /**
   * Resolved from the same matrix the Worker enforces, so the client can grey out a button for the
   * right reason — and still be refused by the Worker if it does not. This is a hint, never a grant.
   */
  capabilities: string[];
}

export function toSafeProfile(principal: Principal): SafeProfile {
  return {
    userId: principal.userId,
    email: principal.email,
    username: principal.username,
    role: (principal.role ?? "fan") as AppRole,
    capabilities: capabilitiesFor(principal.role ?? "fan"),
  };
}

export function isProfileRow(value: unknown): value is ProfileRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.role === "string";
}
