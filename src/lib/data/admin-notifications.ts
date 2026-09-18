/**
 * Admin-side notification sending.
 *
 * The Worker exposes `POST /admin/notifications/broadcast` (capability `notifications.broadcast`), which
 * fans a title/body of a given `kind` out to every notification-enabled account and queues delivery. This
 * module is the browser's typed door to it, plus the vocabulary an admin picks from.
 *
 * Audience targeting (all managers / all media / a specific account) is a server capability added by the
 * phase-14 migration: `POST /admin/notifications/direct`. Where that route is not yet deployed the call
 * degrades to a clear error rather than a silent no-op, and the broadcast path (everyone) always works.
 */
import { api } from '../api/index.ts';
import type { ApiResult } from '../api/index.ts';

/** The five kinds an admin broadcast may claim — never a match-event category (those come from the engine). */
export const ADMIN_BROADCAST_KINDS = [
  { id: 'announcement', label: 'Announcement', desc: 'A league-wide notice' },
  { id: 'news', label: 'News', desc: 'A story or update' },
  { id: 'competition_update', label: 'Competition update', desc: 'Fixtures / standings news' },
  { id: 'team_update', label: 'Team update', desc: 'Club-level news' },
  { id: 'system', label: 'System', desc: 'Account / platform notice' },
] as const;

export type AdminBroadcastKind = (typeof ADMIN_BROADCAST_KINDS)[number]['id'];

/** Who a send is addressed to. `everyone` uses the broadcast route; the rest use the direct route. */
export const NOTIFICATION_AUDIENCES = [
  { id: 'everyone', label: 'Everyone', desc: 'All notification-enabled accounts' },
  { id: 'role:team_manager', label: 'All team managers', desc: 'Every account with the manager role' },
  { id: 'role:media', label: 'All media', desc: 'Every account with the media role' },
  { id: 'role:admin', label: 'All admins', desc: 'Every administrator account' },
  { id: 'user', label: 'A specific person', desc: 'One account, by user' },
] as const;

export type NotificationAudienceId = (typeof NOTIFICATION_AUDIENCES)[number]['id'];

export interface BroadcastResult {
  jobId: number | null;
  audience: number | null;
  status: string;
  note?: string;
}

export interface SendOptions {
  title: string;
  body: string;
  kind: AdminBroadcastKind;
  audience: NotificationAudienceId;
  /** Required when `audience === 'user'`: the target profile id. */
  userId?: string | null;
  /** Required above the server's soft cap (large audiences). */
  confirm?: boolean;
}

/**
 * Send a notification. `everyone` posts to the broadcast route; a role or a single user posts to the direct
 * route. Both return the same shape so the caller has one success/error path.
 */
export function sendNotification(opts: SendOptions): Promise<ApiResult<BroadcastResult>> {
  if (opts.audience === 'everyone') {
    return api.post<BroadcastResult>('/admin/notifications/broadcast', {
      title: opts.title,
      body: opts.body,
      kind: opts.kind,
      confirm: opts.confirm ?? false,
    });
  }
  const target =
    opts.audience === 'user'
      ? { audience: 'user', userId: opts.userId }
      : { audience: 'role', role: opts.audience.slice('role:'.length) };
  return api.post<BroadcastResult>('/admin/notifications/direct', {
    title: opts.title,
    body: opts.body,
    kind: opts.kind,
    confirm: opts.confirm ?? false,
    ...target,
  });
}
