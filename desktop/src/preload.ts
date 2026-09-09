/**
 * Preload: the *only* bridge between the renderer and the shell.
 *
 * Context isolation on, node integration off, sandbox on — so this file may expose nothing but
 * the allow-listed functions below. Each one is a thin invoke() wrapper: no logic, no fs, no
 * child processes here. Anything smarter belongs in main.
 */

import { contextBridge, ipcRenderer } from "electron";

import { IPC, type DesktopApi, type DesktopInfo, type DesktopSettings, type InstallResult, type UpdateView } from "./api.ts";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const api: DesktopApi = {
  getVersion: () => ipcRenderer.invoke(IPC.getVersion) as Promise<string>,
  getInfo: () => ipcRenderer.invoke(IPC.getInfo) as Promise<DesktopInfo>,
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates) as Promise<UpdateView>,
  startupUpdateState: () => ipcRenderer.invoke(IPC.startupUpdateState) as Promise<UpdateView | null>,
  snoozeUpdate: (hours?: number) => ipcRenderer.invoke(IPC.snooze, hours) as Promise<UpdateView>,
  installUpdate: () => ipcRenderer.invoke(IPC.install) as Promise<InstallResult>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  restart: () => ipcRenderer.invoke(IPC.restart) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<DesktopSettings>,
  setSnooze: (version: string, untilIso: string | null) => ipcRenderer.invoke(IPC.setSnooze, version, untilIso) as Promise<DesktopSettings>,
  onUpdateEvent: (listener: (view: UpdateView) => void) => {
    const handler = (_event: unknown, view: UpdateView): void => listener(view);
    ipcRenderer.on(IPC.updatesChanged, handler as (e: unknown, v: UpdateView) => void);
    return () => {
      ipcRenderer.removeListener(IPC.updatesChanged, handler as (e: unknown, v: UpdateView) => void);
    };
  },
};

contextBridge.exposeInMainWorld("kicklive", api);
contextBridge.exposeInMainWorld("kickliveShell", {
  shell: "desktop" as const,
  version: arg("kicklive-version") ?? "0.0.0",
  channel: arg("kicklive-channel") ?? "stable",
});
