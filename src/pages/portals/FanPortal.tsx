import { useState, useEffect } from 'react';
import {
  Heart, Trophy, Calendar, Star, Bell, LogOut,
  TrendingUp, Target, Activity, Users, Newspaper,
  RefreshCw, Loader2, ChevronRight, Award
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';

interface FanPortalProps {
  onNavigate: (page: string) => void;
}

export default function FanPortal({ onNavigate }: FanPortalProps) {
  const { profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<'home' | 'matches' | 'teams' | 'stats'>('home');

  const [liveMatches, setLiveMatches] = useState<any[]>([]);
  const [recentMatches, setRecentMatches] = useState<any[]>([]);
  const [upcomingMatches, setUpcomingMatches] = useState<any[]>([]);
  const [topScorers, setTopScorers] = useState<any[]>([]);
  const [allTeams, setAllTeams] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async (silent = false) => {
    if (!silent) setLoading(true); else setRefreshing(true);
    try {
      const [matchRes, playerRes, teamRes, newsRes] = await Promise.all([
        supabase
          .from('matches')
          .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time, homeTeam:teams!home_team_id(name,short_name,primary_color,secondary_color), awayTeam:teams!away_team_id(name,short_name,primary_color,secondary_color), competitions(name)')
          .order('start_time', { ascending: false })
          .limit(50),
        supabase
          .from('players')
          .select('id, name, position, goals, assists, nationality, team_id, teams(name, short_name, primary_color)')
          .order('goals', { ascending: false })
          .limit(10),
        supabase
          .from('teams')
          .select('id, name, short_name, city, venue, coach, primary_color, secondary_color, status')
          .in('status', ['active', null as any])
          .order('name'),
        supabase
          .from('team_news')
          .select('id, title, body, created_at, author_name, team_id, teams(name, primary_color)')
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      const matches = matchRes.data || [];
      const liveStatuses = ['first_half', 'second_half', 'extra_time', 'half_time', 'penalty_shootout'];
      const doneStatuses = ['full_time', 'completed', 'finished'];

      setLiveMatches(matches.filter((m: any) => liveStatuses.includes(m.status)));
      setRecentMatches(matches.filter((m: any) => doneStatuses.includes(m.status)).slice(0, 10));
      setUpcomingMatches(
        matches
          .filter((m: any) => !liveStatuses.includes(m.status) && !doneStatuses.includes(m.status))
          .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
          .slice(0, 10)
      );

      setTopScorers((playerRes.data || []).filter((p: any) => (p.goals || 0) > 0));
      setAllTeams((teamRes.data || []).filter((t: any) => t.status !== 'pending' && t.status !== 'rejected'));
      setNews(newsRes.data || []);
    } catch (err) {
      console.error('[FanPortal] Load error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => load(true), 30000);
    return () => clearInterval(interval);
  }, []);

  const handleSignOut = async () => { await signOut(); onNavigate('login'); };

  const tabs = [
    { id: 'home', label: 'Home', icon: <Heart size={15} /> },
    { id: 'matches', label: 'Matches', icon: <Activity size={15} /> },
    { id: 'teams', label: 'Teams', icon: <Users size={15} /> },
    { id: 'stats', label: 'Top Scorers', icon: <Star size={15} /> },
  ];

  return (
    <div className="min-h-screen bg-brand-bg">
      {/* Header */}
      <header className="glass border-b border-white/10 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-brand-blue/20 rounded-xl flex items-center justify-center">
              <Heart size={18} className="text-brand-blue" />
            </div>
            <div>
              <h1 className="font-black text-base uppercase tracking-tight">Fan Zone</h1>
              <p className="text-[10px] text-white/40">Hey, {profile?.username || 'Fan'} 👋</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => load(true)} className={`p-2 hover:bg-white/5 rounded-xl transition-colors ${refreshing ? 'opacity-50' : ''}`}>
              <RefreshCw size={16} className={refreshing ? 'animate-spin text-brand-green' : 'text-white/30'} />
            </button>
            {liveMatches.length > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/20 border border-red-500/30">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-black text-red-400 uppercase">{liveMatches.length} Live</span>
              </div>
            )}
            <button onClick={handleSignOut} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-red-400/70 hover:bg-red-400/10 transition-colors">
              <LogOut size={16} /><span className="text-xs font-bold hidden sm:block">Sign Out</span>
            </button>
          </div>
        </div>
        <div className="container mx-auto px-4 pb-3">
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold text-sm whitespace-nowrap transition-all ${
                  activeTab === tab.id ? 'bg-brand-blue text-white shadow-lg' : 'text-white/40 hover:text-white hover:bg-white/5'
                }`}>
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 pb-24 max-w-5xl">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 size={32} className="text-brand-green animate-spin" /></div>
        ) : (
          <>
            {/* ── HOME ────────────────────────────────────────────────────── */}
            {activeTab === 'home' && (
              <div className="space-y-8">
                {/* Live banner */}
                {liveMatches.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                      <h2 className="text-sm font-black uppercase tracking-widest text-red-400">Live Now</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {liveMatches.map((m: any) => <MatchCard key={m.id} match={m} highlight="live" />)}
                    </div>
                  </div>
                )}

                {/* News feed */}
                {news.length > 0 && (
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-4 flex items-center gap-2"><Newspaper size={14} /> Latest News</h2>
                    <div className="space-y-3">
                      {news.slice(0, 5).map((n: any) => (
                        <div key={n.id} className="glass rounded-2xl p-5 border border-white/5 hover:border-white/10 transition-all">
                          <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center font-black text-sm shrink-0"
                              style={{ background: `linear-gradient(135deg, ${(n.teams as any)?.primary_color || '#39FF14'}33, #000)` }}>
                              📰
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[10px] font-black uppercase text-brand-blue">{(n.teams as any)?.name || 'Club News'}</span>
                                <span className="text-[10px] text-white/20">· {new Date(n.created_at).toLocaleDateString()}</span>
                              </div>
                              <h3 className="font-black uppercase tracking-tight leading-tight">{n.title}</h3>
                              {n.body && <p className="text-white/40 text-xs mt-1 line-clamp-2">{n.body}</p>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Recent results */}
                  <div className="lg:col-span-2 space-y-4">
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50">Recent Results</h2>
                    {recentMatches.length === 0 ? (
                      <div className="glass rounded-2xl p-8 text-center border border-white/5"><p className="text-white/30 text-sm">No completed matches yet</p></div>
                    ) : recentMatches.slice(0, 5).map((m: any) => <MatchCard key={m.id} match={m} />)}
                  </div>

                  {/* Top scorers sidebar */}
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-4 flex items-center justify-between">
                      Top Scorers <TrendingUp size={14} className="text-brand-green" />
                    </h2>
                    <div className="glass rounded-2xl border border-white/5 overflow-hidden">
                      {topScorers.length === 0 ? (
                        <p className="p-6 text-center text-white/30 text-sm">No scorers yet</p>
                      ) : topScorers.slice(0, 8).map((p: any, i: number) => (
                        <div key={p.id} className="flex items-center gap-3 p-3.5 border-b border-white/[0.04] hover:bg-white/[0.02] last:border-0">
                          <span className={`text-xs font-black w-5 ${i === 0 ? 'text-yellow-400' : 'text-white/20'}`}>{i + 1}</span>
                          <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-[10px] shrink-0"
                            style={{ background: (p.teams as any)?.primary_color || '#333' }}>
                            {p.name?.[0]}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold truncate">{p.name}</p>
                            <p className="text-[9px] text-white/30">{(p.teams as any)?.name || p.position}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-black text-brand-green text-sm">{p.goals}</p>
                            <p className="text-[8px] text-white/20">goals</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Upcoming fixtures */}
                {upcomingMatches.length > 0 && (
                  <div>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-4">Upcoming Fixtures</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {upcomingMatches.slice(0, 6).map((m: any) => <MatchCard key={m.id} match={m} highlight="upcoming" />)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── MATCHES ─────────────────────────────────────────────────── */}
            {activeTab === 'matches' && (
              <div className="space-y-6">
                {liveMatches.length > 0 && (
                  <section>
                    <h2 className="text-sm font-black uppercase tracking-widest text-red-400 mb-3 flex items-center gap-2"><span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />Live</h2>
                    <div className="space-y-3">{liveMatches.map((m: any) => <MatchCard key={m.id} match={m} highlight="live" full />)}</div>
                  </section>
                )}
                {upcomingMatches.length > 0 && (
                  <section>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-3 flex items-center gap-2"><Calendar size={14} />Upcoming</h2>
                    <div className="space-y-3">{upcomingMatches.map((m: any) => <MatchCard key={m.id} match={m} highlight="upcoming" full />)}</div>
                  </section>
                )}
                {recentMatches.length > 0 && (
                  <section>
                    <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-3 flex items-center gap-2"><Trophy size={14} />Results</h2>
                    <div className="space-y-3">{recentMatches.map((m: any) => <MatchCard key={m.id} match={m} full />)}</div>
                  </section>
                )}
                {!liveMatches.length && !upcomingMatches.length && !recentMatches.length && (
                  <div className="text-center py-16"><Activity size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No matches yet</p></div>
                )}
              </div>
            )}

            {/* ── TEAMS ───────────────────────────────────────────────────── */}
            {activeTab === 'teams' && (
              <div className="space-y-4">
                <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-4">{allTeams.length} Clubs</h2>
                {allTeams.length === 0 ? (
                  <div className="text-center py-16"><Users size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No teams yet</p></div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                    {allTeams.map((t: any) => (
                      <div key={t.id} className="glass rounded-2xl p-5 border border-white/5 hover:border-white/10 transition-all group">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl font-black border border-white/10 shrink-0"
                            style={{ background: `linear-gradient(135deg, ${t.primary_color || '#39FF14'}, ${t.secondary_color || '#000'})` }}>
                            {t.short_name?.[0] || '?'}
                          </div>
                          <div className="min-w-0">
                            <h3 className="font-black uppercase text-sm truncate group-hover:text-brand-green transition-colors">{t.name}</h3>
                            <p className="text-[10px] text-white/30">{t.short_name}{t.city ? ` · ${t.city}` : ''}</p>
                          </div>
                        </div>
                        <div className="space-y-1 text-[11px] text-white/30">
                          {t.venue && <p>🏟 {t.venue}</p>}
                          {t.coach && <p>🧑‍💼 {t.coach}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── STATS ───────────────────────────────────────────────────── */}
            {activeTab === 'stats' && (
              <div className="space-y-4">
                <h2 className="text-sm font-black uppercase tracking-widest text-white/50 mb-4 flex items-center gap-2"><Star size={14} className="text-yellow-400" />Top Scorers</h2>
                {topScorers.length === 0 ? (
                  <div className="text-center py-16"><Star size={48} className="mx-auto text-white/10 mb-4" /><p className="text-white/30 font-bold uppercase">No scorers yet</p></div>
                ) : (
                  <div className="glass rounded-2xl overflow-hidden border border-white/5">
                    <table className="w-full">
                      <thead>
                        <tr className="text-[9px] font-black uppercase tracking-widest text-white/20 border-b border-white/5 bg-white/[0.02]">
                          <th className="px-4 py-3 text-left w-8">Rank</th>
                          <th className="px-4 py-3 text-left">Player</th>
                          <th className="px-4 py-3 text-left hidden sm:table-cell">Club</th>
                          <th className="px-4 py-3 text-center hidden md:table-cell">Pos</th>
                          <th className="px-4 py-3 text-center">G</th>
                          <th className="px-4 py-3 text-center">A</th>
                          <th className="px-4 py-3 text-center hidden sm:table-cell">G+A</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {topScorers.map((p: any, i: number) => (
                          <tr key={p.id} className={`hover:bg-white/[0.02] transition-colors ${i === 0 ? 'bg-yellow-500/5' : ''}`}>
                            <td className="px-4 py-3 font-black text-sm">
                              {i === 0 ? '🏆' : <span className="text-white/30">{i + 1}</span>}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-[10px] shrink-0"
                                  style={{ background: (p.teams as any)?.primary_color || '#333' }}>
                                  {p.name?.[0]}
                                </div>
                                <div><p className="font-bold text-sm">{p.name}</p>{p.nationality && <p className="text-[9px] text-white/30">{p.nationality}</p>}</div>
                              </div>
                            </td>
                            <td className="px-4 py-3 hidden sm:table-cell"><p className="text-xs text-white/40 font-bold">{(p.teams as any)?.name || '—'}</p></td>
                            <td className="px-4 py-3 text-center text-xs text-white/30 hidden md:table-cell">{p.position}</td>
                            <td className="px-4 py-3 text-center font-black text-brand-green text-lg">{p.goals || 0}</td>
                            <td className="px-4 py-3 text-center font-bold text-blue-400">{p.assists || 0}</td>
                            <td className="px-4 py-3 text-center font-black text-white/40 hidden sm:table-cell">{(p.goals || 0) + (p.assists || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ─── Match Card ───────────────────────────────────────────────────────────────
function MatchCard({ match: m, highlight, full }: { match: any; highlight?: 'live' | 'upcoming'; full?: boolean }) {
  const isDone = ['full_time', 'completed', 'finished'].includes(m.status);
  const isLive = ['first_half', 'second_half', 'extra_time', 'half_time', 'penalty_shootout'].includes(m.status);

  return (
    <div className={`glass rounded-2xl border transition-all p-4 ${isLive ? 'border-red-500/30 bg-red-500/5' : 'border-white/5 hover:border-white/10'}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-black text-white/30 uppercase">{(m.competitions as any)?.name || 'Match'}</span>
        {isLive && <span className="flex items-center gap-1 text-[10px] font-black text-red-400 animate-pulse"><span className="w-1.5 h-1.5 bg-red-400 rounded-full" />LIVE{m.minute ? ` ${m.minute}'` : ''}</span>}
        {!isLive && !isDone && m.start_time && (
          <span className="text-[10px] text-white/30 font-bold">
            {new Date(m.start_time).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
          </span>
        )}
        {isDone && <span className="text-[10px] text-white/20 font-bold">FT</span>}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 flex-1">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs shrink-0"
            style={{ background: (m.homeTeam as any)?.primary_color || '#333' }}>
            {(m.homeTeam as any)?.short_name?.[0]}
          </div>
          <span className="font-bold text-sm truncate">{(m.homeTeam as any)?.name}</span>
        </div>
        <div className="text-center shrink-0">
          {isDone || isLive
            ? <span className="font-black text-lg">{m.home_score ?? 0} – {m.away_score ?? 0}</span>
            : <span className="font-black text-white/30 text-sm">vs</span>}
        </div>
        <div className="flex items-center gap-2 flex-1 flex-row-reverse">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-xs shrink-0"
            style={{ background: (m.awayTeam as any)?.primary_color || '#333' }}>
            {(m.awayTeam as any)?.short_name?.[0]}
          </div>
          <span className="font-bold text-sm truncate text-right">{(m.awayTeam as any)?.name}</span>
        </div>
      </div>
    </div>
  );
}
