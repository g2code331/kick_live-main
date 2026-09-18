import { useEffect, useState } from 'react';
import {
  Settings, Database, Shield, Zap, Globe, Cpu, Smartphone, Moon, Sun, Lock, Trophy,
  Loader2, Bell, MessageSquare, KeyRound, ScrollText, LayoutGrid, Sparkles, CheckCircle2, RotateCcw, Save, Clock,
} from 'lucide-react';
import AdminPageShell from './AdminPageShell';
import SeasonManagement from './SeasonManagement';
import type { AdminSettings } from '../../../lib/admin-settings';
import { DEFAULT_ADMIN_SETTINGS, loadAdminSettings, saveAdminSettings } from '../../../lib/admin-settings';

interface AppSettingsDashboardProps {
  /** Return to the tab the user came from (replaces the old modal onClose). */
  onBack: () => void;
}

type ToggleKey = {
  [K in keyof AdminSettings]: AdminSettings[K] extends boolean ? K : never;
}[keyof AdminSettings];

type ToggleItem = { id: ToggleKey; label: string; icon: React.ReactNode; desc: string };

const CORE_TOGGLES: ToggleItem[] = [
  { id: 'liveStreaming', label: 'Live Stats Broadcast', icon: <Zap size={20} />, desc: 'Enable real-time match data syncing' },
  { id: 'predictions', label: 'Fan Predictions', icon: <Trophy size={20} />, desc: 'Allow users to predict match outcomes' },
  { id: 'userComments', label: 'Community Chat', icon: <MessageSquare size={20} />, desc: 'Enable public match commentary' },
  { id: 'notifications', label: 'Push Notifications', icon: <Bell size={20} />, desc: 'Send match and news alerts to devices' },
  { id: 'registrationOpen', label: 'New Registrations', icon: <Smartphone size={20} />, desc: 'Allow new users to create accounts' },
];

const SECURITY_TOGGLES: ToggleItem[] = [
  { id: 'maintenanceMode', label: 'Maintenance Mode', icon: <Lock size={20} />, desc: 'Lock the app for emergency updates' },
  { id: 'dataAutoSync', label: 'Cloud Auto-Backup', icon: <Database size={20} />, desc: 'Real-time database mirroring' },
  { id: 'twoFactorRequired', label: 'Require 2FA (staff)', icon: <KeyRound size={20} />, desc: 'Force two-factor for admin and staff' },
  { id: 'auditLogging', label: 'Audit Logging', icon: <ScrollText size={20} />, desc: 'Record every privileged action' },
];

const PRESENTATION_TOGGLES: ToggleItem[] = [
  { id: 'compactMode', label: 'Compact Layout', icon: <LayoutGrid size={20} />, desc: 'Denser spacing across the admin' },
  { id: 'showScoreAnimations', label: 'Score Animations', icon: <Sparkles size={20} />, desc: 'Animate live score changes' },
  { id: 'autoPublishResults', label: 'Auto-Publish Results', icon: <Globe size={20} />, desc: 'Publish full-time results automatically' },
];

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`w-12 h-6 rounded-full relative transition-all duration-300 shrink-0 ${on ? 'bg-brand-green' : 'bg-white/10'}`}
    >
      <div className={`absolute top-1 w-4 h-4 rounded-full bg-black transition-all duration-300 ${on ? 'right-1' : 'left-1'}`} />
    </button>
  );
}

export default function AppSettingsDashboard({ onBack }: AppSettingsDashboardProps) {
  const [settings, setSettings] = useState<AdminSettings>(() => loadAdminSettings());
  const [saved, setSaved] = useState<AdminSettings>(settings);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Keep the "saved" baseline in step if another tab changes it while this page is open.
  useEffect(() => {
    setSaved(loadAdminSettings());
  }, []);

  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);

  const toggle = (key: ToggleKey) => setSettings((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleApply = () => {
    setIsSaving(true);
    // A short delay reads as "applied" without blocking; the write itself is synchronous.
    setTimeout(() => {
      saveAdminSettings(settings);
      setSaved(settings);
      setIsSaving(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2200);
    }, 500);
  };

  const handleReset = () => {
    setSettings({ ...DEFAULT_ADMIN_SETTINGS });
  };

  const renderGroup = (heading: string, tone: string, icon: React.ReactNode, items: ToggleItem[]) => (
    <div>
      <h3 className={`text-xs font-black uppercase tracking-[0.2em] ${tone} mb-5 flex items-center gap-2`}>
        {icon} {heading}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">
        {items.map((item) => (
          <div key={item.id} className="p-5 lg:p-6 glass-light rounded-3xl border border-white/5 flex items-center justify-between gap-4 hover:bg-white/5 transition-all group">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/40 group-hover:text-brand-green transition-colors shrink-0">
                {item.icon}
              </div>
              <div className="min-w-0">
                <p className="font-black uppercase italic text-sm tracking-tight truncate">{item.label}</p>
                <p className="text-[10px] text-white/30">{item.desc}</p>
              </div>
            </div>
            <Toggle on={settings[item.id]} onClick={() => toggle(item.id)} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <AdminPageShell
      title={<>System <span className="text-[#39FF14]">Settings</span></>}
      subtitle="Global application configuration"
      icon={<Settings size={22} />}
      onBack={onBack}
      backLabel="Overview"
      actions={
        <>
          {savedFlash && (
            <span className="hidden sm:flex items-center gap-1.5 text-brand-green text-[10px] font-black uppercase tracking-widest">
              <CheckCircle2 size={14} /> Saved
            </span>
          )}
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-black uppercase tracking-widest transition-colors"
          >
            <RotateCcw size={14} /> <span className="hidden sm:inline">Reset</span>
          </button>
          <button
            onClick={handleApply}
            disabled={isSaving || !dirty}
            className="gradient-green text-black px-4 lg:px-6 py-2 rounded-xl font-black uppercase text-[10px] lg:text-xs tracking-widest flex items-center gap-2 disabled:opacity-40 transition-opacity"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {dirty ? 'Apply' : 'Saved'}
          </button>
        </>
      }
    >
      <div className="space-y-10 lg:space-y-12 pb-16">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 lg:gap-12">
          {/* Toggle groups */}
          <div className="xl:col-span-8 space-y-10 lg:space-y-12">
            {renderGroup('Core Functionality', 'text-brand-green', <Cpu size={14} />, CORE_TOGGLES)}
            {renderGroup('Security & Database', 'text-brand-red', <Shield size={14} />, SECURITY_TOGGLES)}
            {renderGroup('Presentation & Operations', 'text-brand-blue', <Sparkles size={14} />, PRESENTATION_TOGGLES)}

            {/* Numeric / text settings */}
            <div>
              <h3 className="text-xs font-black uppercase tracking-[0.2em] text-brand-orange mb-5 flex items-center gap-2">
                <Clock size={14} /> Match Defaults
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">
                <div className="p-5 lg:p-6 glass-light rounded-3xl border border-white/5">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest block mb-2">Default Match Duration (min)</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={settings.defaultMatchDuration}
                    onChange={(e) => setSettings((p) => ({ ...p, defaultMatchDuration: Number(e.target.value) || 0 }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
                <div className="p-5 lg:p-6 glass-light rounded-3xl border border-white/5">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest block mb-2">Current Season Label</label>
                  <input
                    type="text"
                    value={settings.seasonLabel}
                    onChange={(e) => setSettings((p) => ({ ...p, seasonLabel: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="xl:col-span-4 space-y-6">
            <div className="glass rounded-[2rem] p-6 lg:p-8 border border-white/5">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-5">API Status</h4>
              <div className="space-y-3">
                {[
                  { name: 'Supabase', status: 'ONLINE' },
                  { name: 'Cloudflare Edge', status: 'STABLE' },
                  { name: 'Realtime Sync', status: settings.dataAutoSync ? 'ACTIVE' : 'PAUSED' },
                ].map((row) => (
                  <div key={row.name} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                    <span className="text-xs font-bold text-white/60">{row.name}</span>
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-brand-green animate-pulse" />
                      <span className="text-[8px] font-black text-brand-green">{row.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass rounded-[2rem] p-6 lg:p-8 border border-white/5">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-5">Visual Theme</h4>
              <div className="flex gap-2">
                <button
                  onClick={() => setSettings((p) => ({ ...p, theme: 'light' }))}
                  className={`flex-1 p-3 rounded-xl font-black text-[10px] uppercase flex items-center justify-center gap-2 transition-colors ${settings.theme === 'light' ? 'bg-brand-green text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}
                >
                  <Sun size={14} /> Light
                </button>
                <button
                  onClick={() => setSettings((p) => ({ ...p, theme: 'dark' }))}
                  className={`flex-1 p-3 rounded-xl font-black text-[10px] uppercase flex items-center justify-center gap-2 transition-colors ${settings.theme === 'dark' ? 'bg-brand-green text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}
                >
                  <Moon size={14} /> Dark
                </button>
              </div>
              <p className="text-[10px] text-white/20 mt-3">Dark is the shipped theme; light is a preview.</p>
            </div>

            <div className="glass rounded-[2rem] p-6 lg:p-8 border border-white/5">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-2">Build</h4>
              <p className="text-[10px] font-black text-white/40 uppercase tracking-widest">Version 1.0.0 • stable</p>
            </div>
          </div>
        </div>

        {/* Season management lives inside settings, inline (no overlay) */}
        <div className="pt-4 border-t border-white/10">
          <SeasonManagement />
        </div>
      </div>
    </AdminPageShell>
  );
}
