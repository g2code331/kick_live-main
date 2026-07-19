import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, Trophy, Calendar, BarChart2, Settings, LogOut, Plus, Clock,
  Activity, ChevronRight, Save, Edit2, Trash2, Shield, AlertCircle,
  CheckCircle2, XCircle, Home, X, Star, Loader2, ArrowLeft, User,
  Image, Newspaper, Layout, Target, TrendingUp, RefreshCw, Hash, Globe,
  ChevronDown, BookOpen, Camera, Film, Eye, EyeOff, Zap
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────
type PortalTab = 'dashboard' | 'profile' | 'players' | 'matches' | 'fixtures' | 'table' | 'stats' | 'lineup' | 'gallery' | 'news' | 'settings';
type TeamStatus = 'pending' | 'active' | 'rejected' | null;

// ─── Toast ────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const show = (type: 'success' | 'error' | 'info', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4500);
  };
  return { toast, success: (m: string) => show('success', m), error: (m: string) => show('error', m), info: (m: string) => show('info', m) };
}
function Toast({ toast }: { toast: any }) {
  if (!toast) return null;
  const c: Record<string, string> = {
    success: 'bg-brand-green/20 border-brand-green/40 text-brand-green',
    error: 'bg-red-500/20 border-red-500/40 text-red-400',
    info: 'bg-blue-500/20 border-blue-500/40 text-blue-400',
  };
  const ic: Record<string, React.ReactNode> = {
    success: <CheckCircle2 size={18} className="shrink-0" />,
    error: <XCircle size={18} className="shrink-0" />,
    info: <AlertCircle size={18} className="shrink-0" />,
  };
  return (
    <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${c[toast.type]}`}>
      {ic[toast.type]}<span className="text-white">{toast.msg}</span>
    </div>
  );
}
function Spinner() {
  return <div className="flex justify-center py-16"><Loader2 size={32} className="text-brand-green animate-spin" /></div>;
}

// ─── Input helper ─────────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-black uppercase text-white/40 mb-2">{label}</label>
      {children}
    </div>
  );
}
const inp = "w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-brand-green/50 placeholder:text-white/20";

// ─── Main Portal ──────────────────────────────────────────────────────────────
export default function TeamOwnerPortal() {
  const navigate = useNavigate();
  const { user, profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<PortalTab>('dashboard');
  const [team, setTeam] = useState<any>(null);
  const [teamStatus, setTeamStatus] = useState<TeamStatus>(null);
  const [loading, setLoading] = useState(true);
  const { toast, success, error, info } = useToast();
  const navRef = useRef<HTMLDivElement>(null);

  const loadTeam = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const { data, error: err } = await supabase.from('teams').select('*').eq('owner_id', profile.id).maybeSingle();
      if (err) { console.warn('[TeamOwnerPortal]', err.message); setTeam(null); setTeamStatus(null); }
      else if (data) { setTeam(data); setTeamStatus((data.status as TeamStatus) || 'active'); }
      else { setTeam(null); setTeamStatus(null); }
    } catch (e) { setTeam(null); setTeamStatus(null); }
    finally { setLoading(false); }
  }, [profile?.id]);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const tabs: { id: PortalTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <Home size={14} /> },
    { id: 'profile', label: 'Profile', icon: <User size={14} /> },
    { id: 'players', label: 'Players', icon: <Users size={14} /> },
    { id: 'matches', label: 'Matches', icon: <Activity size={14} /> },
    { id: 'fixtures', label: 'Fixtures', icon: <Calendar size={14} /> },
    { id: 'table', label: 'Table', icon: <BarChart2 size={14} /> },
    { id: 'stats', label: 'Stats', icon: <TrendingUp size={14} /> },
    { id: 'lineup', label: 'Lineup', icon: <Layout size={14} /> },
    { id: 'gallery', label: 'Gallery', icon: <Camera size={14} /> },
    { id: 'news', label: 'News', icon: <Newspaper size={14} /> },
    { id: 'settings', label: 'Settings', icon: <Settings size={14} /> },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0B0E13] flex items-center justify-center">
        <div className="text-center"><Loader2 size={48} className="text-brand-green animate-spin mx-auto mb-4" />
          <p className="text-white/40 font-bold uppercase text-sm tracking-widest">Loading your club…</p>
        </div>
      </div>
    );
  }

  if (!team) return <div className="min-h-screen bg-[#0B0E13] flex items-center justify-center p-4"><Toast toast={toast} /><CreateTeamScreen profile={profile} onCreated={(t: any) => { setTeam(t); setTeamStatus('pending'); success('Registration submitted! Awaiting admin approval.'); }} onError={error} /></div>;
  if (teamStatus === 'pending') return <div className="min-h-screen bg-[#0B0E13]"><Toast toast={toast} /><PendingScreen team={team} onSignOut={async () => { await signOut(); navigate('/'); }} onRefresh={loadTeam} /></div>;
  if (teamStatus === 'rejected') return <div className="min-h-screen bg-[#0B0E13] flex items-center justify-center p-4"><Toast toast={toast} /><RejectedScreen team={team} onSignOut={async () => { await signOut(); navigate('/'); }} onReapply={() => { setTeam(null); setTeamStatus(null); }} /></div>;

  return (
    <div className="min-h-screen bg-[#0B0E13] flex flex-col">
      <Toast toast={toast} />

      {/* ── Top header ──────────────────────────────────────────────────────── */}
      <header className="glass border-b border-white/10 sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-black shrink-0"
              style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` }}
            >
              {team.short_name?.[0] || 'T'}
            </div>
            <div>
              <p className="text-[8px] font-black uppercase tracking-widest text-white/30">Team Owner</p>
              <h1 className="font-black uppercase text-sm">{team.name}</h1>
            </div>
            <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest bg-brand-green/20 text-brand-green">✓ Active</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(`/team/${team.id}`)} className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 text-white/40 hover:bg-white/10 font-bold text-xs">
              <Eye size={13} /> Public Page
            </button>
            <button onClick={() => navigate('/')} className="p-2 rounded-xl bg-white/5 text-white/40 hover:bg-white/10">
              <ArrowLeft size={16} />
            </button>
            <button onClick={async () => { await signOut(); navigate('/'); }} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-red-400/60 hover:text-red-400 hover:bg-red-400/10 font-bold text-xs">
              <LogOut size={14} /> Sign Out
            </button>
          </div>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────────────── */}
        <div ref={navRef} className="flex overflow-x-auto no-scrollbar gap-1 px-4 sm:px-6 pb-3">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[11px] uppercase tracking-widest whitespace-nowrap transition-all shrink-0 ${
                activeTab === tab.id
                  ? 'bg-brand-green text-black shadow-lg shadow-brand-green/20'
                  : 'text-white/70 hover:text-white hover:bg-white/10'
              }`}
            >
              {tab.icon}{tab.label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 p-4 sm:p-6 pb-24 max-w-7xl mx-auto w-full">
        {activeTab === 'dashboard' && <DashboardTab team={team} setTab={setActiveTab} />}
        {activeTab === 'profile' && <ProfileTab team={team} />}
        {activeTab === 'players' && <PlayersTab team={team} onToast={{ success, error, info }} />}
        {activeTab === 'matches' && <MatchesTab team={team} />}
        {activeTab === 'fixtures' && <FixturesTab team={team} />}
        {activeTab === 'table' && <TableTab team={team} />}
        {activeTab === 'stats' && <StatsTab team={team} />}
        {activeTab === 'lineup' && <LineupTab team={team} onToast={{ success, error }} />}
        {activeTab === 'gallery' && <GalleryTab team={team} onToast={{ success, error }} />}
        {activeTab === 'news' && <NewsTab team={team} profile={profile} onToast={{ success, error }} />}
        {activeTab === 'settings' && <SettingsTab team={team} onUpdate={(t: any) => { setTeam(t); success('Club settings saved — changes are live for fans & admin.'); }} onError={error} />}
      </main>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTRATION SCREENS
// ═══════════════════════════════════════════════════════════════════════════════

function CreateTeamScreen({ profile, onCreated, onError }: any) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [validationMsg, setValidationMsg] = useState('');
  const [form, setForm] = useState({ name: '', short_name: '', city: '', venue: '', coach: '', primary_color: '#39FF14', secondary_color: '#000000' });
  const f = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.short_name) { setValidationMsg('Club name and short name are required.'); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase.from('teams').insert([{ ...form, owner_id: profile?.id, status: 'pending' }]).select().single();
      if (error) throw error;
      onCreated(data);
    } catch (err: any) { onError(err.message || 'Failed to create team. Please run the SQL migrations first.'); }
    finally { setLoading(false); }
  };

  return (
    <div className="w-full max-w-2xl">
      <div className="text-center mb-8">
        <div className="w-20 h-20 rounded-3xl bg-brand-green/20 flex items-center justify-center mx-auto mb-4"><Shield size={36} className="text-brand-green" /></div>
        <h1 className="text-3xl font-black uppercase tracking-tight mb-2">Register Your Club</h1>
        <p className="text-white/40 text-sm">Complete both steps. An admin will approve before you get full access.</p>
      </div>
      <div className="flex gap-3 mb-8">
        {[1, 2].map(s => <div key={s} className={`flex-1 h-1.5 rounded-full transition-all ${s <= step ? 'bg-brand-green' : 'bg-white/10'}`} />)}
      </div>
      {validationMsg && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
          <AlertCircle size={16} />{validationMsg}
        </div>
      )}
      <div className="glass rounded-3xl border border-white/10 p-8">
        <form onSubmit={handleSubmit} className="space-y-5">
          {step === 1 && (
            <>
              <h2 className="font-black uppercase text-brand-green mb-4">Step 1 — Club Identity</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2"><Field label="Club Name *"><input required value={form.name} onChange={e => f('name', e.target.value)} placeholder="e.g. Arsenal FC" className={inp} /></Field></div>
                <Field label="Short Name * (2–5)"><input required maxLength={5} minLength={2} value={form.short_name} onChange={e => f('short_name', e.target.value.toUpperCase())} placeholder="ARS" className={`${inp} tracking-widest font-bold`} /></Field>
                <Field label="City / Town"><input value={form.city} onChange={e => f('city', e.target.value)} placeholder="e.g. London" className={inp} /></Field>
                <Field label="Stadium"><input value={form.venue} onChange={e => f('venue', e.target.value)} placeholder="e.g. Emirates Stadium" className={inp} /></Field>
                <Field label="Head Coach"><input value={form.coach} onChange={e => f('coach', e.target.value)} placeholder="e.g. Mikel Arteta" className={inp} /></Field>
              </div>
              <button type="button" onClick={() => { if (!form.name || !form.short_name) { setValidationMsg('Club name and short name are required.'); return; } setValidationMsg(''); setStep(2); }}
                className="w-full py-4 rounded-2xl gradient-green text-black font-black uppercase text-sm tracking-widest mt-4">
                Next: Club Colors →
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <h2 className="font-black uppercase text-brand-green mb-4">Step 2 — Club Colors</h2>
              <div className="glass rounded-2xl p-5 border border-white/5 flex items-center gap-4 mb-4">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black border-2 border-white/10"
                  style={{ background: `linear-gradient(135deg, ${form.primary_color}, ${form.secondary_color})` }}>
                  {form.short_name?.[0] || 'T'}
                </div>
                <div><p className="font-black uppercase">{form.name}</p><p className="text-white/40 text-sm">{form.city} {form.venue ? `• ${form.venue}` : ''}</p></div>
              </div>
              <div className="grid grid-cols-2 gap-6">
                <div><Field label="Primary Color (Kit)"><div className="flex items-center gap-3"><input type="color" value={form.primary_color} onChange={e => f('primary_color', e.target.value)} className="w-14 h-14 rounded-xl cursor-pointer bg-transparent border-0" /><span className="font-mono text-sm text-white/40">{form.primary_color}</span></div></Field></div>
                <div><Field label="Secondary Color (Kit)"><div className="flex items-center gap-3"><input type="color" value={form.secondary_color} onChange={e => f('secondary_color', e.target.value)} className="w-14 h-14 rounded-xl cursor-pointer bg-transparent border-0" /><span className="font-mono text-sm text-white/40">{form.secondary_color}</span></div></Field></div>
              </div>
              <div className="flex gap-3 mt-4">
                <button type="button" onClick={() => setStep(1)} className="flex-1 py-4 rounded-2xl bg-white/5 text-white/60 font-black uppercase text-sm">← Back</button>
                <button type="submit" disabled={loading} className="flex-1 py-4 rounded-2xl gradient-green text-black font-black uppercase text-sm tracking-widest disabled:opacity-50">
                  {loading ? 'Submitting…' : 'Submit for Approval →'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}

function PendingScreen({ team, onSignOut, onRefresh }: any) {
  const [checking, setChecking] = useState(false);
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg text-center">
        <div className="w-24 h-24 rounded-3xl bg-yellow-500/20 flex items-center justify-center mx-auto mb-6 animate-pulse"><Clock size={44} className="text-yellow-400" /></div>
        <h1 className="text-3xl font-black uppercase mb-3">Awaiting Admin Approval</h1>
        <p className="text-white/40 mb-8">Your registration for <span className="text-white font-bold">"{team.name}"</span> is pending review. You'll get full access once approved.</p>
        <div className="glass rounded-3xl border border-yellow-500/20 p-6 mb-6 text-left">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-black" style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` }}>{team.short_name?.[0]}</div>
            <div><h3 className="font-black uppercase">{team.name}</h3><p className="text-white/40 text-sm">{team.short_name}{team.city ? ` • ${team.city}` : ''}</p></div>
            <span className="ml-auto px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-yellow-500/20 text-yellow-400">Pending</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={async () => { setChecking(true); await onRefresh(); setChecking(false); }} disabled={checking}
            className="flex-1 py-3 rounded-2xl gradient-green text-black font-black uppercase text-xs tracking-widest disabled:opacity-50 flex items-center justify-center gap-2">
            {checking ? <Loader2 size={16} className="animate-spin" /> : <Activity size={16} />} Check Status
          </button>
          <button onClick={onSignOut} className="flex-1 py-3 rounded-2xl bg-white/5 text-white/50 font-black uppercase text-xs hover:bg-white/10">Sign Out</button>
        </div>
      </div>
    </div>
  );
}

function RejectedScreen({ team, onSignOut, onReapply }: any) {
  return (
    <div className="w-full max-w-lg text-center">
      <div className="w-24 h-24 rounded-3xl bg-red-500/20 flex items-center justify-center mx-auto mb-6"><XCircle size={44} className="text-red-400" /></div>
      <h1 className="text-3xl font-black uppercase mb-3">Registration Rejected</h1>
      <p className="text-white/40 mb-6">Your team <span className="text-white font-bold">"{team.name}"</span> was not approved. You can re-apply with updated details.</p>
      <div className="flex gap-3">
        <button onClick={onReapply} className="flex-1 py-3 rounded-2xl gradient-green text-black font-black uppercase text-xs">Re-Apply</button>
        <button onClick={onSignOut} className="flex-1 py-3 rounded-2xl bg-white/5 text-white/50 font-black uppercase text-xs">Sign Out</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1: DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
function DashboardTab({ team, setTab }: { team: any; setTab: (t: PortalTab) => void }) {
  const [stats, setStats] = useState({ pts: 0, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, pos: '-' });
  const [recent, setRecent] = useState<any[]>([]);
  const [next, setNext] = useState<any | null>(null);
  const [topScorers, setTopScorers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team?.id) return;
    async function load() {
      const [matchRes, playerRes] = await Promise.all([
        supabase.from('matches')
          .select('id, home_team_id, away_team_id, home_score, away_score, status, start_time, minute, homeTeam:teams!home_team_id(name,short_name,primary_color), awayTeam:teams!away_team_id(name,short_name,primary_color), competitions(name)')
          .or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`)
          .order('start_time', { ascending: false }),
        supabase.from('players').select('id,name,position,goals,assists,number').eq('team_id', team.id).order('goals', { ascending: false }).limit(5),
      ]);

      const matches = matchRes.data || [];
      setTopScorers(playerRes.data || []);

      const done = matches.filter((m: any) => ['full_time', 'completed', 'finished'].includes(m.status));
      setRecent(done.slice(0, 5));

      const upcoming = matches.filter((m: any) => !['full_time', 'completed', 'finished'].includes(m.status) && !['first_half', 'second_half', 'extra_time', 'half_time'].includes(m.status))
        .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
      setNext(upcoming[0] || null);

      let pts = 0, played = 0, won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
      done.forEach((m: any) => {
        const isH = m.home_team_id === team.id;
        const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
        const og = isH ? (m.away_score || 0) : (m.home_score || 0);
        played++; gf += tg; ga += og;
        if (tg > og) { won++; pts += 3; } else if (tg === og) { drawn++; pts++; } else lost++;
      });
      setStats({ pts, played, won, drawn, lost, gf, ga, pos: '-' });
      setLoading(false);
    }
    load();
  }, [team?.id]);

  const gd = stats.gf - stats.ga;
  const statCards = [
    { label: 'Position', val: stats.pos, color: 'text-white/60' },
    { label: 'Starts', val: stats.played, color: 'text-blue-400' },
    { label: 'Played', val: stats.played, color: 'text-white/60' },
    { label: 'GD', val: gd > 0 ? `+${gd}` : gd, color: gd > 0 ? 'text-brand-green' : gd < 0 ? 'text-red-400' : 'text-white/40' },
    { label: 'Points', val: stats.pts, color: 'text-brand-green' },
    { label: 'Won', val: stats.won, color: 'text-green-400' },
    { label: 'Drawn', val: stats.drawn, color: 'text-white/50' },
    { label: 'Lost', val: stats.lost, color: 'text-red-400' },
  ];

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Club hero */}
      <div className="glass rounded-3xl border border-white/10 p-6 flex items-center gap-5">
        <div className="w-20 h-20 rounded-3xl flex items-center justify-center text-3xl font-black border-2 border-white/10 shrink-0"
          style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` }}>
          {team.short_name?.[0]}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl font-black uppercase tracking-tight">{team.name}</h2>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm text-white/40">
            {team.city && <span>📍 {team.city}</span>}
            {team.venue && <span>🏟 {team.venue}</span>}
            {team.coach && <span>🧑‍💼 {team.coach}</span>}
          </div>
        </div>
        <div className="text-right shrink-0"><p className="text-5xl font-black text-brand-green">{stats.pts}</p><p className="text-[10px] text-white/30 uppercase tracking-widest">Points</p></div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 sm:grid-cols-8 gap-3">
        {statCards.map(s => (
          <div key={s.label} className="glass rounded-2xl p-3 border border-white/5 text-center">
            <p className={`text-xl font-black ${s.color}`}>{s.val}</p>
            <p className="text-[9px] text-white/30 uppercase mt-0.5 tracking-widest">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Next Match */}
      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
          <Zap size={14} className="text-brand-green" /><h3 className="font-black uppercase text-sm">Next Match</h3>
        </div>
        {!next ? (
          <p className="p-8 text-center text-white/30 text-sm">No upcoming matches</p>
        ) : (
          <div className="p-6 flex items-center gap-6">
            <TeamBadge team={next.homeTeam} isHighlighted={next.home_team_id === team.id} />
            <div className="text-center flex-1">
              <p className="font-black text-lg">vs</p>
              <p className="text-xs text-white/30">{next.start_time ? new Date(next.start_time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'TBC'}</p>
              <p className="text-[10px] text-white/20 mt-0.5">{(next.competitions as any)?.name || ''}</p>
            </div>
            <TeamBadge team={next.awayTeam} isHighlighted={next.away_team_id === team.id} right />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent results */}
        <div className="glass rounded-2xl border border-white/5 overflow-hidden">
          <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2"><Calendar size={14} className="text-brand-green" /><h3 className="font-black uppercase text-sm">Recent Results</h3></div>
          <div className="divide-y divide-white/5">
            {recent.length === 0 ? <p className="p-6 text-center text-white/30 text-sm">No results yet</p>
              : recent.map((m: any) => {
                const isH = m.home_team_id === team.id;
                const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
                const og = isH ? (m.away_score || 0) : (m.home_score || 0);
                const result = tg > og ? 'W' : tg === og ? 'D' : 'L';
                const rc: Record<string, string> = { W: 'bg-green-500/20 text-green-400', D: 'bg-white/10 text-white/50', L: 'bg-red-500/20 text-red-400' };
                const opp = isH ? m.awayTeam : m.homeTeam;
                return (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02]">
                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-[10px] font-black shrink-0 ${rc[result]}`}>{result}</span>
                    <span className="flex-1 text-sm font-bold truncate">{isH ? 'vs' : '@'} {opp?.name}</span>
                    <span className="font-black text-sm">{m.home_score} – {m.away_score}</span>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Top scorers */}
        <div className="glass rounded-2xl border border-white/5 overflow-hidden">
          <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2"><Star size={14} className="text-brand-green" /><h3 className="font-black uppercase text-sm">Top Scorers</h3></div>
          <div className="divide-y divide-white/5">
            {topScorers.length === 0 ? <p className="p-6 text-center text-white/30 text-sm">No players registered</p>
              : topScorers.map((p: any, i: number) => (
                <div key={p.id} className="flex items-center gap-3 px-5 py-3 hover:bg-white/[0.02]">
                  <span className={`text-sm font-black w-5 ${i === 0 ? 'text-yellow-400' : 'text-white/20'}`}>{i + 1}</span>
                  <div className="w-8 h-8 rounded-full bg-brand-green/20 flex items-center justify-center text-brand-green font-black text-xs shrink-0">{p.name?.[0]}</div>
                  <div className="flex-1 min-w-0"><p className="font-bold text-sm truncate">{p.name}</p><p className="text-[10px] text-white/30">{p.position}</p></div>
                  <div className="text-right"><p className="font-black text-brand-green">{p.goals || 0}</p><p className="text-[9px] text-white/30">goals</p></div>
                  <div className="text-right ml-3"><p className="font-black text-white/40">{p.assists || 0}</p><p className="text-[9px] text-white/30">ast</p></div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Manage Squad', icon: <Users size={24} />, tab: 'players' as PortalTab },
          { label: 'Fixtures', icon: <Calendar size={24} />, tab: 'fixtures' as PortalTab },
          { label: 'Statistics', icon: <TrendingUp size={24} />, tab: 'stats' as PortalTab },
          { label: 'Settings', icon: <Settings size={24} />, tab: 'settings' as PortalTab },
        ].map(a => (
          <button key={a.label} onClick={() => setTab(a.tab)}
            className="glass rounded-2xl p-5 border border-white/5 hover:border-brand-green/30 transition-all flex flex-col items-center gap-3 group hover:bg-brand-green/5">
            <span className="text-white/30 group-hover:text-brand-green transition-colors">{a.icon}</span>
            <span className="text-[10px] font-black uppercase tracking-widest text-white/40 group-hover:text-white transition-colors">{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2: PROFILE
// ═══════════════════════════════════════════════════════════════════════════════
function ProfileTab({ team }: { team: any }) {
  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-xl font-black uppercase flex items-center gap-2"><User size={18} className="text-brand-green" /> Club Profile</h2>
      <div className="glass rounded-3xl border border-white/10 overflow-hidden">
        {/* Banner */}
        <div className="h-32 relative" style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}33, ${team.secondary_color || '#000'}88)` }}>
          <div className="absolute bottom-0 translate-y-1/2 left-8">
            <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-3xl font-black border-4 border-[#0B0E13] shadow-xl"
              style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` }}>
              {team.short_name?.[0] || 'T'}
            </div>
          </div>
        </div>
        <div className="p-8 pt-14">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h3 className="text-2xl font-black uppercase">{team.name}</h3>
              <p className="text-white/40 mt-1">{team.short_name}{team.city ? ` · ${team.city}` : ''}</p>
            </div>
            <span className="px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest bg-brand-green/20 text-brand-green">Active</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {[
              { label: 'Stadium', val: team.venue || '—', icon: '🏟' },
              { label: 'Head Coach', val: team.coach || '—', icon: '🧑‍💼' },
              { label: 'City', val: team.city || '—', icon: '📍' },
              { label: 'Primary Color', val: team.primary_color || '—', icon: '🎨', color: team.primary_color },
              { label: 'Secondary Color', val: team.secondary_color || '—', icon: '🎨', color: team.secondary_color },
              { label: 'Team ID', val: `#${team.id}`, icon: '🆔' },
            ].map(r => (
              <div key={r.label} className="glass rounded-xl p-4 border border-white/5">
                <p className="text-[10px] font-black uppercase text-white/30 mb-1">{r.icon} {r.label}</p>
                <div className="flex items-center gap-2">
                  {r.color && <div className="w-4 h-4 rounded-full border border-white/20" style={{ background: r.color }} />}
                  <p className="font-bold text-sm">{r.val}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-white/20 mt-6 text-center">To edit club details, go to the <strong className="text-white/40">Settings</strong> tab.</p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3: PLAYERS (full CRUD — syncs to admin & fans)
// ═══════════════════════════════════════════════════════════════════════════════
function PlayersTab({ team, onToast }: { team: any; onToast: any }) {
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [form, setForm] = useState({ name: '', position: 'Midfielder', nationality: '', number: '', goals: 0, assists: 0, age: '', height: '' });

  const positions = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'];

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('players').select('*').eq('team_id', team.id).order('position').order('name');
    setPlayers(data || []);
    setLoading(false);
  }, [team?.id]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setEditing(null); setForm({ name: '', position: 'Midfielder', nationality: '', number: '', goals: 0, assists: 0, age: '', height: '' }); setShowForm(true); };
  const openEdit = (p: any) => {
    setEditing(p);
    setForm({ name: p.name, position: p.position || 'Midfielder', nationality: p.nationality || '', number: p.number?.toString() || '', goals: p.goals || 0, assists: p.assists || 0, age: p.age?.toString() || '', height: p.height?.toString() || '' });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { onToast.error('Player name is required.'); return; }
    setSaving(true);
    try {
      const payload: any = {
        name: form.name.trim(),
        position: form.position,
        nationality: form.nationality || null,
        number: form.number ? parseInt(form.number) : null,
        goals: Number(form.goals) || 0,
        assists: Number(form.assists) || 0,
        team_id: team.id,
      };
      if (form.age) payload.age = parseInt(form.age);
      if (form.height) payload.height = form.height;
      if (editing) {
        const { error } = await supabase.from('players').update(payload).eq('id', editing.id);
        if (error) throw error;
        onToast.success('Player updated — visible to fans & admin!');
      } else {
        const { error } = await supabase.from('players').insert([payload]);
        if (error) throw error;
        onToast.success('Player added to squad — visible to fans & admin!');
      }
      setShowForm(false);
      load();
    } catch (err: any) { onToast.error(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (p: any) => {
    setDeleting(p.id);
    try {
      const { error } = await supabase.from('players').delete().eq('id', p.id);
      if (error) throw error;
      onToast.success(`${p.name} removed from squad.`);
      load();
    } catch (err: any) { onToast.error(err.message); }
    finally { setDeleting(null); }
  };

  const byPos: Record<string, any[]> = {};
  players.forEach(p => { const k = p.position || 'Other'; (byPos[k] ||= []).push(p); });

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-black uppercase flex items-center gap-2"><Users size={18} className="text-brand-green" /> Squad Management</h2>
          <p className="text-sm text-white/40">{players.length} players · changes sync instantly to fans & admin</p>
        </div>
        <button onClick={openAdd} className="gradient-green text-black px-5 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:scale-105 transition-transform">
          <Plus size={14} /> Add Player
        </button>
      </div>

      {/* Add/Edit form */}
      {showForm && (
        <div className="glass rounded-2xl border border-brand-green/30 p-6 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-black uppercase text-brand-green">{editing ? `Edit — ${editing.name}` : 'New Player'}</h3>
            <button onClick={() => setShowForm(false)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/40"><X size={16} /></button>
          </div>
          <form onSubmit={handleSave}>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
              <div className="col-span-2 md:col-span-3"><Field label="Full Name *"><input required value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Mohammed Salah" className={inp} /></Field></div>
              <Field label="Position">
                <select value={form.position} onChange={e => setForm(p => ({ ...p, position: e.target.value }))} className={`${inp} bg-[#1a1d24]`}>
                  {positions.map(pos => <option key={pos}>{pos}</option>)}
                </select>
              </Field>
              <Field label="Nationality"><input value={form.nationality} onChange={e => setForm(p => ({ ...p, nationality: e.target.value }))} placeholder="e.g. Egyptian" className={inp} /></Field>
              <Field label="Jersey #"><input type="number" min={1} max={99} value={form.number} onChange={e => setForm(p => ({ ...p, number: e.target.value }))} placeholder="10" className={inp} /></Field>
              <Field label="Goals"><input type="number" min={0} value={form.goals} onChange={e => setForm(p => ({ ...p, goals: Number(e.target.value) }))} className={inp} /></Field>
              <Field label="Assists"><input type="number" min={0} value={form.assists} onChange={e => setForm(p => ({ ...p, assists: Number(e.target.value) }))} className={inp} /></Field>
              <Field label="Age"><input type="number" min={14} max={50} value={form.age} onChange={e => setForm(p => ({ ...p, age: e.target.value }))} placeholder="e.g. 28" className={inp} /></Field>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={saving} className="gradient-green text-black px-6 py-2.5 rounded-xl font-black text-xs uppercase flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform">
                <Save size={14} />{saving ? 'Saving…' : 'Save Player'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-6 py-2.5 rounded-xl bg-white/5 text-white/50 font-bold text-xs hover:bg-white/10">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? <Spinner /> : players.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5">
          <Users size={48} className="mx-auto text-white/10 mb-4" />
          <p className="text-white/30 font-bold uppercase mb-2">No players yet</p>
          <p className="text-white/20 text-sm mb-4">Add your first player — they'll appear for fans immediately.</p>
          <button onClick={openAdd} className="gradient-green text-black px-6 py-2.5 rounded-xl font-black text-xs uppercase flex items-center gap-2 mx-auto">
            <Plus size={14} /> Add First Player
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {positions.filter(pos => byPos[pos]).map(pos => (
            <div key={pos}>
              <h4 className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3 pl-1">{pos}s ({byPos[pos].length})</h4>
              <div className="glass rounded-2xl overflow-hidden border border-white/5">
                <table className="w-full">
                  <thead>
                    <tr className="text-[9px] font-black uppercase tracking-widest text-white/20 border-b border-white/5 bg-white/[0.02]">
                      <th className="px-4 py-2.5 text-left w-10">#</th>
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-center hidden sm:table-cell">Nat</th>
                      <th className="px-4 py-2.5 text-center hidden sm:table-cell">Age</th>
                      <th className="px-4 py-2.5 text-center">G</th>
                      <th className="px-4 py-2.5 text-center">A</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {byPos[pos].map(p => (
                      <tr key={p.id} className="hover:bg-white/[0.02] group transition-colors">
                        <td className="px-4 py-3 font-black text-white/30 text-sm">{p.number || '—'}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-brand-green/20 flex items-center justify-center font-black text-[10px] text-brand-green shrink-0">{p.name?.[0]}</div>
                            <span className="font-bold text-sm">{p.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center text-xs text-white/30 hidden sm:table-cell">{p.nationality || '—'}</td>
                        <td className="px-4 py-3 text-center text-xs text-white/30 hidden sm:table-cell">{p.age || '—'}</td>
                        <td className="px-4 py-3 text-center font-black text-brand-green">{p.goals || 0}</td>
                        <td className="px-4 py-3 text-center font-bold text-white/40">{p.assists || 0}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => openEdit(p)} className="p-1.5 rounded-lg text-white/30 hover:text-brand-green hover:bg-brand-green/10"><Edit2 size={13} /></button>
                            <button onClick={() => handleDelete(p)} disabled={deleting === p.id} className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-400/10 disabled:opacity-50">
                              {deleting === p.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4: MATCHES (results only)
// ═══════════════════════════════════════════════════════════════════════════════
function MatchesTab({ team }: { team: any }) {
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team?.id) return;
    supabase.from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, status, start_time, minute, homeTeam:teams!home_team_id(name,short_name,primary_color), awayTeam:teams!away_team_id(name,short_name,primary_color), competitions(name)')
      .or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`)
      .order('start_time', { ascending: false })
      .then(({ data }) => { setMatches(data || []); setLoading(false); });
  }, [team?.id]);

  const isDone = (s: string) => ['full_time', 'completed', 'finished'].includes(s);
  const isLive = (s: string) => ['first_half', 'second_half', 'extra_time', 'half_time'].includes(s);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5 max-w-4xl">
      <h2 className="text-xl font-black uppercase flex items-center gap-2"><Activity size={18} className="text-brand-green" /> All Matches</h2>
      {matches.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5"><Activity size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No matches yet</p></div>
      ) : (
        <div className="space-y-3">
          {matches.map((m: any) => {
            const isH = m.home_team_id === team.id;
            const done = isDone(m.status);
            const live = isLive(m.status);
            const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
            const og = isH ? (m.away_score || 0) : (m.home_score || 0);
            const result = done ? (tg > og ? 'W' : tg === og ? 'D' : 'L') : null;
            const rc: Record<string, string> = { W: 'bg-green-500 text-white', D: 'bg-white/20 text-white', L: 'bg-red-500 text-white' };
            return (
              <div key={m.id} className="glass rounded-2xl border border-white/5 hover:border-brand-green/20 transition-all p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] text-white/30 uppercase font-bold">{(m.competitions as any)?.name || 'Match'}</p>
                  <div className="flex items-center gap-2">
                    {live && <span className="flex items-center gap-1 text-[10px] font-black text-red-400 animate-pulse"><span className="w-1.5 h-1.5 bg-red-400 rounded-full" />LIVE {m.minute}'</span>}
                    {result && <span className={`px-2 py-0.5 rounded text-[10px] font-black ${rc[result]}`}>{result}</span>}
                    <span className="text-[10px] text-white/20 font-bold">{m.start_time ? new Date(m.start_time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'TBC'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <TeamBadge team={m.homeTeam} isHighlighted={m.home_team_id === team.id} />
                  <div className="flex-1 text-center">
                    {done || live ? <span className="text-2xl font-black">{m.home_score} – {m.away_score}</span> : <span className="text-white/30 font-black">vs</span>}
                  </div>
                  <TeamBadge team={m.awayTeam} isHighlighted={m.away_team_id === team.id} right />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5: FIXTURES (upcoming)
// ═══════════════════════════════════════════════════════════════════════════════
function FixturesTab({ team }: { team: any }) {
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'results'>('all');

  useEffect(() => {
    if (!team?.id) return;
    supabase.from('matches')
      .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, homeTeam:teams!home_team_id(name,short_name,primary_color), awayTeam:teams!away_team_id(name,short_name,primary_color), competitions(name)')
      .or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`)
      .order('start_time', { ascending: false })
      .then(({ data }) => { setMatches(data || []); setLoading(false); });
  }, [team?.id]);

  const isDone = (s: string) => ['full_time', 'completed', 'finished'].includes(s);
  const isLive = (s: string) => ['first_half', 'second_half', 'extra_time', 'half_time'].includes(s);
  const filtered = matches.filter(m => {
    if (filter === 'upcoming') return !isDone(m.status) && !isLive(m.status);
    if (filter === 'results') return isDone(m.status);
    return true;
  });

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-black uppercase flex items-center gap-2"><Calendar size={18} className="text-brand-green" /> Fixtures & Results</h2>
        <div className="flex gap-1 bg-white/5 rounded-xl p-1">
          {(['all', 'upcoming', 'results'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${filter === f ? 'bg-brand-green text-black' : 'text-white/40 hover:text-white'}`}>{f}</button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5"><Calendar size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No {filter === 'all' ? '' : filter} fixtures</p></div>
      ) : (
        <div className="space-y-3">
          {filtered.map((m: any) => {
            const isH = m.home_team_id === team.id;
            const done = isDone(m.status); const live = isLive(m.status);
            const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
            const og = isH ? (m.away_score || 0) : (m.home_score || 0);
            const result = done ? (tg > og ? 'W' : tg === og ? 'D' : 'L') : null;
            const rc: Record<string, string> = { W: 'bg-green-500 text-white', D: 'bg-white/20 text-white', L: 'bg-red-500 text-white' };
            return (
              <div key={m.id} className="glass rounded-2xl border border-white/5 hover:border-brand-green/20 p-5 transition-all">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] text-white/30 uppercase font-bold">{(m.competitions as any)?.name || 'Match'}</p>
                  <div className="flex items-center gap-2">
                    {live && <span className="flex items-center gap-1 text-[10px] font-black text-red-400 animate-pulse"><span className="w-1.5 h-1.5 bg-red-400 rounded-full" />LIVE {m.minute}'</span>}
                    {result && <span className={`px-2 py-0.5 rounded text-[10px] font-black ${rc[result]}`}>{result}</span>}
                    {!done && !live && <span className="text-[10px] text-white/20 font-bold">{m.start_time ? new Date(m.start_time).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'TBC'}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <TeamBadge team={m.homeTeam} isHighlighted={m.home_team_id === team.id} />
                  <div className="flex-1 text-center">{done || live ? <span className="text-2xl font-black">{m.home_score} – {m.away_score}</span> : <span className="text-white/30 font-black">vs</span>}</div>
                  <TeamBadge team={m.awayTeam} isHighlighted={m.away_team_id === team.id} right />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 6: TABLE
// ═══════════════════════════════════════════════════════════════════════════════
function TableTab({ team }: { team: any }) {
  const [standings, setStandings] = useState<any[]>([]);
  const [compName, setCompName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team?.id) return;
    async function load() {
      const { data: matchData } = await supabase.from('matches').select('competition_id, competitions(name)').or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`).not('competition_id', 'is', null).limit(1);
      if (!matchData?.length) { setLoading(false); return; }
      const compId = matchData[0].competition_id;
      setCompName((matchData[0].competitions as any)?.name || 'League');
      const [{ data: allMatches }, { data: allTeams }] = await Promise.all([
        supabase.from('matches').select('home_team_id, away_team_id, home_score, away_score, status').eq('competition_id', compId),
        supabase.from('teams').select('id, name, short_name, primary_color'),
      ]);
      if (!allMatches) { setLoading(false); return; }
      const teamIds = new Set<number>();
      allMatches.forEach((m: any) => { teamIds.add(m.home_team_id); teamIds.add(m.away_team_id); });
      const teamsMap = new Map((allTeams || []).map((t: any) => [t.id, t]));
      const rows: Record<number, any> = {};
      teamIds.forEach(id => { const t = teamsMap.get(id); if (t) rows[id] = { ...t, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 }; });
      allMatches.filter((m: any) => ['full_time', 'completed', 'finished'].includes(m.status)).forEach((m: any) => {
        const h = rows[m.home_team_id]; const a = rows[m.away_team_id]; if (!h || !a) return;
        h.played++; a.played++; h.gf += m.home_score || 0; h.ga += m.away_score || 0; a.gf += m.away_score || 0; a.ga += m.home_score || 0;
        if ((m.home_score || 0) > (m.away_score || 0)) { h.won++; h.points += 3; a.lost++; }
        else if ((m.home_score || 0) < (m.away_score || 0)) { a.won++; a.points += 3; h.lost++; }
        else { h.drawn++; a.drawn++; h.points++; a.points++; }
      });
      setStandings(Object.values(rows).sort((a: any, b: any) => b.points - a.points || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf));
      setLoading(false);
    }
    load();
  }, [team?.id]);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5 max-w-4xl">
      <h2 className="text-xl font-black uppercase flex items-center gap-2"><BarChart2 size={18} className="text-brand-green" /> {compName || 'League'} Table</h2>
      {standings.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5"><Trophy size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No standings yet</p></div>
      ) : (
        <div className="glass rounded-2xl overflow-hidden border border-white/5">
          <table className="w-full">
            <thead>
              <tr className="text-[9px] font-black uppercase tracking-widest text-white/20 border-b border-white/5 bg-white/[0.02]">
                <th className="px-4 py-3 text-left w-8">Pos</th><th className="px-4 py-3 text-left">Club</th>
                <th className="px-4 py-3 text-center">P</th><th className="px-4 py-3 text-center hidden sm:table-cell">W</th>
                <th className="px-4 py-3 text-center hidden sm:table-cell">D</th><th className="px-4 py-3 text-center hidden sm:table-cell">L</th>
                <th className="px-4 py-3 text-center hidden md:table-cell">GF</th><th className="px-4 py-3 text-center hidden md:table-cell">GA</th>
                <th className="px-4 py-3 text-center">GD</th><th className="px-4 py-3 text-center bg-brand-green/5 text-brand-green">Pts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {standings.map((row: any, i: number) => {
                const isMe = row.id === team?.id; const gd = row.gf - row.ga;
                return (
                  <tr key={row.id} className={`transition-colors ${isMe ? 'bg-brand-green/10' : 'hover:bg-white/[0.02]'}`}>
                    <td className={`px-4 py-3 font-black text-sm ${i < 3 ? 'text-brand-green' : 'text-white/30'}`}>{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-black shrink-0" style={{ background: row.primary_color || '#333' }}>{row.short_name?.[0]}</div>
                        <span className={`font-bold text-sm ${isMe ? 'text-brand-green' : ''}`}>{row.name}</span>
                        {isMe && <span className="text-[8px] font-black bg-brand-green text-black px-1.5 py-0.5 rounded-full">YOU</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center text-sm text-white/50">{row.played}</td>
                    <td className="px-4 py-3 text-center text-sm text-white/50 hidden sm:table-cell">{row.won}</td>
                    <td className="px-4 py-3 text-center text-sm text-white/50 hidden sm:table-cell">{row.drawn}</td>
                    <td className="px-4 py-3 text-center text-sm text-white/50 hidden sm:table-cell">{row.lost}</td>
                    <td className="px-4 py-3 text-center text-sm text-white/50 hidden md:table-cell">{row.gf}</td>
                    <td className="px-4 py-3 text-center text-sm text-white/50 hidden md:table-cell">{row.ga}</td>
                    <td className="px-4 py-3 text-center text-sm font-bold"><span className={gd > 0 ? 'text-brand-green' : gd < 0 ? 'text-red-400' : 'text-white/30'}>{gd > 0 ? `+${gd}` : gd}</span></td>
                    <td className="px-4 py-3 text-center bg-brand-green/5 font-black text-brand-green">{row.points}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 7: STATS
// ═══════════════════════════════════════════════════════════════════════════════
function StatsTab({ team }: { team: any }) {
  const [players, setPlayers] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'goals' | 'assists'>('goals');

  useEffect(() => {
    if (!team?.id) return;
    Promise.all([
      supabase.from('players').select('*').eq('team_id', team.id).order('goals', { ascending: false }),
      supabase.from('matches').select('home_team_id, away_team_id, home_score, away_score, status').or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`),
    ]).then(([playerRes, matchRes]) => {
      setPlayers(playerRes.data || []);
      setMatches(matchRes.data || []);
      setLoading(false);
    });
  }, [team?.id]);

  const done = matches.filter((m: any) => ['full_time', 'completed', 'finished'].includes(m.status));
  let won = 0, drawn = 0, lost = 0, gf = 0, ga = 0;
  done.forEach((m: any) => {
    const isH = m.home_team_id === team.id;
    const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
    const og = isH ? (m.away_score || 0) : (m.home_score || 0);
    gf += tg; ga += og;
    if (tg > og) won++; else if (tg === og) drawn++; else lost++;
  });
  const played = done.length;
  const winRate = played ? Math.round((won / played) * 100) : 0;
  const avgGoals = played ? (gf / played).toFixed(1) : '0.0';

  const sorted = [...players].sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
  const totalGoals = players.reduce((s, p) => s + (p.goals || 0), 0);
  const totalAssists = players.reduce((s, p) => s + (p.assists || 0), 0);

  if (loading) return <Spinner />;

  return (
    <div className="space-y-6 max-w-5xl">
      <h2 className="text-xl font-black uppercase flex items-center gap-2"><TrendingUp size={18} className="text-brand-green" /> Team Statistics</h2>

      {/* Overview cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Win Rate', val: `${winRate}%`, sub: `${won}W ${drawn}D ${lost}L`, color: 'text-brand-green' },
          { label: 'Goals Scored', val: totalGoals, sub: `${avgGoals} per game`, color: 'text-yellow-400' },
          { label: 'Goals Conceded', val: ga, sub: played ? `${(ga / played).toFixed(1)}/game` : '—', color: 'text-red-400' },
          { label: 'Total Assists', val: totalAssists, sub: `${players.length} players`, color: 'text-blue-400' },
        ].map(s => (
          <div key={s.label} className="glass rounded-2xl p-5 border border-white/5 text-center">
            <p className={`text-3xl font-black ${s.color}`}>{s.val}</p>
            <p className="text-[10px] text-white/30 uppercase tracking-widest mt-1">{s.label}</p>
            <p className="text-[10px] text-white/20 mt-0.5">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Player stats table */}
      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
          <h3 className="font-black uppercase text-sm">Player Performance</h3>
          <div className="flex gap-1 bg-white/5 rounded-xl p-1">
            {(['goals', 'assists'] as const).map(s => (
              <button key={s} onClick={() => setSortBy(s)}
                className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${sortBy === s ? 'bg-brand-green text-black' : 'text-white/40 hover:text-white'}`}>{s}</button>
            ))}
          </div>
        </div>
        {sorted.length === 0 ? (
          <p className="p-8 text-center text-white/30 text-sm">No players to display</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[9px] font-black uppercase tracking-widest text-white/20 border-b border-white/5 bg-white/[0.02]">
                <th className="px-4 py-2.5 text-left">Player</th>
                <th className="px-4 py-2.5 text-center hidden sm:table-cell">Pos</th>
                <th className="px-4 py-2.5 text-center">Goals</th>
                <th className="px-4 py-2.5 text-center">Assists</th>
                <th className="px-4 py-2.5 text-center hidden md:table-cell">G+A</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {sorted.map((p, i) => (
                <tr key={p.id} className={`hover:bg-white/[0.02] ${i === 0 ? 'bg-yellow-500/5' : ''}`}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {i === 0 && <span className="text-yellow-400">🏆</span>}
                      <div className="w-7 h-7 rounded-full bg-brand-green/20 flex items-center justify-center text-brand-green font-black text-[10px] shrink-0">{p.name?.[0]}</div>
                      <div><p className="font-bold text-sm">{p.name}</p>{p.nationality && <p className="text-[10px] text-white/30">{p.nationality}</p>}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-white/40 hidden sm:table-cell">{p.position}</td>
                  <td className="px-4 py-3 text-center font-black text-brand-green text-lg">{p.goals || 0}</td>
                  <td className="px-4 py-3 text-center font-bold text-blue-400">{p.assists || 0}</td>
                  <td className="px-4 py-3 text-center font-black text-white/60 hidden md:table-cell">{(p.goals || 0) + (p.assists || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Form (last 5) */}
      <div className="glass rounded-2xl border border-white/5 p-5">
        <h3 className="font-black uppercase text-sm mb-4 flex items-center gap-2"><Activity size={14} className="text-brand-green" /> Recent Form (last 5)</h3>
        <div className="flex gap-2">
          {played === 0 ? <p className="text-white/30 text-sm">No completed matches yet</p>
            : done.slice(0, 5).reverse().map((m: any, i: number) => {
              const isH = m.home_team_id === team.id;
              const tg = isH ? (m.home_score || 0) : (m.away_score || 0);
              const og = isH ? (m.away_score || 0) : (m.home_score || 0);
              const r = tg > og ? 'W' : tg === og ? 'D' : 'L';
              const c: Record<string, string> = { W: 'bg-green-500', D: 'bg-white/20', L: 'bg-red-500' };
              return <div key={i} className={`w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm ${c[r]}`}>{r}</div>;
            })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 8: LINEUP
// ═══════════════════════════════════════════════════════════════════════════════
import { FORMATIONS } from '../../lib/formations';

function LineupTab({ team, onToast }: { team: any; onToast: any }) {
  const [players, setPlayers] = useState<any[]>([]);
  const [formation, setFormation] = useState<string>('4-3-3');
  const [lineup, setLineup] = useState<(any | null)[]>(Array(11).fill(null));
  const [selectingSlot, setSelectingSlot] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!team?.id) return;
    Promise.all([
      supabase.from('players').select('*').eq('team_id', team.id).order('position').order('name'),
    ]).then(([playerRes]) => {
      setPlayers(playerRes.data || []);
      // Load saved lineup from DB first, then localStorage fallback
      const dbLineup = team.lineup;
      const localLineup = localStorage.getItem(`lineup_${team.id}`);
      const source = dbLineup || (localLineup ? JSON.parse(localLineup) : null);
      if (source) {
        try {
          const saved = typeof source === 'string' ? JSON.parse(source) : source;
          if (saved.formation) setFormation(saved.formation);
          if (saved.players) setLineup(saved.players);
        } catch (_) {}
      }
      setLoading(false);
    });
  }, [team?.id]);

  const formationSlots = FORMATIONS[formation] || FORMATIONS['4-3-3'];
  const selectedIds = new Set(lineup.filter(Boolean).map(p => p?.id));

  const handleSlotClick = (i: number) => setSelectingSlot(selectingSlot === i ? null : i);
  const handlePlayerSelect = (player: any) => {
    if (selectingSlot === null) return;
    const newLineup = [...lineup];
    // Remove player from other slot if already in lineup
    const existing = newLineup.findIndex(p => p?.id === player.id);
    if (existing !== -1) newLineup[existing] = null;
    newLineup[selectingSlot] = player;
    setLineup(newLineup);
    setSelectingSlot(null);
  };
  const removeFromSlot = (i: number) => { const n = [...lineup]; n[i] = null; setLineup(n); };
  const clearLineup = () => setLineup(Array(11).fill(null));

  const handleSave = async () => {
    setSaving(true);
    const lineupData = { formation, players: lineup };
    try {
      const { error } = await supabase.from('teams').update({ lineup: lineupData }).eq('id', team.id);
      if (error) {
        // Column missing from DB — save locally and show migration instructions
        if (error.message?.includes('lineup') || error.code === '42703' || error.message?.includes('schema cache')) {
          localStorage.setItem(`lineup_${team.id}`, JSON.stringify(lineupData));
          onToast.error('⚠️ DB column missing. Run this in Supabase SQL Editor: ALTER TABLE teams ADD COLUMN IF NOT EXISTS lineup JSONB; NOTIFY pgrst, \'reload schema\'; — Lineup saved locally for now.');
        } else {
          throw error;
        }
      } else {
        // Also sync localStorage
        localStorage.setItem(`lineup_${team.id}`, JSON.stringify(lineupData));
        onToast.success('Lineup saved! Fans can now see your starting XI.');
      }
    } catch (err: any) { onToast.error(err.message); }
    finally { setSaving(false); }
  };

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-xl font-black uppercase flex items-center gap-2"><Layout size={18} className="text-brand-green" /> Lineup Builder</h2>
        <div className="flex items-center gap-2">
          <select value={formation} onChange={e => { setFormation(e.target.value); setLineup(Array(11).fill(null)); }}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm font-bold focus:outline-none focus:border-brand-green/50 bg-[#1a1d24]">
            {Object.keys(FORMATIONS).map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <button onClick={clearLineup} className="px-3 py-2 rounded-xl bg-white/5 text-white/40 hover:bg-white/10 text-xs font-bold">Clear</button>
          <button onClick={handleSave} disabled={saving} className="gradient-green text-black px-5 py-2 rounded-xl font-black text-xs uppercase flex items-center gap-2 disabled:opacity-50">
            <Save size={13} />{saving ? 'Saving…' : 'Save Lineup'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pitch */}
        <div className="lg:col-span-2">
          <div className="relative rounded-2xl overflow-hidden border border-white/10" style={{ background: 'linear-gradient(180deg, #1a4a1a 0%, #1d5c1d 50%, #1a4a1a 100%)', paddingBottom: '130%' }}>
            {/* Pitch markings */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute top-1/2 left-[15%] right-[15%] h-px bg-white/10 transform -translate-y-1/2" />
              <div className="absolute top-1/2 left-1/2 w-[25%] h-[12%] border border-white/10 transform -translate-x-1/2 -translate-y-1/2 rounded-full" />
              <div className="absolute top-0 left-[30%] right-[30%] h-[10%] border border-white/10 border-t-0" />
              <div className="absolute bottom-0 left-[30%] right-[30%] h-[10%] border border-white/10 border-b-0" />
            </div>

            {formationSlots.map((slot, i) => {
              const player = lineup[i];
              const isSelecting = selectingSlot === i;
              return (
                <div key={i}
                  className={`absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer transition-all ${isSelecting ? 'scale-110 z-10' : 'z-0'}`}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%` }}
                  onClick={() => handleSlotClick(i)}
                >
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-black text-xs border-2 transition-all ${
                      player ? 'border-brand-green shadow-lg shadow-brand-green/30' : isSelecting ? 'border-yellow-400 border-dashed bg-yellow-400/10' : 'border-white/20 bg-black/40'
                    }`}
                      style={player ? { background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` } : {}}>
                      {player ? (player.name?.[0] || '?') : <Plus size={14} className="text-white/30" />}
                    </div>
                    <div className={`text-center leading-none ${isSelecting ? 'opacity-100' : 'opacity-80'}`}>
                      <p className="text-[9px] font-black text-white drop-shadow">{player ? player.name?.split(' ').pop() : slot.pos}</p>
                      {player && <button onClick={e => { e.stopPropagation(); removeFromSlot(i); }} className="text-[8px] text-red-400">✕</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-white/30 text-center mt-2">Click a position to assign a player · Formation: {formation}</p>
        </div>

        {/* Player picker */}
        <div className="glass rounded-2xl border border-white/5 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-white/5">
            <h3 className="font-black uppercase text-sm">
              {selectingSlot !== null ? <span className="text-brand-green">Select for: {formationSlots[selectingSlot]?.pos}</span> : 'Squad List'}
            </h3>
          </div>
          <div className="overflow-y-auto flex-1" style={{ maxHeight: '500px' }}>
            {players.length === 0 ? (
              <p className="p-6 text-center text-white/30 text-sm">Add players first</p>
            ) : ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'].map(pos => {
              const posPlayers = players.filter(p => p.position === pos);
              if (!posPlayers.length) return null;
              return (
                <div key={pos}>
                  <div className="px-4 py-2 text-[9px] font-black uppercase tracking-widest text-white/20 bg-white/[0.02]">{pos}s</div>
                  {posPlayers.map(p => {
                    const inLineup = selectedIds.has(p.id);
                    const isChosen = lineup[selectingSlot ?? -1]?.id === p.id;
                    return (
                      <button key={p.id} onClick={() => selectingSlot !== null && handlePlayerSelect(p)}
                        disabled={selectingSlot === null}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left ${inLineup ? 'opacity-40' : ''} ${selectingSlot !== null ? 'cursor-pointer' : 'cursor-default'}`}>
                        <div className="w-7 h-7 rounded-full bg-brand-green/20 flex items-center justify-center text-brand-green font-black text-[10px] shrink-0">{p.name?.[0]}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate">{p.name}</p>
                          <p className="text-[9px] text-white/30">#{p.number || '—'}</p>
                        </div>
                        {inLineup && <span className="text-[9px] text-brand-green font-black">In XI</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 9: GALLERY
// ═══════════════════════════════════════════════════════════════════════════════
function GalleryTab({ team, onToast }: { team: any; onToast: any }) {
  const [images, setImages] = useState<{ url: string; caption: string }[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newCaption, setNewCaption] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (team?.gallery) {
      try {
        const g = typeof team.gallery === 'string' ? JSON.parse(team.gallery) : team.gallery;
        setImages(Array.isArray(g) ? g : []);
      } catch (_) {}
    }
  }, [team?.gallery]);

  const save = async (newImages: any[]) => {
    setSaving(true);
    try {
      const { error } = await supabase.from('teams').update({ gallery: newImages }).eq('id', team.id);
      if (error) throw error;
      setImages(newImages);
      onToast.success('Gallery updated — visible to fans!');
    } catch (err: any) { onToast.error(err.message); }
    finally { setSaving(false); }
  };

  const handleAdd = async () => {
    if (!newUrl.trim()) { onToast.error('Image URL is required.'); return; }
    await save([...images, { url: newUrl.trim(), caption: newCaption.trim() }]);
    setNewUrl(''); setNewCaption(''); setShowAdd(false);
  };

  const handleDelete = (i: number) => {
    const n = images.filter((_, idx) => idx !== i);
    save(n);
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-black uppercase flex items-center gap-2"><Camera size={18} className="text-brand-green" /> Club Gallery</h2>
        <button onClick={() => setShowAdd(!showAdd)} className="gradient-green text-black px-5 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:scale-105 transition-transform">
          <Plus size={14} /> Add Photo
        </button>
      </div>

      {showAdd && (
        <div className="glass rounded-2xl border border-brand-green/30 p-5 animate-in slide-in-from-top-2">
          <h3 className="font-black uppercase text-brand-green mb-4 text-sm">Add Photo</h3>
          <div className="space-y-3">
            <Field label="Image URL *"><input type="url" value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://example.com/photo.jpg" className={inp} /></Field>
            <Field label="Caption (optional)"><input value={newCaption} onChange={e => setNewCaption(e.target.value)} placeholder="e.g. Match day vs Rivals" className={inp} /></Field>
          </div>
          {newUrl && (
            <div className="mt-3 rounded-xl overflow-hidden border border-white/10 h-32">
              <img src={newUrl} alt="preview" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            </div>
          )}
          <div className="flex gap-3 mt-4">
            <button onClick={handleAdd} disabled={saving} className="gradient-green text-black px-6 py-2.5 rounded-xl font-black text-xs uppercase flex items-center gap-2 disabled:opacity-50"><Save size={13} />{saving ? 'Saving…' : 'Add to Gallery'}</button>
            <button onClick={() => setShowAdd(false)} className="px-6 py-2.5 rounded-xl bg-white/5 text-white/50 font-bold text-xs">Cancel</button>
          </div>
        </div>
      )}

      {images.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5"><Camera size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">Gallery is empty</p><p className="text-white/20 text-sm mt-1">Add photos — fans will see them on your club page</p></div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {images.map((img, i) => (
            <div key={i} className="group relative rounded-2xl overflow-hidden border border-white/5 aspect-square cursor-pointer" onClick={() => setPreview(img.url)}>
              <img src={img.url} alt={img.caption || ''} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" onError={e => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/300x300?text=Photo'; }} />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-end p-3">
                {img.caption && <p className="text-white text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity">{img.caption}</p>}
              </div>
              <button onClick={e => { e.stopPropagation(); handleDelete(i); }}
                className="absolute top-2 right-2 w-7 h-7 rounded-full bg-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600">
                <X size={12} className="text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {preview && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4" onClick={() => setPreview(null)}>
          <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />
          <img src={preview} alt="" className="relative max-w-3xl max-h-[80vh] w-full object-contain rounded-2xl" />
          <button onClick={() => setPreview(null)} className="absolute top-6 right-6 w-10 h-10 rounded-full bg-white/10 flex items-center justify-center hover:bg-white/20"><X size={20} /></button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 10: NEWS
// ═══════════════════════════════════════════════════════════════════════════════
function NewsTab({ team, profile, onToast }: { team: any; profile: any; onToast: any }) {
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: '', body: '' });

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('team_news').select('*').eq('team_id', team.id).order('created_at', { ascending: false });
    setPosts(data || []);
    setLoading(false);
  }, [team?.id]);

  useEffect(() => { load(); }, [load]);

  const handlePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) { onToast.error('Title is required.'); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from('team_news').insert([{ team_id: team.id, title: form.title.trim(), body: form.body.trim(), author_name: profile?.username || 'Team Manager' }]);
      if (error) throw error;
      onToast.success('News posted — fans can see it now!');
      setForm({ title: '', body: '' }); setShowForm(false); load();
    } catch (err: any) { onToast.error(err.message + ' — Have you run the latest SQL migrations?'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    try {
      const { error } = await supabase.from('team_news').delete().eq('id', id);
      if (error) throw error;
      onToast.success('Post deleted.');
      load();
    } catch (err: any) { onToast.error(err.message); }
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-black uppercase flex items-center gap-2"><Newspaper size={18} className="text-brand-green" /> Club News</h2>
        <button onClick={() => setShowForm(!showForm)} className="gradient-green text-black px-5 py-2.5 rounded-xl font-black text-xs uppercase tracking-widest flex items-center gap-2 hover:scale-105 transition-transform">
          <Plus size={14} /> Post News
        </button>
      </div>

      {showForm && (
        <div className="glass rounded-2xl border border-brand-green/30 p-5 animate-in slide-in-from-top-2">
          <h3 className="font-black uppercase text-brand-green mb-4 text-sm">New Post</h3>
          <form onSubmit={handlePost} className="space-y-3">
            <Field label="Headline *"><input required value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="e.g. Big win against rivals!" className={inp} /></Field>
            <Field label="Details">
              <textarea value={form.body} onChange={e => setForm(p => ({ ...p, body: e.target.value }))} rows={4} placeholder="Write the full story here…" className={`${inp} resize-none`} />
            </Field>
            <div className="flex gap-3">
              <button type="submit" disabled={saving} className="gradient-green text-black px-6 py-2.5 rounded-xl font-black text-xs uppercase flex items-center gap-2 disabled:opacity-50"><Save size={13} />{saving ? 'Posting…' : 'Post'}</button>
              <button type="button" onClick={() => setShowForm(false)} className="px-6 py-2.5 rounded-xl bg-white/5 text-white/50 font-bold text-xs">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? <Spinner /> : posts.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center border border-white/5"><Newspaper size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No news posts yet</p><p className="text-white/20 text-sm mt-1">Keep your fans updated with club news!</p></div>
      ) : (
        <div className="space-y-4">
          {posts.map(post => (
            <div key={post.id} className="glass rounded-2xl border border-white/5 p-5 hover:border-white/10 transition-all group">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-white/30 font-bold uppercase mb-1">
                    {new Date(post.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · {post.author_name}
                  </p>
                  <h3 className="font-black text-base uppercase tracking-tight">{post.title}</h3>
                  {post.body && <p className="text-white/50 text-sm mt-2 leading-relaxed">{post.body}</p>}
                </div>
                <button onClick={() => handleDelete(post.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-2 rounded-xl hover:bg-red-500/20 text-red-400 shrink-0">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 11: SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
function SettingsTab({ team, onUpdate, onError }: { team: any; onUpdate: (t: any) => void; onError: (m: string) => void }) {
  const [form, setForm] = useState({ name: team?.name || '', short_name: team?.short_name || '', city: team?.city || '', venue: team?.venue || '', coach: team?.coach || '', primary_color: team?.primary_color || '#39FF14', secondary_color: team?.secondary_color || '#000000' });
  const [saving, setSaving] = useState(false);
  const f = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data, error } = await supabase.from('teams').update(form).eq('id', team.id).select().single();
      if (error) throw error;
      onUpdate(data);
    } catch (err: any) { onError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h2 className="text-xl font-black uppercase flex items-center gap-2"><Settings size={18} className="text-brand-green" /> Club Settings</h2>

      {/* Live preview */}
      <div className="glass rounded-2xl p-5 border border-white/10 flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black border-2 border-white/10 shrink-0"
          style={{ background: `linear-gradient(135deg, ${form.primary_color}, ${form.secondary_color})` }}>
          {form.short_name?.[0] || 'T'}
        </div>
        <div>
          <p className="font-black uppercase">{form.name || 'Team Name'}</p>
          <p className="text-white/40 text-sm">{form.city || '—'}{form.venue ? ` · ${form.venue}` : ''}</p>
        </div>
        <span className="ml-auto text-[10px] text-brand-green/60 font-black uppercase">Live Preview</span>
      </div>

      <form onSubmit={handleSave} className="glass rounded-2xl p-6 border border-white/10 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2"><Field label="Club Name *"><input required value={form.name} onChange={e => f('name', e.target.value)} placeholder="Full club name" className={inp} /></Field></div>
          <Field label="Short Name * (max 5)"><input required maxLength={5} value={form.short_name} onChange={e => f('short_name', e.target.value.toUpperCase())} placeholder="MUN" className={`${inp} tracking-widest font-bold`} /></Field>
          <Field label="City / Town"><input value={form.city} onChange={e => f('city', e.target.value)} placeholder="e.g. Lagos" className={inp} /></Field>
          <Field label="Stadium / Ground"><input value={form.venue} onChange={e => f('venue', e.target.value)} placeholder="e.g. National Stadium" className={inp} /></Field>
          <Field label="Head Coach"><input value={form.coach} onChange={e => f('coach', e.target.value)} placeholder="Coach full name" className={inp} /></Field>
        </div>

        <div className="border-t border-white/5 pt-5">
          <p className="text-[10px] font-black uppercase text-white/40 mb-4">Kit Colors — shown to fans & in standings</p>
          <div className="grid grid-cols-2 gap-6">
            <Field label="Primary Color">
              <div className="flex items-center gap-3">
                <input type="color" value={form.primary_color} onChange={e => f('primary_color', e.target.value)} className="w-12 h-12 rounded-xl cursor-pointer border-0 bg-transparent" />
                <span className="font-mono text-sm text-white/40">{form.primary_color}</span>
              </div>
            </Field>
            <Field label="Secondary Color">
              <div className="flex items-center gap-3">
                <input type="color" value={form.secondary_color} onChange={e => f('secondary_color', e.target.value)} className="w-12 h-12 rounded-xl cursor-pointer border-0 bg-transparent" />
                <span className="font-mono text-sm text-white/40">{form.secondary_color}</span>
              </div>
            </Field>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-4 border-t border-white/5">
          <button type="submit" disabled={saving}
            className="gradient-green text-black px-8 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 disabled:opacity-50 hover:scale-105 transition-transform">
            <Save size={14} />{saving ? 'Saving…' : 'Save All Changes'}
          </button>
          <p className="text-[10px] text-white/20">Changes sync instantly to fans & admin</p>
        </div>
      </form>
    </div>
  );
}

// ─── Shared helpers ────────────────────────────────────────────────────────────
function TeamBadge({ team, isHighlighted, right }: { team: any; isHighlighted: boolean; right?: boolean }) {
  return (
    <div className={`flex items-center gap-2 flex-1 ${right ? 'flex-row-reverse' : ''}`}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-sm shrink-0" style={{ background: team?.primary_color || '#333' }}>
        {team?.short_name?.[0]}
      </div>
      <span className={`text-sm font-bold truncate ${isHighlighted ? 'text-brand-green' : 'text-white/70'}`}>{team?.name}</span>
    </div>
  );
}
