/**
 * The desktop IPC contract, written once and used by both sides of the bridge.
 * Types only — nothing here imports electron, so the web build can use it too.
 */

import type { Channel, UpdateDecision } from "../../shared/update-manifest.ts";

export type DesktopPlatform = "linux" | "darwin" | "win32" | "freebsd" | "openbsd" | "android" | string;

export type DesktopInfo = {
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  platform: DesktopPlatform;
  arch: string;
  platformId: string;
  channel: Channel;
  shell: "desktop";
  /** what the window actually loaded, e.g. file:///…/renderer/dist/index.html */
  loadSource: string;
  /** true when the load ladder had to fall back to the embedded server or the diagnostic page */
  usedFallback: boolean;
  attempts: number;
  updateFeedConfigured: boolean;
  updateFeedUrl: string;
  userDataDir: string;
};

export type UpdateView = {
  decision: UpdateDecision;
  mayPrompt: boolean;
  feedConfigured: boolean;
  /** which channel the client is subscribed to (mirrors the manifest's, or reports a mismatch) */
  channel: Channel;
};

export type InstallResult = { ok: boolean; detail: string };

export type DesktopSettings = {
  snoozedUntil: Record<string, string>;
  autoCheck: boolean;
  channel: Channel;
};

export type DesktopApi = {
  getVersion(): Promise<string>;
  getInfo(): Promise<DesktopInfo>;
  checkForUpdates(): Promise<UpdateView>;
  startupUpdateState(): Promise<UpdateView | null>;
  snoozeUpdate(hours?: number): Promise<UpdateView>;
  installUpdate(): Promise<InstallResult>;
  openExternal(url: string): Promise<void>;
  restart(): Promise<void>;
  getSettings(): Promise<DesktopSettings>;
  setSnooze(version: string, untilIso: string | null): Promise<DesktopSettings>;
  /** subscribe to push updates from the main process; returns an unsubscribe function */
  onUpdateEvent(listener: (view: UpdateView) => void): () => void;
};

export const IPC = {
  getInfo: "kicklive:info",
  getVersion: "kicklive:version",
  checkForUpdates: "kicklive:updates:check",
  startupUpdateState: "kicklive:updates:state",
  snooze: "kicklive:updates:snooze",
  install: "kicklive:updates:install",
  openExternal: "kicklive:shell:open-external",
  restart: "kicklive:app:restart",
  getSettings: "kicklive:settings:get",
  setSnooze: "kicklive:settings:set-snooze",
  updatesChanged: "kicklive:updates:changed",
} as const;
