import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, User, Mail, Smartphone, Key, Bell, Save, LogOut, Eye, EyeOff, Camera, Calendar, Activity, Globe, CheckCircle, XCircle, LayoutDashboard } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import Header from '../components/Header';

const DASHBOARD_BY_ROLE: Record<string, { label: string; path: string }> = {
  admin: { label: 'Go to Admin Dashboard', path: '/admin' },
  media: { label: 'Go to Media Dashboard', path: '/media-portal' },
  team_manager: { label: 'Go to Team Dashboard', path: '/team-owner' },
};

export default function ProfilePage() {
  const navigate = useNavigate();
  const { user, profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<'account' | 'security' | 'notifications'>('account');
  const [username, setUsername] = useState(profile?.username || '');
  const [phone, setPhone] = useState(profile?.phone || '');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Password change
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);

  const showMsg = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ username, phone })
        .eq('id', user.id);
      if (error) throw error;
      showMsg('success', 'Profile updated successfully!');
    } catch (err: any) {
      showMsg('error', err.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (!newPw || !confirmPw) return showMsg('error', 'Please fill in all password fields');
    if (newPw !== confirmPw) return showMsg('error', 'New passwords do not match');
    if (newPw.length < 6) return showMsg('error', 'Password must be at least 6 characters');
    setPwSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw });
      if (error) throw error;
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      showMsg('success', 'Password changed successfully!');
    } catch (err: any) {
      showMsg('error', err.message || 'Failed to change password');
    } finally {
      setPwSaving(false);
    }
  };

  const dashboard = profile?.role ? DASHBOARD_BY_ROLE[profile.role] : null;

  if (!user) {
    return (
      <div className="relative min-h-screen">
        <Header />
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="glass rounded-[2rem] p-12 text-center border border-white/10">
            <User size={48} className="mx-auto mb-4 text-white/20" />
            <h2 className="text-2xl font-black uppercase mb-2">Not Logged In</h2>
            <p className="text-white/40 mb-6">Sign in to view your profile.</p>
            <button onClick={() => navigate('/login')} className="gradient-green text-black px-8 py-3 rounded-xl font-black uppercase text-sm tracking-widest">
              Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen">
      <Header />

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${
          toast.type === 'success' ? 'bg-brand-green/20 border-brand-green/40' : 'bg-red-500/20 border-red-500/40'
        }`}>
          {toast.type === 'success' ? <CheckCircle size={18} className="text-brand-green shrink-0" /> : <XCircle size={18} className="text-red-400 shrink-0" />}
          <span>{toast.msg}</span>
        </div>
      )}

      <div className="container mx-auto px-4 py-12 relative z-10 max-w-5xl">
        {/* Back */}
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-white/40 hover:text-white transition-colors mb-8 font-bold text-sm uppercase tracking-widest">
          <ArrowLeft size={18} /> Back
        </button>

        <div className="glass rounded-[3rem] border border-white/10 overflow-hidden shadow-2xl">
          {dashboard && (
            <div className="px-6 sm:px-8 pt-6">
              <button
                onClick={() => navigate(dashboard.path)}
                className="w-full flex items-center justify-center gap-2 gradient-green text-black px-6 py-3.5 rounded-2xl font-black uppercase text-sm tracking-widest hover:scale-[1.02] transition-transform shadow-lg shadow-brand-green/20"
              >
                <LayoutDashboard size={18} /> {dashboard.label}
              </button>
            </div>
          )}
          <div className="flex flex-col md:flex-row min-h-[560px]">
            {/* Sidebar */}
            <aside className="md:w-64 bg-white/5 border-b md:border-b-0 md:border-r border-white/10 p-8 flex flex-col">
              <div className="flex flex-col items-center text-center mb-8">
                <div className="relative group mb-4">
                  <div className="w-20 h-20 rounded-full bg-brand-green/20 border-2 border-brand-green/30 flex items-center justify-center text-3xl font-black text-brand-green">
                    {profile?.username?.[0]?.toUpperCase() || 'U'}
                  </div>
                  <div className="absolute bottom-0 right-0 w-7 h-7 bg-brand-green rounded-full flex items-center justify-center text-black border-2 border-[#0B0E13] opacity-0 group-hover:opacity-100 transition-all cursor-pointer">
                    <Camera size={13} />
                  </div>
                </div>
                <h3 className="font-black uppercase italic tracking-tighter text-lg">{profile?.username}</h3>
                <p className="text-[10px] text-white/30 uppercase tracking-[0.2em] font-bold mt-1">{profile?.role?.replace('_', ' ')}</p>
                <p className="text-[10px] text-white/20 mt-1 break-all">{profile?.email}</p>
              </div>

              <nav className="flex-1 space-y-2">
                {[
                  { id: 'account', label: 'Account Info', icon: <User size={16} /> },
                  { id: 'security', label: 'Security', icon: <Key size={16} /> },
                  { id: 'notifications', label: 'Notifications', icon: <Bell size={16} /> },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-bold ${
                      activeTab === tab.id ? 'bg-brand-green/10 text-brand-green' : 'text-white/40 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {tab.icon} {tab.label}
                  </button>
                ))}
              </nav>

              <button
                onClick={async () => { await signOut(); navigate('/'); }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-brand-red hover:bg-brand-red/10 transition-all text-sm font-bold mt-4"
              >
                <LogOut size={16} /> Sign Out
              </button>
            </aside>

            {/* Main */}
            <main className="flex-1 p-8 md:p-10 overflow-y-auto">
              {activeTab === 'account' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                  <div>
                    <h2 className="text-3xl font-black italic uppercase tracking-tighter mb-1">Account <span className="text-brand-green">Settings</span></h2>
                    <p className="text-xs text-white/30 uppercase tracking-widest font-bold">Manage your personal details</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                        <User size={11} /> Username
                      </label>
                      <input
                        type="text"
                        value={username}
                        onChange={e => setUsername(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                        <Smartphone size={11} /> Phone
                      </label>
                      <input
                        type="tel"
                        value={phone}
                        onChange={e => setPhone(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-white/40 flex items-center gap-2">
                      <Mail size={11} /> Email Address
                    </label>
                    <input
                      type="email"
                      value={profile?.email || ''}
                      disabled
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white/30 cursor-not-allowed"
                    />
                    <p className="text-[10px] text-white/20">Email cannot be changed. Contact support if needed.</p>
                  </div>

                  <div className="pt-4 border-t border-white/5">
                    <button
                      onClick={handleSaveProfile}
                      disabled={saving}
                      className="gradient-green text-black px-8 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                    >
                      <Save size={16} /> {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'security' && (
                <div className="space-y-8 animate-in fade-in duration-300">
                  <div>
                    <h2 className="text-3xl font-black italic uppercase tracking-tighter mb-1">Security &amp; <span className="text-brand-green">Privacy</span></h2>
                    <p className="text-xs text-white/30 uppercase tracking-widest font-bold">Keep your account safe</p>
                  </div>

                  <div className="space-y-4">
                    <h3 className="text-xs font-black uppercase tracking-widest text-white/40">Change Password</h3>
                    <div className="relative">
                      <input
                        type={showPw ? 'text' : 'password'}
                        placeholder="Current Password"
                        value={currentPw}
                        onChange={e => setCurrentPw(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 pr-12 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
                      />
                      <button onClick={() => setShowPw(!showPw)} className="absolute right-4 top-1/2 -translate-y-1/2 text-white/30 hover:text-white transition-colors">
                        {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <input
                      type={showPw ? 'text' : 'password'}
                      placeholder="New Password (min 6 chars)"
                      value={newPw}
                      onChange={e => setNewPw(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
                    />
                    <input
                      type={showPw ? 'text' : 'password'}
                      placeholder="Confirm New Password"
                      value={confirmPw}
                      onChange={e => setConfirmPw(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
                    />
                    <button
                      onClick={handleChangePassword}
                      disabled={pwSaving}
                      className="gradient-green text-black px-8 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 hover:scale-105 transition-transform disabled:opacity-50 disabled:scale-100"
                    >
                      <Key size={16} /> {pwSaving ? 'Changing...' : 'Change Password'}
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'notifications' && (
                <div className="space-y-6 animate-in fade-in duration-300">
                  <div>
                    <h2 className="text-3xl font-black italic uppercase tracking-tighter mb-1">Notification <span className="text-brand-green">Prefs</span></h2>
                    <p className="text-xs text-white/30 uppercase tracking-widest font-bold">Choose what you want to hear about</p>
                  </div>
                  {[
                    { label: 'Match Results', desc: 'Final scores when matches end', icon: <Calendar size={16} />, on: true },
                    { label: 'Live Score Updates', desc: 'Goal alerts during live matches', icon: <Activity size={16} />, on: true },
                    { label: 'News &amp; Media', desc: 'Weekly highlights and articles', icon: <Globe size={16} />, on: false },
                  ].map((pref, i) => (
                    <div key={i} className="flex items-center justify-between p-4 rounded-2xl bg-white/[0.03] border border-white/5">
                      <div className="flex items-center gap-4">
                        <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center text-white/40">{pref.icon}</div>
                        <div>
                          <p className="text-sm font-bold" dangerouslySetInnerHTML={{ __html: pref.label }} />
                          <p className="text-[10px] text-white/30 font-bold uppercase">{pref.desc}</p>
                        </div>
                      </div>
                      <div className={`w-11 h-6 rounded-full relative transition-colors ${pref.on ? 'bg-brand-green/30' : 'bg-white/10'}`}>
                        <div className={`absolute top-1 w-4 h-4 rounded-full shadow transition-all ${pref.on ? 'right-1 bg-brand-green shadow-[0_0_8px_rgba(57,255,20,0.5)]' : 'left-1 bg-white/30'}`} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}