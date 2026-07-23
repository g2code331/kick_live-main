import { useEffect, useState } from 'react';
import { Download, X, RefreshCw } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { fetchUpdateManifest, installAndroidUpdate, isNewerVersion, APP_VERSION, UpdateManifest } from '../lib/appUpdate';

export default function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetchUpdateManifest().then(manifest => {
      if (active && manifest && isNewerVersion(manifest.version)) setUpdate(manifest);
    });
    return () => { active = false; };
  }, []);

  if (!update) return null;

  const install = async () => {
    setBusy(true); setError('');
    try {
      if (Capacitor.getPlatform() === 'android' && update.androidApkUrl) {
        const installed = await installAndroidUpdate(update.androidApkUrl);
        if (!installed) throw new Error('Android updater is not available in this build.');
        return;
      }
      window.location.reload();
    } catch (err: any) {
      setError(err?.message || 'Update could not start.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[500] mx-auto max-w-xl glass rounded-2xl border border-brand-green/40 p-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-brand-green/15 p-2 text-brand-green"><Download size={20} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black uppercase">KickLive update available</p>
          <p className="mt-1 text-xs text-white/50">Version {update.version} is ready. You are using {APP_VERSION}.</p>
          {update.releaseNotes?.length ? <ul className="mt-2 list-disc pl-4 text-xs text-white/60">{update.releaseNotes.slice(0, 3).map(note => <li key={note}>{note}</li>)}</ul> : null}
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <button onClick={install} disabled={busy} className="mt-3 flex items-center gap-2 rounded-xl bg-brand-green px-4 py-2 text-xs font-black uppercase text-black disabled:opacity-50">
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />} {busy ? 'Preparing…' : 'Install update'}
          </button>
        </div>
        <button onClick={() => setUpdate(null)} aria-label="Dismiss update" className="p-1 text-white/40 hover:text-white"><X size={16} /></button>
      </div>
    </div>
  );
}
