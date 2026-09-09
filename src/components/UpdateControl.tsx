import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock, Download, ExternalLink, RefreshCw } from "lucide-react";

import { desktopApi } from "../lib/app-shell.ts";
import { useUpdateControl } from "../lib/use-update-control.ts";

/**
 * The "one control, two surfaces" component: in the desktop shell it drives the privileged
 * download/verify/install flow over IPC; on web/PWA it drives the service-worker activation flow.
 * It is *always* rendered — including when no update feed is reachable — because "no update
 * control at all" is indistinguishable from "auto-update silently broken".
 */
export default function UpdateControl() {
  const { model, check, snooze, apply } = useUpdateControl();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const promptShown = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const api = desktopApi();

  useEffect(() => {
    if (model.shouldPrompt && !promptShown.current) {
      promptShown.current = true;
      setPrompt(true);
    }
  }, [model.shouldPrompt]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const stateAttr = model.state;
  const Icon = model.state === "available" ? Download : model.state === "error" ? AlertTriangle : model.state === "up-to-date" ? Check : Clock;
  const tone =
    model.state === "available"
      ? "bg-brand-green/15 text-brand-green border-brand-green/40"
      : model.state === "error"
        ? "bg-brand-red/15 text-brand-red border-brand-red/40"
        : "bg-white/5 text-white/60 border-white/10";

  const openNotes = () => {
    const url = model.notesUrl;
    if (!url) return;
    if (api) void api.openExternal(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div ref={wrapRef} className="relative" data-kicklive="update-control" data-state={stateAttr} data-feed-configured={String(model.feedConfigured)}>
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          void check();
        }}
        title={model.label}
        aria-label={`Updates: ${model.label}`}
        className={`hidden md:flex items-center gap-2 px-3 py-2 rounded-lg border font-bold text-xs uppercase tracking-wider transition-colors ${tone}`}
      >
        <Icon size={14} className={model.checking ? "animate-spin" : ""} />
        <span>{model.state === "available" ? `Update ${model.candidateVersion ?? ""}`.trim() : model.shortLabel}</span>
      </button>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`Updates: ${model.label}`} className="md:hidden p-2 rounded-full border border-white/10 bg-white/5">
        <Icon size={16} className={model.state === "available" ? "text-brand-green" : "text-white/60"} />
      </button>

      {model.state === "available" && !prompt ? <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-brand-green animate-pulse" aria-hidden="true" /> : null}

      {open ? (
        <div className="absolute right-0 top-full mt-2 w-[22rem] glass rounded-2xl border border-white/10 shadow-2xl z-[220] p-4 space-y-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-white/40">Updates · {model.surface}</p>
          <p className="text-sm font-bold">{model.label}</p>
          <p className="text-[11px] text-white/40">
            channel {model.channel ?? "—"} · version {model.currentVersion ?? "—"}
            {model.lastSeenAt ? ` · last checked ${model.lastSeenAt}` : " · never checked"}
          </p>
          {model.lastError ? <p className="text-[11px] text-brand-red/80">{model.lastError}</p> : null}

          <div className="flex flex-col gap-2 pt-1">
            <button type="button" onClick={() => void check()} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold uppercase tracking-wider">
              <RefreshCw size={13} /> Check now
            </button>
            {model.state === "available" ? (
              <>
                <button
                  type="button"
                  onClick={() => void apply()}
                  className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-brand-green text-black text-xs font-black uppercase tracking-wider hover:brightness-110"
                >
                  <Download size={13} /> {api ? "Download & install" : "Reload app"}
                </button>
                {model.notesUrl ? (
                  <button type="button" onClick={openNotes} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold uppercase tracking-wider">
                    <ExternalLink size={13} /> Release notes
                  </button>
                ) : null}
                {!model.mandatory ? (
                  <button
                    type="button"
                    onClick={() => void snooze(12)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-bold uppercase tracking-wider"
                  >
                    <Clock size={13} /> Snooze 12h
                  </button>
                ) : (
                  <p className="text-[11px] text-brand-orange">This update is mandatory; snoozing is disabled.</p>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {prompt ? (
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Update available">
          <div className="glass rounded-2xl border border-white/10 max-w-md w-full p-6 space-y-4">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-brand-green">Update available</p>
            <h2 className="text-2xl font-black">KickLive {model.candidateVersion}</h2>
            {model.notes ? <p className="text-sm text-white/70 whitespace-pre-line">{model.notes}</p> : null}
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setPrompt(false);
                  void apply();
                }}
                className="px-4 py-2 rounded-lg bg-brand-green text-black font-black uppercase tracking-wider text-xs hover:brightness-110"
              >
                {api ? "Install & restart" : "Reload now"}
              </button>
              {!model.mandatory ? (
                <button
                  type="button"
                  onClick={() => {
                    setPrompt(false);
                    void snooze(12);
                  }}
                  className="px-4 py-2 rounded-lg border border-white/10 text-xs font-bold uppercase tracking-wider text-white/70 hover:bg-white/5"
                >
                  Remind me in 12 hours
                </button>
              ) : null}
              <button type="button" onClick={() => setPrompt(false)} className="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-white/40 hover:text-white/70">
                Later
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
