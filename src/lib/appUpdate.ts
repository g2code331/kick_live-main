import { Capacitor, registerPlugin } from '@capacitor/core';

interface KickLiveUpdaterPlugin {
  downloadAndInstall(options: { url: string }): Promise<{ started: boolean }>;
}

const KickLiveUpdater = registerPlugin<KickLiveUpdaterPlugin>('KickLiveUpdater');

export const APP_VERSION = '1.0.1';
export const UPDATE_MANIFEST_URL = 'https://kicklive1.vercel.app/app-version.json';

export interface UpdateManifest {
  version: string;
  releaseDate?: string;
  releaseNotes?: string[];
  androidApkUrl?: string;
}

export function isNewerVersion(remote: string, current = APP_VERSION): boolean {
  const toParts = (version: string) => version.replace(/^v/i, '').split('.').map(Number);
  const remoteParts = toParts(remote);
  const currentParts = toParts(current);
  for (let i = 0; i < Math.max(remoteParts.length, currentParts.length); i += 1) {
    const remotePart = remoteParts[i] || 0;
    const currentPart = currentParts[i] || 0;
    if (remotePart !== currentPart) return remotePart > currentPart;
  }
  return false;
}

export async function fetchUpdateManifest(): Promise<UpdateManifest | null> {
  try {
    const response = await fetch(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const manifest = await response.json() as UpdateManifest;
    return manifest.version ? manifest : null;
  } catch {
    return null;
  }
}

export async function installAndroidUpdate(apkUrl: string): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') return false;
  await KickLiveUpdater.downloadAndInstall({ url: apkUrl });
  return true;
}
