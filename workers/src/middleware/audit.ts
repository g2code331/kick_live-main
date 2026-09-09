/**
 * Audit trail for privileged actions, written by the Worker rather than the browser.
 *
 * Today `activity_logs` is appended to from `AdminPortal.logActivity()` in the client: it can be
 * skipped, reordered, or filled with whatever the caller likes, and it is the only record of who ran
 * a match. Once a route owns the action, the log line is written in the same handler as the write,
 * with the identity taken from the verified token — that is what makes it evidence.
 *
 * `action` values are namespaced (`user.role_media`, `match.finalize`) so the admin feed can filter
 * without parsing prose, and match the strings the Phase 1 hardening migration already writes.
 */
import type { Env } from "../env";
import { supabaseAdmin } from "../lib/supabase";
import { logDebug } from "../lib/debug";

export interface AuditEntry {
  /** Actor (the admin who acted), not the subject of the action. */
  actorId: string;
  action: string;
  entityType: string;
  /** `profiles.id` is a uuid while this column is integer, so subjects are named, not keyed. */
  entityId?: number;
  entityName?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  const payload = {
    user_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    entity_name: entry.entityName ?? null,
    details: {
      ...(entry.details ?? {}),
      via: "worker",
      ...(entry.requestId ? { request_id: entry.requestId } : {}),
    },
  };

  try {
    await supabaseAdmin(env).from("activity_logs").insertOne(payload);
  } catch (err) {
    // Never fail a business write because the audit row could not be written — but shout about it,
    // because an audit trail that silently drops rows is worse than none (nobody trusts it).
    logDebug("audit write failed", entry.action, err instanceof Error ? err.message : String(err));
  }
}
