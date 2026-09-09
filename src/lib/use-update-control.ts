/**
 * The update control's headless logic, kept out of JSX so it can be unit/integration tested in
 * plain node (`tests/unit/update-control.test.ts`) without a browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DesktopApi } from "../../desktop/src/api.ts";
import type { UpdateDecision } from "../../shared/update-manifest.ts";
import type { UpdateView } from "../../desktop/src/api.ts";
import { APP_VERSION, desktopApi, SHELL } from "./app-shell.ts";
import { getWebController, isDesktopShell, webChannel } from "./updates.ts";

export type UpdateViewModel = {
  /** drives the icon + colour; also asserted by the tests */
  state: UpdateDecision["state"];
  reason: UpdateDecision["reason"];
  label: string;
  shortLabel: string;
  candidateVersion: string | null;
  mandatory: boolean;
  /** true => the auto-prompt dialog should open (at most once per open) */
  shouldPrompt: boolean;
  snoozed: boolean;
  feedConfigured: boolean;
  notesUrl: string | null;
  notes: string | null;
  /** which surface this control is driving; asserted by the updates contract test */
  surface: "desktop" | "web";
  channel: string | null;
  currentVersion: string | null;
  lastSeenAt: string | null;
  checking: boolean;
  busyAction: "check" | "install" | "snooze" | "reload" | null;
  lastError: string | null;
};

const FALLBACK_VIEW: UpdateViewModel = {
  state: "unknown",
  reason: "manifest-unreachable",
  label: "Update status unknown",
  shortLabel: "Unknown",
  candidateVersion: null,
  mandatory: false,
  shouldPrompt: false,
  snoozed: false,
  feedConfigured: false,
  notesUrl: null,
  notes: null,
  surface: "web",
  channel: null,
  currentVersion: null,
  lastSeenAt: null,
  checking: false,
  busyAction: null,
  lastError: null,
};

export function viewModelFromDecision(view: UpdateView | null, extra: Partial<UpdateViewModel> = {}): UpdateViewModel {
  if (!view) return { ...FALLBACK_VIEW, ...extra };
  const d = view.decision;
  const label = describe(d, view.feedConfigured);
  return {
    state: d.state,
    reason: d.reason,
    label,
    shortLabel: short(d),
    candidateVersion: d.candidateVersion ?? null,
    mandatory: d.mandatory,
    shouldPrompt: view.mayPrompt,
    snoozed: d.reason === "snoozed",
    notesUrl: d.notesUrl ?? null,
    notes: d.notes ?? null,
    feedConfigured: view.feedConfigured,
    checking: false,
    busyAction: null,
    lastError: d.state === "error" ? (d.detail ?? d.reason) : d.state === "unknown" ? (d.detail ?? null) : null,
    surface: SHELL === "desktop" ? "desktop" : "web",
    channel: view.channel ?? (isDesktopShell() ? null : webChannel()),
    currentVersion: APP_VERSION,
    lastSeenAt: d.lastSeenAt ?? null,
    ...extra,
  };
}

function short(d: UpdateDecision): string {
  switch (d.state) {
    case "available":
      return `Update ${d.candidateVersion ?? ""}`.trim();
    case "up-to-date":
      return "Up to date";
    case "error":
      return "Update error";
    default:
      return "Unknown";
  }
}

function describe(d: UpdateDecision, feedConfigured: boolean): string {
  if (!feedConfigured) return "Update feed not configured";
  switch (d.reason) {
    case "manifest-unreachable":
      return d.lastSeenAt ? `Update status unknown (feed unreachable, last checked ${d.lastSeenAt})` : "Update status unknown (never checked)";
    case "manifest-invalid":
      return "Update feed returned an invalid manifest";
    case "channel-mismatch":
      return "Update feed is on a different channel";
    case "platform-missing":
      return "No artifact published for this platform";
    case "snoozed":
      return `Update ${d.candidateVersion} snoozed`;
    case "never-downgrade":
      return "Up to date (feed offers an older release)";
    case "current-is-newest":
      return "Up to date";
    case "no-web-bundle":
      return "Update available, but no web bundle is published";
    case "update-available":
      return `Update ${d.candidateVersion ?? ""} available`.trim();
    default:
      return "Up to date";
  }
}

export type UseUpdateControl = {
  surface: "desktop" | "pwa";
  model: UpdateViewModel;
  check: () => Promise<void>;
  snooze: (hours?: number) => Promise<void>;
  apply: () => Promise<{ ok: boolean; detail: string }>;
  dismissPrompt: () => void;
  open: () => Promise<void>;
};

export function useUpdateControl(): UseUpdateControl {
  const api: DesktopApi | null = desktopApi();
  const desktop = isDesktopShell();
  const [model, setModel] = useState<UpdateViewModel>(FALLBACK_VIEW);
  const [promptOpen, setPromptOpen] = useState(false);
  const promptShownThisOpen = useRef(false);
  const mounted = useRef(true);

  const applyView = useCallback((view: UpdateView | null, extra: Partial<UpdateViewModel> = {}) => {
    if (!mounted.current) return;
    const next = viewModelFromDecision(view, extra);
    setModel(next);
    if (view?.mayPrompt && !promptShownThisOpen.current) {
      promptShownThisOpen.current = true;
      setPromptOpen(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      if (desktop && api) {
        const startup = await api.startupUpdateState();
        if (cancelled) return;
        if (startup) applyView(startup);
        else applyView(null, { feedConfigured: true, checking: true });
        const off = api.onUpdateEvent((view) => applyView(view));
        const fresh = await api.checkForUpdates().catch(() => null);
        if (!cancelled && fresh) applyView(fresh);
        return () => {
          off();
        };
      }
      if (desktop && !api) {
        // Desktop bundle without the bridge (e.g. renderer served standalone in CI): still render.
        applyView(null, { feedConfigured: false, channel: null });
        return;
      }
      const controller = getWebController();
      applyView(null, { feedConfigured: true, checking: true, channel: webChannel() });
      const summary = await controller.check("startup").catch(() => null);
      if (cancelled || !summary) return;
      applyView({ decision: summary.decision, mayPrompt: summary.mayPrompt, feedConfigured: true, channel: webChannel() });
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [api, desktop, applyView]);

  const check = useCallback(async () => {
    if (desktop && api) {
      setModel((m) => ({ ...m, checking: true, busyAction: "check" }));
      const view = await api.checkForUpdates().catch(() => null);
      applyView(view, { busyAction: null });
      return;
    }
    setModel((m) => ({ ...m, checking: true, busyAction: "check" }));
    const summary = await getWebController()
      .check("manual")
      .catch(() => null);
    if (summary) applyView({ decision: summary.decision, mayPrompt: summary.mayPrompt, feedConfigured: true, channel: webChannel() }, { busyAction: null });
    else setModel((m) => ({ ...m, checking: false, busyAction: null }));
  }, [api, applyView, desktop]);

  const snooze = useCallback(
    async (hours?: number) => {
      setPromptOpen(false);
      if (desktop && api) {
        const view = await api.snoozeUpdate(hours).catch(() => null);
        if (view) applyView(view);
        return;
      }
      const summary = await getWebController()
        .snooze(hours)
        .catch(() => null);
      if (summary) applyView({ decision: summary.decision, mayPrompt: false, feedConfigured: true, channel: webChannel() });
    },
    [api, applyView, desktop],
  );

  const apply = useCallback(async (): Promise<{ ok: boolean; detail: string }> => {
    if (desktop && api) {
      setModel((m) => ({ ...m, busyAction: "install" }));
      const result = await api.installUpdate().catch((err: unknown) => ({ ok: false, detail: String(err) }));
      setModel((m) => ({ ...m, busyAction: null }));
      return result;
    }
    setModel((m) => ({ ...m, busyAction: "reload" }));
    await getWebController()
      .reload()
      .catch(() => undefined);
    setModel((m) => ({ ...m, busyAction: null }));
    return { ok: true, detail: "reloading" };
  }, [api, desktop]);

  return {
    surface: desktop ? "desktop" : "pwa",
    model,
    check,
    snooze,
    apply,
    dismissPrompt: () => setPromptOpen(false),
    open: async () => {
      if (model.shouldPrompt && !promptShownThisOpen.current) {
        promptShownThisOpen.current = true;
        setPromptOpen(true);
      }
    },
  };
}

export type { UseUpdateControl as UpdateControlApi };
