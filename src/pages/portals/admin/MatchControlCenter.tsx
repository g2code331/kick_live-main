/**
 * The live match console — one screen, one engine, no second opinion.
 *
 * This file is the canonical Match Control implementation. The audit in `docs/PHASE3_MATCH_CONTROL_AUDIT.md`
 * counted ten screens that each claimed to drive a match, each with its own `setInterval`, its own
 * `supabase.from("matches").update({ home_score, away_score, minute, status })` and its own idea of what
 * "live" means. That is how one match gets ten scores, so none of that survives here:
 *
 *   - **The score, the minute and the status are read, never written.** They come from the room, which
 *     takes them from Postgres, which derives them from the event ledger. There is no `+1` button on a
 *     score in this UI — a goal is an *event*, and the number follows.
 *   - **There is no timer.** The clock displayed here is `kicklive_match_clock`'s answer, extended between
 *     frames from `started_at`. A laptop lid closing does not stop a match, and a controller's clock can no
 *     longer run ahead of the ground's.
 *   - **The buttons come from the server.** `GET /api/matches/:id/access` says which transitions are legal
 *     from the current status, which of them need a confirmation, which need closing authority, and the
 *     words explaining why control is off. Disabled is feedback, never security: the same POST is refused by
 *     the database whether or not this screen rendered it.
 *   - **A tap is stored before it is sent**, so the one thing that must never happen — a goal tapped at
 *     19:58 and lost by a dropped connection — cannot happen. Queued taps are visible in the queue strip,
 *     with retry and discard under each one.
 *
 * `match` is used for its `id` and nothing else: everything else on screen is fetched, because trusting a
 * prop passed in from a list page is trusting a snapshot taken minutes earlier.
 *
 * Squad reads (`players`) still go through the legacy Supabase client, like ~27 other screens: that is a
 * read the Worker has no route for yet (audit finding F-10 covers *writes*, and Phase 3 did not add one).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Lock, LockOpen, RefreshCw, Send, Undo2, Users, Wifi, WifiOff, X, Zap } from "lucide-react";

import { supabase } from "../../../lib/supabase";
import { fetchAudit, type MatchAuditData } from "../../../lib/live/api.ts";
import { GOAL_TYPE_CHOICES, MINUTE_CEILINGS, TAP_GROUPS, tapEvent } from "../../../lib/live/eventCatalog.ts";
import { useMatchRoom } from "../../../lib/live/useMatchRoom.ts";
import type { MatchStatus } from "../../../lib/live/protocol.ts";

interface MatchControlCenterProps {
  /** Only `id` matters; everything else is read from the room so a stale list row cannot drive a live match. */
  match: { id?: number | string; match_id?: number | string } | null | undefined;
  isOpen?: boolean;
  onClose?: () => void;
  /** Alias used by the multi-match queue, which navigates instead of overlaying. */
  onBack?: () => void;
  /** Legacy callback the admin portal uses to refresh its own list after a change. */
  onUpdate?: () => void;
}

interface SquadPlayer {
  id: number;
  name: string;
  number: number | null;
  position: string | null;
  team_id: number | null;
}

interface DraftForm {
  type: string;
  teamId: number | null;
  playerId: string;
  secondPlayerId: string;
  minute: string;
  extraMinute: string;
  goalType: string;
  cardReason: string;
  description: string;
  allowDuplicate: boolean;
  error: string | null;
}

interface CorrectionForm {
  eventId: number;
  label: string;
  reason: string;
  replaceWith: string;
  error: string | null;
}

const inputClass = "w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-brand-green/60";
const labelClass = "text-[10px] font-black uppercase tracking-widest text-white/40";

export default function MatchControlCenter({ match, isOpen = true, onClose, onBack, onUpdate }: MatchControlCenterProps) {
  const close = onClose ?? onBack ?? (() => undefined);
  const matchId = Number(match?.id ?? match?.match_id ?? 0);
  const usable = Number.isFinite(matchId) && matchId > 0;

  const { state, connection, access, accessError, drafts, draftCounts, clock, secondsSinceFrame, actions } = useMatchRoom(matchId, { mode: "controller", enabled: isOpen && usable });
  const rights = access?.rights ?? null;
  const canControl = rights?.canControl === true;
  const period = state.clock?.period ?? "pre";
  const ceiling = MINUTE_CEILINGS[period] ?? 90;

  const [form, setForm] = useState<DraftForm | null>(null);
  const [correction, setCorrection] = useState<CorrectionForm | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [audit, setAudit] = useState<MatchAuditData | null>(null);
  const [homePlayers, setHomePlayers] = useState<SquadPlayer[]>([]);
  const [awayPlayers, setAwayPlayers] = useState<SquadPlayer[]>([]);
  const [defaultTeam, setDefaultTeam] = useState<"home" | "away">("home");
  const [assignmentUserId, setAssignmentUserId] = useState("");
  const [assignmentRole, setAssignmentRole] = useState("head_referee");
  const [lockReason, setLockReason] = useState("");
  const [transitionSheet, setTransitionSheet] = useState<{ to: MatchStatus; label: string; requiresConfirmation: boolean; reasonRequired: boolean; reason: string; stoppage: string; error: string | null } | null>(null);
  const lastSequence = useRef(0);

  const teamIdFor = useCallback(
    (side: "home" | "away"): number | null => (side === "home" ? (state.match?.home_team_id ?? null) : (state.match?.away_team_id ?? null)),
    [state.match?.away_team_id, state.match?.home_team_id],
  );
  const teamName = useCallback((teamId: number | null) => (teamId === null ? null : teamId === state.match?.home_team_id ? (state.match?.home_team_name ?? "Home") : teamId === state.match?.away_team_id ? (state.match?.away_team_name ?? "Away") : null), [state.match]);

  // Squads, read once per pair of teams. A player list is not live state; refetching it on a goal is noise.
  useEffect(() => {
    const ids = [state.match?.home_team_id, state.match?.away_team_id].filter((v): v is number => typeof v === "number" && v > 0);
    if (ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.from("players").select("id, name, number, position, team_id").in("team_id", ids).order("number", { ascending: true });
      if (cancelled || !data) return;
      const rows = data as SquadPlayer[];
      setHomePlayers(rows.filter((p) => p.team_id === ids[0]));
      setAwayPlayers(rows.filter((p) => p.team_id === ids[1]));
    })();
    return () => {
      cancelled = true;
    };
  }, [state.match?.away_team_id, state.match?.home_team_id]);

  const players = defaultTeam === "home" ? homePlayers : awayPlayers;
  const selectedTeamId = teamIdFor(defaultTeam);

  const flash = useCallback((tone: "ok" | "bad", text: string) => setNotice({ tone, text }), []);
  useEffect(() => {
    if (notice === null) return;
    const id = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(id);
  }, [notice]);

  // The admin portal's list refreshes when the room's cursor moves, not on a timer of its own.
  useEffect(() => {
    if (lastSequence.current !== 0 && state.sequence !== lastSequence.current) onUpdate?.();
    lastSequence.current = state.sequence;
  }, [onUpdate, state.sequence]);

  useEffect(() => {
    if (!isOpen || rights?.isAdmin !== true) {
      setAudit(null);
      return;
    }
    void fetchAudit(matchId).then(setAudit).catch(() => setAudit(null));
  }, [isOpen, matchId, rights?.isAdmin, state.sequence]);

  const openForm = useCallback(
    (type: string) => {
      const spec = tapEvent(type);
      if (!spec) return;
      if (!canControl) {
        flash("bad", access?.reason ?? "This account may not control this match.");
        return;
      }
      const needsInput = spec.confirm || spec.players !== "none" || spec.team === "required";
      if (!needsInput) {
        // One tap for the routine ones: a corner is not a decision that deserves a modal.
        void sendEvent({ event_type: spec.type, team_id: spec.team === "forbidden" ? null : selectedTeamId, minute: Math.max(0, clock.minute), description: null });
        return;
      }
      setForm({
        type: spec.type,
        teamId: spec.team === "forbidden" ? null : selectedTeamId,
        playerId: "",
        secondPlayerId: "",
        minute: String(Math.max(0, clock.minute)),
        extraMinute: "0",
        goalType: "normal",
        cardReason: "",
        description: "",
        allowDuplicate: false,
        error: null,
      });
    },
    [access?.reason, canControl, clock.minute, flash, selectedTeamId],
  );

  const sendEvent = useCallback(
    async (payload: Record<string, unknown>) => {
      const result = await actions.record(payload as Parameters<typeof actions.record>[0]);
      if (result.ok) {
        flash("ok", "Recorded.");
        setForm(null);
        return;
      }
      if (result.queued) {
        setForm((current) => (current === null ? current : { ...current, error: "No connection — kept in the queue below and it will go out by itself." }));
        flash("ok", "Saved offline. It sends when the link returns.");
        return;
      }
      const message = result.error ?? "The match server refused that event.";
      setForm((current) => (current === null ? current : { ...current, error: message }));
      flash("bad", message);
    },
    [actions, flash],
  );

  const submitForm = useCallback(() => {
    if (form === null) return;
    const spec = tapEvent(form.type);
    const minute = Number(form.minute);
    if (!Number.isFinite(minute) || minute < 0 || minute > ceiling) {
      setForm({ ...form, error: `The minute must be between 0 and ${String(ceiling)} for this period.` });
      return;
    }
    if (spec?.team === "required" && form.teamId === null) {
      setForm({ ...form, error: "Pick the side this event belongs to — the score is derived from it." });
      return;
    }
    if (spec?.players !== "none" && spec !== undefined && form.playerId === "") {
      setForm({ ...form, error: "This event needs a player." });
      return;
    }
    if (spec?.players === "one_or_two" && form.type === "substitution" && form.secondPlayerId === "") {
      setForm({ ...form, error: "A substitution needs the player coming off as well." });
      return;
    }
    void sendEvent({
      event_type: form.type,
      team_id: form.teamId,
      player_id: form.playerId === "" ? null : Number(form.playerId),
      assist_player_id: form.secondPlayerId === "" ? null : Number(form.secondPlayerId),
      minute,
      extra_minute: Math.max(0, Number(form.extraMinute) || 0),
      goal_type: spec?.goalType ? form.goalType : null,
      card_reason: spec?.cardReason && form.cardReason.length > 0 ? form.cardReason : null,
      description: form.description.length > 0 ? form.description : null,
      allow_duplicate_content: form.allowDuplicate,
    });
  }, [ceiling, form, sendEvent]);

  const submitCorrection = useCallback(() => {
    if (correction === null) return;
    if (correction.reason.trim().length < 3) {
      setCorrection({ ...correction, error: "A reason is required, and it has to say something." });
      return;
    }
    void (async () => {
      const result = await actions.correct({
        event_id: correction.eventId,
        reason: correction.reason.trim(),
        // An empty replacement voids the event: the ledger keeps the row, marked corrected, with the
        // reason and who did it. A score change follows from the recalculation, not from a second edit.
        replacement: correction.replaceWith === "" ? null : { event_type: correction.replaceWith, team_id: selectedTeamId, minute: clock.minute },
        confirm: true,
      });
      if (result.ok || result.queued) {
        setCorrection(null);
        flash("ok", result.ok ? "Corrected, and the score recalculated." : "Correction saved offline; it will go out when the link returns.");
        return;
      }
      setCorrection({ ...correction, error: result.error ?? "The correction was refused." });
    })();
  }, [actions, clock.minute, correction, flash, selectedTeamId]);

  /**
   * Transitions go through a sheet rather than `window.confirm`, because some of them *require* a reason:
   * `reason_required` on the transition row is what makes a postponement arguable in a dispute a week later,
   * and a browser confirm dialog has nowhere to type one. The sheet is also where announced stoppage is
   * attached, since `stoppage_minutes` is written by the same statement that moves the clock.
   */
  const openTransition = useCallback(
    (to: MatchStatus, label: string, requiresConfirmation: boolean, reasonRequired: boolean) => {
      if (!canControl) {
        flash("bad", access?.reason ?? "This account may not control this match.");
        return;
      }
      setTransitionSheet({ to, label, requiresConfirmation, reasonRequired, reason: "", stoppage: "", error: null });
    },
    [access?.reason, canControl, flash],
  );

  const submitTransition = useCallback(() => {
    if (transitionSheet === null) return;
    const reason = transitionSheet.reason.trim();
    if (transitionSheet.reasonRequired && reason.length < 3) {
      setTransitionSheet({ ...transitionSheet, error: "This change needs a reason — it is the audit trail a dispute is decided on." });
      return;
    }
    const stoppage = transitionSheet.stoppage === "" ? undefined : Math.max(0, Math.min(30, Number(transitionSheet.stoppage) || 0));
    void (async () => {
      const result = await actions.transition({
        status: transitionSheet.to,
        reason: reason.length > 0 ? reason : undefined,
        stoppage,
        confirm: transitionSheet.requiresConfirmation ? true : undefined,
      });
      if (result.ok) {
        setTransitionSheet(null);
        flash("ok", `${transitionSheet.label}: the room and every fan now see it.`);
        return;
      }
      setTransitionSheet({ ...transitionSheet, error: result.error ?? "That transition was refused." });
      flash("bad", result.error ?? "That transition was refused.");
    })();
  }, [actions, flash, transitionSheet]);

  const doFinalize = useCallback(() => {
    if (!window.confirm("Finalize this result? The score is derived from the recorded events, the match closes, and only an admin can reopen it.")) return;
    void (async () => {
      const result = await actions.finalize({ confirm: true });
      flash(result.ok ? "ok" : "bad", result.ok ? "Finalized. The result is frozen and the standings can pick it up." : (result.error ?? "Finalizing was refused."));
    })();
  }, [actions, flash]);

  const doLock = useCallback(
    (locked: boolean) => {
      if (locked && lockReason.trim().length < 3) {
        flash("bad", "Locking a match needs a reason.");
        return;
      }
      void (async () => {
        const result = await actions.lock({ locked, reason: locked ? lockReason.trim() : undefined });
        if (result.ok) {
          setLockReason("");
          flash("ok", locked ? "Locked for review." : "Unlocked.");
          return;
        }
        flash("bad", result.error ?? "The lock change was refused.");
      })();
    },
    [actions, flash, lockReason],
  );

  const statusLabel = state.statusLabel ?? (state.status.replace(/_/g, " "));
  const events = state.events;
  const transportLabel = connection.transport === "socket" ? "live" : connection.transport === "stream" ? "streaming" : "polling";
  const connectionTone = connection.status === "live" ? "text-brand-green" : connection.stale || connection.status === "degraded" ? "text-amber-400" : "text-white/50";

  if (!isOpen) return null;

  if (!usable) {
    return (
      <Shell onClose={close} title="Match Control">
        <p className="text-white/60">This console needs a match id. Open a fixture from the list and try again.</p>
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={close} role="presentation" />
      <div className="relative flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-[3rem] border border-white/10 bg-[#0d1117]/80 shadow-2xl glass">
        {/* ── header ── */}
        <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.02] p-6">
          <div className="flex items-center gap-5">
            <span className="rounded-lg bg-brand-red px-3 py-1 text-[10px] font-black uppercase tracking-widest">Live control</span>
            <div>
              <h2 className="text-lg font-black uppercase italic tracking-tighter">
                {state.match?.competition ?? "Match"} {state.match?.round ? `· ${state.match.round}` : ""}
              </h2>
              <p className="text-[10px] font-black uppercase tracking-widest text-white/40">{state.match?.venue ?? "Venue not set"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-black uppercase tracking-widest">
            <span className={`flex items-center gap-1 ${connectionTone}`}>
              {connection.status === "live" ? <Wifi size={14} /> : <WifiOff size={14} />}
              {transportLabel}
              {secondsSinceFrame !== null ? ` · ${String(secondsSinceFrame)}s` : ""}
            </span>
            <button onClick={() => void actions.refresh()} className="rounded-lg p-2 transition-colors hover:bg-white/10" title="Reload the authoritative snapshot">
              <RefreshCw size={16} />
            </button>
            <button onClick={close} className="rounded-full p-2 transition-colors hover:bg-white/10" title="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-6 no-scrollbar">
          {/* ── scoreboard: read-only by construction ── */}
          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-white/[0.03] p-6">
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand-green/5 to-brand-blue/5" />
            <div className="relative flex items-center justify-around gap-6">
              <TeamBlock name={state.match?.home_team_name ?? "Home"} color={state.match?.home_team_color} />
              <div className="text-center">
                <div className="flex items-center gap-4 text-7xl font-black italic tracking-tighter">
                  <span className="text-brand-green">{state.ready ? state.score.home : "–"}</span>
                  <span className="text-white/10">:</span>
                  <span className="text-brand-green">{state.ready ? state.score.away : "–"}</span>
                </div>
                {state.score.shootout ? <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-white/40">shoot-out {String(state.score.shootout.home)}–{String(state.score.shootout.away)}</p> : null}
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-4 py-1">
                  <Clock3 size={14} className="text-brand-green" />
                  <span className="text-xl font-black italic text-brand-green">
                    {String(clock.minute)}
                    {clock.extra > 0 ? `+${String(clock.extra)}` : ""}&#39;
                  </span>
                  <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{clock.running ? "running" : "stopped"}</span>
                </div>
                <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-white/40">
                  {statusLabel} · {String(events.filter((e) => e.status === "active").length)} events · derived here, not typed
                </p>
              </div>
              <TeamBlock name={state.match?.away_team_name ?? "Away"} color={state.match?.away_team_color} mirror />
            </div>
            {state.rebuiltFromDatabase ? <p className="relative mt-3 text-[10px] uppercase tracking-widest text-amber-300/80">room rebuilt from the database — the ledger is the source</p> : null}
          </div>

          {/* ── the banner line: whatever the operator must see first ── */}
          {accessError !== null || notice !== null || connection.stale || !canControl || state.conflict !== null ? (
            <div className="space-y-2">
              {accessError !== null ? <Banner tone="bad">Rights could not be read ({accessError}). Writes are still refused by the server, never by this screen.</Banner> : null}
              {notice !== null ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
              {connection.stale ? <Banner tone="warn">No frames for a while while the clock is running — reloading the snapshot, and writes stay queued until it lands.</Banner> : null}
              {state.conflict !== null ? <Banner tone="warn">Last sync conflict: {state.conflict.detail} ({state.conflict.reason}). The picture above is the server&#39;s, not the one you tried to save.</Banner> : null}
              {!canControl ? <Banner tone="warn">{access?.reason ?? "This account may not control this match."}</Banner> : null}
            </div>
          ) : null}

          {/* ── lifecycle: the server's own legal moves ── */}
          <section className="space-y-3">
            <SectionTitle icon={<Zap size={16} />} title="Match clock & state" hint="from GET /access — legal moves for this status only" />
            <div className="flex flex-wrap gap-3">
              {(access?.allowed_transitions ?? []).map((t) => {
                const blockedByAuthority = t.requires_closing_authority && rights?.canFinalize !== true;
                const disabled = !canControl || blockedByAuthority;
                return (
                  <button
                    key={t.to}
                    disabled={disabled}
                    onClick={() => openTransition(t.to, t.label, t.requires_confirmation, t.reason_required)}
                    title={disabled ? (blockedByAuthority ? "Only the head referee, match commissioner or an admin can close a match." : (access?.reason ?? "Not available")) : t.requires_confirmation ? "This will ask for confirmation" : undefined}
                    className={`rounded-2xl px-5 py-4 text-left text-sm font-black uppercase italic tracking-tight transition-colors ${
                      disabled ? "cursor-not-allowed border border-white/5 bg-white/[0.02] text-white/25" : "border border-brand-green/30 bg-brand-green/10 text-brand-green hover:bg-brand-green/20"
                    }`}
                  >
                    {t.label}
                    {t.requires_confirmation ? <span className="ml-2 text-[10px] not-italic tracking-widest text-white/40">confirm</span> : null}
                  </button>
                );
              })}
              {access === null ? <p className="text-xs text-white/40">Reading what this status allows…</p> : null}
              {access !== null && access.allowed_transitions.length === 0 ? <p className="text-xs text-white/40">Nothing else is legal from “{access.status_label}”. {rights?.canReopen ? "An admin can reopen it." : "Reopening is an admin action."}</p> : null}
            </div>
          </section>

          {/* ── the pad ── */}
          <section className="space-y-3">
            <SectionTitle icon={<Send size={16} />} title="Record" hint="one tap for routine events; a sheet when a player or a decision is involved" />
            <div className="flex gap-2">
              {(["home", "away"] as const).map((side) => (
                <button
                  key={side}
                  onClick={() => setDefaultTeam(side)}
                  className={`flex-1 rounded-xl border px-3 py-2 text-[11px] font-black uppercase tracking-widest transition-colors ${defaultTeam === side ? "border-brand-green/40 bg-brand-green/10 text-brand-green" : "border-white/10 bg-white/[0.02] text-white/40"}`}
                >
                  {side === "home" ? (state.match?.home_team_name ?? "Home") : (state.match?.away_team_name ?? "Away")}
                </button>
              ))}
            </div>
            <div className="space-y-3">
              {TAP_GROUPS.map((group) => (
                <div key={group.group} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 text-[10px] font-black uppercase tracking-widest text-white/30">{group.label}</span>
                  {group.events.map((e) => (
                    <button
                      key={e.type}
                      onClick={() => openForm(e.type)}
                      disabled={!canControl}
                      title={`${e.label}${e.confirm ? " — asks for confirmation" : ""}`}
                      className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${e.confirm ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-white/10 bg-white/[0.03] text-white/80"} ${canControl ? "hover:border-brand-green/40 hover:bg-brand-green/10" : "cursor-not-allowed opacity-40"}`}
                    >
                      <span className="mr-1">{e.glyph}</span>
                      {e.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </section>

          {/* ── the queue, if it has anything in it ── */}
          {drafts.length > 0 ? (
            <section className="space-y-2 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <SectionTitle icon={<AlertTriangle size={16} />} title={`Queue · ${String(draftCounts.pending)} waiting, ${String(draftCounts.refused)} need you`} hint="stored on this device before sending, so nothing is lost" />
              <ul className="space-y-2">
                {drafts.map((d) => (
                  <li key={d.key} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2 text-xs">
                    <span className="font-black uppercase tracking-widest text-white/40">{d.kind}</span>
                    <span className="flex-1 truncate">
                      {String(d.payload.event_type ?? (d.payload.replacement as { event_type?: string } | undefined)?.event_type ?? "correction")} · minute {String(d.payload.minute ?? "–")}
                    </span>
                    <span className={d.state === "refused" ? "text-amber-300" : "text-white/40"}>
                      {d.state === "refused" ? (d.lastError ?? "refused") : d.state === "sending" ? "sending…" : `waiting${d.attempts > 0 ? ` · try ${String(d.attempts)}` : ""}`}
                    </span>
                    {d.state === "refused" ? (
                      <button onClick={() => void actions.retryDraft(d.key)} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest">
                        retry
                      </button>
                    ) : null}
                    <button onClick={() => actions.discardDraft(d.key)} className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-white/40">
                      discard
                    </button>
                  </li>
                ))}
              </ul>
              <button onClick={actions.sendDraftsNow} className="rounded-xl border border-brand-green/30 bg-brand-green/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-brand-green">
                try all now
              </button>
            </section>
          ) : null}

          {/* ── timeline + corrections ── */}
          <section className="space-y-3">
            <SectionTitle icon={<Undo2 size={16} />} title="Timeline" hint="correcting keeps the original row and marks it corrected" />
            {events.length === 0 ? <p className="text-xs text-white/40">No events yet.</p> : null}
            <ul className="space-y-2">
              {events.slice(0, 12).map((e) => (
                <li key={`${String(e.id)}-${String(e.client_event_id ?? "x")}`} className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${e.status === "corrected" ? "bg-white/[0.02] text-white/35 line-through" : "bg-white/5"}`}>
                  <span className="w-14 text-right text-xs font-black italic text-brand-green">{String(e.minute)}{e.extra_minute > 0 ? `+${String(e.extra_minute)}` : ""}&#39;</span>
                  <span className="w-6 text-center">{tapEvent(e.event_type)?.glyph ?? "•"}</span>
                  <span className="flex-1 truncate">
                    <span className="font-bold capitalize">{e.event_type.replace(/_/g, " ")}</span>
                    {e.player_name ? <span className="text-white/60"> · {e.player_name}</span> : null}
                    {e.assist_player_name ? <span className="text-white/40"> ({e.event_type === "substitution" ? `off ${e.assist_player_name}` : `assist ${e.assist_player_name}`})</span> : null}
                    {e.team_name ? <span className="text-white/40"> · {e.team_name}</span> : null}
                  </span>
                  {e.sequence > 0 ? <span className="text-[10px] uppercase tracking-widest text-white/25">#{String(e.sequence)}</span> : null}
                  {e.status === "active" && (rights?.canCorrectAny === true || (rights?.canCorrectOwn === true && e.recorded_by !== null)) ? (
                    <button
                      onClick={() => setCorrection({ eventId: e.id, label: `${e.event_type} ${String(e.minute)}'`, reason: "", replaceWith: "", error: null })}
                      className="rounded-lg border border-white/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-white/50 hover:border-amber-400/40 hover:text-amber-200"
                    >
                      correct
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          {/* ── close-out and admin strip ── */}
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <SectionTitle icon={<CheckCircle2 size={16} />} title="Close out" />
              <button
                onClick={doFinalize}
                disabled={rights?.canFinalize !== true}
                title={rights?.canFinalize === true ? "Freeze the derived result" : "The head referee, match commissioner or an admin finalizes"}
                className="w-full rounded-xl bg-gradient-to-r from-brand-green/25 to-brand-green/5 px-4 py-3 text-xs font-black uppercase tracking-widest text-brand-green disabled:cursor-not-allowed disabled:opacity-30"
              >
                finalize result
              </button>
              <p className="text-[10px] leading-relaxed text-white/35">Finalizing derives the score from the ledger. If it disagrees with the row, the server refuses and says why — it does not overwrite.</p>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <SectionTitle icon={state.match?.is_locked ? <Lock size={16} /> : <LockOpen size={16} />} title="Lock" hint={state.match?.is_locked ? "frozen for review" : "admins only"} />
              <input value={lockReason} onChange={(e) => setLockReason(e.target.value)} placeholder="reason (required)" className={inputClass} />
              <div className="flex gap-2">
                <button onClick={() => doLock(true)} disabled={rights?.canLock !== true || state.match?.is_locked === true} className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-30">
                  lock
                </button>
                <button onClick={() => doLock(false)} disabled={rights?.canLock !== true || state.match?.is_locked !== true} className="flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-30">
                  unlock
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <SectionTitle icon={<Users size={16} />} title="Officials" hint="admin assigns; others see their own row" />
              <ul className="space-y-1 text-xs">
                {(access?.assignments ?? []).map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <span className="flex-1 truncate">
                      {a.role.replace(/_/g, " ")} · {a.username ?? a.user_id.slice(0, 8)}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-white/30">{a.status}</span>
                    {rights?.isAdmin === true ? (
                      <button onClick={() => void actions.standDown(a.id)} className="text-[10px] font-black uppercase tracking-widest text-white/40 hover:text-amber-200">
                        stand down
                      </button>
                    ) : null}
                  </li>
                ))}
                {(access?.assignments.length ?? 0) === 0 ? <li className="text-white/40">Nobody is assigned yet — until someone is, control is refused for everyone but an admin.</li> : null}
              </ul>
              {rights?.isAdmin === true ? (
                <div className="flex gap-2">
                  <input value={assignmentUserId} onChange={(e) => setAssignmentUserId(e.target.value)} placeholder="user id" className={inputClass} />
                  <select value={assignmentRole} onChange={(e) => setAssignmentRole(e.target.value)} className={`${inputClass} w-40`}>
                    {["head_referee", "assistant_referee", "fourth_official", "var_official", "match_commissioner", "data_operator"].map((r) => (
                      <option key={r} value={r}>
                        {r.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      void (async () => {
                        const result = await actions.assign({ user_id: assignmentUserId.trim(), role: assignmentRole });
                        flash(result.ok ? "ok" : "bad", result.ok ? "Assigned." : (result.error ?? "Assignment refused."));
                        if (result.ok) setAssignmentUserId("");
                      })();
                    }}
                    className="rounded-xl border border-brand-green/30 bg-brand-green/10 px-3 text-[10px] font-black uppercase tracking-widest text-brand-green"
                  >
                    assign
                  </button>
                </div>
              ) : null}
            </div>
          </section>

          {audit !== null && audit.entries.length > 0 ? (
            <details className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-white/40">Audit · {String(audit.entries.length)} recent entries (who recorded, corrected or reopened what)</summary>
              <ul className="mt-3 space-y-1 text-xs">
                {audit.entries.slice(0, 12).map((entry) => (
                  <li key={entry.id} className="flex gap-3 text-white/60">
                    <span className="w-40 shrink-0 text-white/30">{new Date(entry.created_at).toLocaleString()}</span>
                    <span className="w-44 shrink-0">{entry.action}</span>
                    <span className="flex-1 truncate">
                      {entry.actor ?? entry.actor_role ?? "system"}
                      {entry.entity_name ? ` · ${entry.entity_name}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        {/* ── footer: the cursor, so an operator can see what the screen is standing on ── */}
        <div className="flex items-center justify-between border-t border-white/10 bg-white/[0.02] px-6 py-3 text-[10px] font-black uppercase tracking-widest text-white/30">
          <span>
            sequence {String(state.sequence)} · {String(state.controllersOnline)} controller{state.controllersOnline === 1 ? "" : "s"} · {String(state.viewersOnline)} watching
            {state.peerController ? " · another console is open" : ""}
          </span>
          <span>protocol v1 · server clock · match #{String(matchId)}</span>
        </div>

        {/* ── the sheet ── */}
        {form !== null ? (
          <div className="absolute inset-0 flex items-end justify-center bg-black/60 p-6 backdrop-blur-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitForm();
              }}
              className="w-full max-w-2xl space-y-4 rounded-[2rem] border border-white/10 bg-[#0d1117] p-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black uppercase italic tracking-tighter">
                  {tapEvent(form.type)?.glyph} {tapEvent(form.type)?.label ?? form.type}
                </h3>
                <button type="button" onClick={() => setForm(null)} className="rounded-lg p-2 hover:bg-white/10">
                  <X size={16} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <label className="space-y-1">
                  <span className={labelClass}>side</span>
                  <select value={form.teamId ?? ""} onChange={(e) => setForm({ ...form, teamId: e.target.value === "" ? null : Number(e.target.value), playerId: "", secondPlayerId: "" })} className={inputClass}>
                    <option value="">—</option>
                    {state.match?.home_team_id ? <option value={String(state.match.home_team_id)}>{state.match.home_team_name}</option> : null}
                    {state.match?.away_team_id ? <option value={String(state.match.away_team_id)}>{state.match.away_team_name}</option> : null}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className={labelClass}>minute (0–{String(ceiling)})</span>
                  <input type="number" min={0} max={ceiling} value={form.minute} onChange={(e) => setForm({ ...form, minute: e.target.value })} className={inputClass} />
                </label>
                <label className="space-y-1">
                  <span className={labelClass}>extra</span>
                  <input type="number" min={0} max={30} value={form.extraMinute} onChange={(e) => setForm({ ...form, extraMinute: e.target.value })} className={inputClass} />
                </label>
                {tapEvent(form.type)?.goalType ? (
                  <label className="space-y-1">
                    <span className={labelClass}>type</span>
                    <select value={form.goalType} onChange={(e) => setForm({ ...form, goalType: e.target.value })} className={inputClass}>
                      {GOAL_TYPE_CHOICES.map((g) => (
                        <option key={g.value} value={g.value}>
                          {g.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
              {tapEvent(form.type)?.players !== "none" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1">
                    <span className={labelClass}>{form.type === "substitution" ? "coming on" : form.type === "own_goal" ? "scorer (own goal)" : "player"}</span>
                    <select value={form.playerId} onChange={(e) => setForm({ ...form, playerId: e.target.value })} className={inputClass}>
                      <option value="">—</option>
                      {players.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.number !== null ? `${String(p.number)} · ` : ""}
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {tapEvent(form.type)?.players === "one_or_two" ? (
                    <label className="space-y-1">
                      <span className={labelClass}>{form.type === "substitution" ? "coming off" : "assist"}</span>
                      <select value={form.secondPlayerId} onChange={(e) => setForm({ ...form, secondPlayerId: e.target.value })} className={inputClass}>
                        <option value="">—</option>
                        {players.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.number !== null ? `${String(p.number)} · ` : ""}
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : (
                <p className="text-[10px] uppercase tracking-widest text-white/30">{tapEvent(form.type)?.players === "none" ? "this event has no player attached" : ""}</p>
              )}
              {tapEvent(form.type)?.cardReason ? (
                <label className="space-y-1 block">
                  <span className={labelClass}>reason</span>
                  <input value={form.cardReason} onChange={(e) => setForm({ ...form, cardReason: e.target.value })} placeholder="dissent, tactical, last defender…" className={inputClass} />
                </label>
              ) : null}
              <label className="space-y-1 block">
                <span className={labelClass}>note (optional)</span>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} />
              </label>
              {form.error !== null && /already recorded this minute/i.test(form.error) ? (
                <label className="flex items-center gap-2 text-xs text-amber-200">
                  <input type="checkbox" checked={form.allowDuplicate} onChange={(e) => setForm({ ...form, allowDuplicate: e.target.checked })} />
                  it really is a second identical event — record it anyway
                </label>
              ) : null}
              {form.error !== null ? <Banner tone="bad">{form.error}</Banner> : null}
              <div className="flex items-center justify-end gap-3">
                <button type="button" onClick={() => setForm(null)} className="rounded-xl border border-white/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white/40">
                  cancel
                </button>
                <button type="submit" className="rounded-xl bg-brand-green px-5 py-2 text-[11px] font-black uppercase tracking-widest text-black">
                  {tapEvent(form.type)?.confirm ? "confirm & record" : "record"}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {transitionSheet !== null ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitTransition();
              }}
              className="w-full max-w-lg space-y-4 rounded-[2rem] border border-white/10 bg-[#0d1117] p-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black uppercase italic tracking-tighter">{transitionSheet.label}</h3>
                <button type="button" onClick={() => setTransitionSheet(null)} className="rounded-lg p-2 hover:bg-white/10">
                  <X size={16} />
                </button>
              </div>
              <p className="text-xs text-white/50">
                {transitionSheet.requiresConfirmation
                  ? "This ends or interrupts the match: every fan watching sees it, and the other officials are told. The server writes the clock as well as the status."
                  : "The room, the clock and every connected screen move with it. The status is written by the server, which is why this cannot be half-applied."}
              </p>
              <label className="space-y-1 block">
                <span className={labelClass}>{transitionSheet.reasonRequired ? "reason (required)" : "reason (optional, and worth writing)"}</span>
                <input value={transitionSheet.reason} onChange={(e) => setTransitionSheet({ ...transitionSheet, reason: e.target.value })} placeholder="floodlight failure, security instruction, injured player on the pitch…" className={inputClass} autoFocus />
              </label>
              <label className="space-y-1 block">
                <span className={labelClass}>announced stoppage (0–30, optional)</span>
                <input type="number" min={0} max={30} value={transitionSheet.stoppage} onChange={(e) => setTransitionSheet({ ...transitionSheet, stoppage: e.target.value })} className={inputClass} />
              </label>
              <p className="text-[10px] uppercase tracking-widest text-white/25">stoppage is saved with this move: matches.minute and the clock belong to the same statement, never to a browser timer</p>
              {transitionSheet.error !== null ? <Banner tone="bad">{transitionSheet.error}</Banner> : null}
              <div className="flex items-center justify-end gap-3">
                <button type="button" onClick={() => setTransitionSheet(null)} className="rounded-xl border border-white/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white/40">
                  cancel
                </button>
                <button type="submit" className="rounded-xl bg-brand-green px-5 py-2 text-[11px] font-black uppercase tracking-widest text-black">
                  {transitionSheet.requiresConfirmation ? "confirm the change" : "move the match"}
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {correction !== null ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitCorrection();
              }}
              className="w-full max-w-lg space-y-4 rounded-[2rem] border border-white/10 bg-[#0d1117] p-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-black uppercase italic tracking-tighter">Correct · {correction.label}</h3>
                <button type="button" onClick={() => setCorrection(null)} className="rounded-lg p-2 hover:bg-white/10">
                  <X size={16} />
                </button>
              </div>
              <p className="text-xs text-white/50">
                The original row stays in the ledger and is marked corrected, with your name, the time and this reason. Fans watching already saw the first version — that is why this one is deliberate.
              </p>
              <label className="space-y-1 block">
                <span className={labelClass}>reason (required)</span>
                <input value={correction.reason} onChange={(e) => setCorrection({ ...correction, reason: e.target.value })} placeholder="wrong player credited, offside, VAR overturned…" className={inputClass} autoFocus />
              </label>
              <label className="space-y-1 block">
                <span className={labelClass}>replace with (optional)</span>
                <select value={correction.replaceWith} onChange={(e) => setCorrection({ ...correction, replaceWith: e.target.value })} className={inputClass}>
                  <option value="">void it — no replacement</option>
                  {TAP_GROUPS.flatMap((g) => g.events).map((e) => (
                    <option key={e.type} value={e.type}>
                      {e.label}
                    </option>
                  ))}
                </select>
              </label>
              {correction.error !== null ? <Banner tone="bad">{correction.error}</Banner> : null}
              <div className="flex items-center justify-end gap-3">
                <button type="button" onClick={() => setCorrection(null)} className="rounded-xl border border-white/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white/40">
                  cancel
                </button>
                <button type="submit" className="rounded-xl bg-amber-400 px-5 py-2 text-[11px] font-black uppercase tracking-widest text-black">
                  correct the record
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose} role="presentation" />
      <div className="glass relative w-full max-w-lg space-y-4 rounded-[2rem] border border-white/10 p-8 text-center">
        <h2 className="text-xl font-black uppercase italic tracking-tighter">{title}</h2>
        {children}
        <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white/50">
          close
        </button>
      </div>
    </div>
  );
}

function TeamBlock({ name, color, mirror = false }: { name: string; color: string | null | undefined; mirror?: boolean }) {
  return (
    <div className={`z-10 w-40 space-y-2 text-center ${mirror ? "order-3" : ""}`}>
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-white/10 bg-white/5 text-2xl font-black italic" style={color ? { borderColor: `${color}66`, boxShadow: `0 0 24px ${color}22` } : undefined}>
        {name.slice(0, 2).toUpperCase()}
      </div>
      <h3 className="text-xs font-black uppercase tracking-widest">{name}</h3>
    </div>
  );
}

function SectionTitle({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-brand-green">{icon}</span>
      <h3 className="text-sm font-black uppercase tracking-widest">{title}</h3>
      {hint ? <span className="text-[10px] uppercase tracking-widest text-white/25">{hint}</span> : null}
    </div>
  );
}

function Banner({ tone, children }: { tone: "ok" | "bad" | "warn"; children: ReactNode }) {
  const classes = tone === "ok" ? "border-brand-green/30 bg-brand-green/10 text-brand-green" : tone === "bad" ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-amber-400/30 bg-amber-400/10 text-amber-200";
  return <p className={`rounded-xl border px-3 py-2 text-xs ${classes}`}>{children}</p>;
}
