/**
 * Privileged identity operations: the only paths by which a role can change.
 *
 * These are thin wrappers over `SECURITY DEFINER` Postgres functions (created by
 * `supabase/migrations/20260909120000_phase1_security_hardening.sql`). The client is still untrusted:
 * every function re-checks the caller inside the database, so a tampered UI that calls
 * `kicklive_set_user_role('…, "admin")` from a fan's JWT gets `42501 permission denied (not an admin)`.
 *
 * Why not `supabase.from('profiles').update({ role })`, as this used to do:
 *   1. it relied on `profiles.role` being non-updatable by *your own* policy, which the shipped RLS
 *      set did not guarantee (docs/SECURITY_AUDIT_PHASE1.md F-01: privilege escalation);
 *   2. it left no audit row;
 *   3. it could not enforce "an admin cannot demote the last admin".
 */
import { supabase } from "./supabase";
import type { UserRole } from "./supabase";
import { log } from "./log";

/** Same message every privileged call shows before the hardening migration is applied. */
const MIGRATION_REQUIRED = "Privileged role operations need the Phase 1 hardening migration " + "(supabase/migrations/20260909120000_phase1_security_hardening.sql) applied to this project.";

function friendly(error: { code?: string; message?: string } | null): string | null {
  if (!error) return null;
  // PGRST202 = "Could not find the function" in PostgREST — migration not applied yet.
  if (error.code === "PGRST202") return MIGRATION_REQUIRED;
  return error.message || "Request failed";
}

export interface AccessRequest {
  id: string;
  user_id: string;
  requested_role: "team_manager" | "media";
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  /** Joined for the admin list view only; the policy exposes rows an admin is allowed to see. */
  profiles?: { username?: string; email?: string } | null;
}

export interface RoleChangeResult {
  ok: boolean;
  error: string | null;
}

/**
 * Grant/revoke a role. Admin-only (checked in-database), audited into `activity_logs`, and refused
 * if it would leave the instance without an admin. `admin` can only ever be set by another admin.
 */
export async function setUserRole(targetUserId: string, nextRole: UserRole): Promise<RoleChangeResult> {
  const { error } = await supabase.rpc("kicklive_set_user_role", {
    p_user_id: targetUserId,
    p_role: nextRole,
  });
  const message = friendly(error as { code?: string; message?: string } | null);
  if (message) log.error("[access] role change rejected:", targetUserId, message);
  else log.debug("[access] role updated");
  return { ok: !message, error: message };
}

/**
 * A signed-up fan asks for `team_manager` or `media`. It creates a *request*, never a permission:
 * an admin approves it from User Control. `admin` is not requestable at all (CHECK constraint).
 */
export async function submitAccessRequest(requestedRole: "team_manager" | "media", reason: string): Promise<RoleChangeResult> {
  const trimmed = reason.trim().slice(0, 1000);
  if (trimmed.length < 10) {
    return { ok: false, error: "Add a sentence about your club or newsroom so an admin can decide." };
  }
  const { error } = await supabase.rpc("kicklive_request_access", {
    p_role: requestedRole,
    p_reason: trimmed,
  });
  const message = friendly(error as { code?: string; message?: string } | null);
  return { ok: !message, error: message };
}

/** Pending requests an admin still has to decide on. Blocked for non-admins by RLS (returns []). */
export async function listPendingAccessRequests(): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from("access_requests")
    .select("id, user_id, requested_role, reason, status, created_at, decided_at, decided_by, profiles:profiles!access_requests_user_id_fkey(username, email)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    log.debug("[access] pending requests unavailable:", error.message);
    return [];
  }
  return (data || []) as unknown as AccessRequest[];
}

/**
 * Approve (grants the role) or reject a request. The grant happens inside the same definer
 * transaction, so there is no window where a request is marked approved but the role was not set.
 */
export async function decideAccessRequest(requestId: string, decision: "approved" | "rejected"): Promise<RoleChangeResult> {
  const { error } = await supabase.rpc("kicklive_decide_access_request", {
    p_request_id: requestId,
    p_decision: decision,
  });
  const message = friendly(error as { code?: string; message?: string } | null);
  return { ok: !message, error: message };
}

/** Let an applicant withdraw their own pending request. */
export async function cancelMyAccessRequest(requestId: string): Promise<RoleChangeResult> {
  const { error } = await supabase.rpc("kicklive_cancel_access_request", { p_request_id: requestId });
  const message = friendly(error as { code?: string; message?: string } | null);
  return { ok: !message, error: message };
}
