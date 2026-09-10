/**
 * Route handlers and the single dispatch point.
 *
 * `router.ts` declares the surface; this file implements what exists and answers 501 for everything
 * else. Keeping both in one dispatcher is deliberate: an undeclared path cannot be reached, and a
 * declared path cannot silently 404 — the two ways an API drifts away from its documentation.
 *
 * A route becomes real by (1) adding `implemented: true` and `handler` to its entry in `router.ts` and
 * (2) adding one line to `HANDLERS` below. Everything before those two lines — authentication,
 * capability check, rate limit, CORS, error envelope — already applies to it.
 */
import type { Env } from "../env.ts";
import { notImplemented } from "../lib/response.ts";
import type { Matched } from "../router.ts";
import type { Principal } from "../middleware/auth.ts";
import { handleHealth } from "./health.ts";
import { handleMe } from "./me.ts";
import { handleMyTeams } from "./teams.ts";
import {
  handleLiveSocket,
  handleLiveTicket,
  handleMatchAccess,
  handleMatchAssignmentList,
  handleMatchAudit,
  handleMatchCorrection,
  handleMatchDetail,
  handleMatchDiagnostics,
  handleMatchEvents,
  handleMatchFinalize,
  handleMatchLock,
  handleMatchSnapshot,
  handleMatchStandDown,
  handleMatchStream,
  handleMatchTransition,
  handleRecordMatchEvent,
  handleMatchAssign,
} from "./live.ts";
import {
  handleNotificationBroadcast,
  handleNotificationConfig,
  handleNotificationDiagnostics,
  handleNotificationDeviceDelete,
  handleNotificationDeviceList,
  handleNotificationDeviceRegister,
  handleNotificationInbox,
  handleNotificationInboxRead,
  handleNotificationInboxReadAll,
  handleNotificationPreferencesRead,
  handleNotificationPreferencesWrite,
} from "./notifications.ts";
import {
  handleMediaAssetDelete,
  handleMediaAssetRead,
  handleMediaAssetRestore,
  handleMediaConfig,
  handleMediaDiagnostics,
  handleMediaEntityAssets,
  handleMediaMigration,
  handleMediaSweep,
  handleMediaUpload,
} from "./media.ts";

import {
  handleAdvertisementStatus,
  handleAdAdvertisers,
  handleAdAnalytics,
  handleAdCampaigns,
  handleAdConfig,
  handleAdDiagnostics,
  handleAdEvents,
  handleAdMaintenance,
  handleAdPlacementToggle,
  handleAdPlacements,
  handleAdPreview,
  handleAdSaveAdvertiser,
  handleAdSaveAdvertisement,
  handleAdSaveCampaign,
  handleAdServe,
  handleAdViewerKey,
  handleAdvertiserStatus,
  handleCampaignStatus,
  handleAdvertisements,
} from "./ads.ts";

export interface HandlerContext {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly principal: Principal;
  readonly requestId: string;
  readonly clientAddress: string;
}

export type RouteHandler = (ctx: HandlerContext) => Promise<Response>;

/**
 * Keyed by `"<METHOD> <pattern>"`, i.e. by the same method+pattern identity `router.ts` declares and
 * `matchRoute` matches on. The method is part of the key because a resource keeps its read and write
 * paths on one pattern (`GET /matches/:id/events` is the fan timeline, `POST` to the same path is a
 * controller appending to it) — one resource, two handlers, no second URL to remember.
 */
export const HANDLERS: Record<string, RouteHandler> = {
  "GET /health": handleHealth,
  "GET /me": handleMe,
  "GET /teams/mine": handleMyTeams,

  // ── live match engine (Phase 3) ───────────────────────────────────────────
  "GET /matches/:matchId": handleMatchDetail,
  "GET /matches/:matchId/snapshot": handleMatchSnapshot,
  "GET /matches/:matchId/events": handleMatchEvents,
  "POST /matches/:matchId/events": handleRecordMatchEvent,
  "GET /matches/:matchId/access": handleMatchAccess,
  "GET /matches/:matchId/stream": handleMatchStream,
  "POST /matches/:matchId/live-ticket": handleLiveTicket,
  "GET /live/matches/:matchId": handleLiveSocket,
  "GET /matches/:matchId/diagnostics": handleMatchDiagnostics,
  "GET /matches/:matchId/audit": handleMatchAudit,
  "GET /matches/:matchId/assignments": handleMatchAssignmentList,
  "PUT /matches/:matchId/state": handleMatchTransition,
  "POST /matches/:matchId/assignments": handleMatchAssign,
  "POST /matches/:matchId/assignments/stand-down": handleMatchStandDown,
  "POST /matches/:matchId/corrections": handleMatchCorrection,
  "POST /matches/:matchId/finalize": handleMatchFinalize,
  "POST /matches/:matchId/lock": handleMatchLock,

  // ── notifications (Phase 5) ───────────────────────────────────────────────
  "POST /notifications/devices": handleNotificationDeviceRegister,
  "GET /notifications/devices": handleNotificationDeviceList,
  "DELETE /notifications/devices/:id": handleNotificationDeviceDelete,
  "GET /notifications/preferences": handleNotificationPreferencesRead,
  "PUT /notifications/preferences": handleNotificationPreferencesWrite,
  "GET /notifications/inbox": handleNotificationInbox,
  "POST /notifications/inbox/:id/read": handleNotificationInboxRead,
  "POST /notifications/inbox/read-all": handleNotificationInboxReadAll,
  "GET /notifications/config": handleNotificationConfig,
  "GET /notifications/diagnostics": handleNotificationDiagnostics,
  "POST /admin/notifications/broadcast": handleNotificationBroadcast,

  // ── media plane on R2 (Phase 6) ────────────────────────────────────────────
  "POST /media/uploads": handleMediaUpload,
  "GET /media/assets/*": handleMediaAssetRead,
  "GET /media/config": handleMediaConfig,
  "GET /media/entities/:kind/:id": handleMediaEntityAssets,
  "DELETE /media/assets/:id": handleMediaAssetDelete,
  "POST /media/assets/:id/restore": handleMediaAssetRestore,
  "GET /media/diagnostics": handleMediaDiagnostics,
  "POST /media/sweep": handleMediaSweep,
  "POST /media/migration": handleMediaMigration,

  // advertising — the viewer plane first, because those three are the only routes an anonymous browser
  // touches, and the order in this object says which ones a page depends on being up.
  "POST /advertising/viewer-key": handleAdViewerKey,
  "GET /advertising/placement/:code": handleAdServe,
  "POST /advertising/events": handleAdEvents,
  "GET /advertising/config": handleAdConfig,
  "GET /advertising/placements": handleAdPlacements,
  "POST /advertising/placements/:code": handleAdPlacementToggle,
  "GET /advertising/advertisers": handleAdAdvertisers,
  "POST /advertising/advertisers": handleAdSaveAdvertiser,
  "POST /advertising/advertisers/:id/status": handleAdvertiserStatus,
  "GET /advertising/campaigns": handleAdCampaigns,
  "POST /advertising/campaigns": handleAdSaveCampaign,
  "POST /advertising/campaigns/:id/status": handleCampaignStatus,
  "GET /advertising/creatives": handleAdvertisements,
  "POST /advertising/creatives": handleAdSaveAdvertisement,
  "POST /advertising/creatives/:id/status": handleAdvertisementStatus,
  "POST /advertising/preview": handleAdPreview,
  "POST /advertising/analytics": handleAdAnalytics,
  "GET /advertising/diagnostics": handleAdDiagnostics,
  "POST /advertising/maintenance": handleAdMaintenance,
};

export async function dispatchRoute(ctx: HandlerContext, match: Matched): Promise<Response> {
  const handler = HANDLERS[`${match.route.method} ${match.route.pattern}`];
  if (!handler || !match.route.implemented) {
    // Thrown rather than returned so the entry point's catch applies CORS + security headers to it too.
    throw notImplemented(match.route.summary, match.route.phase, "The route is declared in router.ts; its handler is not written yet.");
  }
  return handler(ctx);
}
