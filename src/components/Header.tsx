import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, Search, LogIn, User, Shield, X, Trophy, Calendar } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

export default function Header() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, profile } = useAuth();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ teams: any[]; matches: any[] }>({ teams: [], matches: [] });
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Notification state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const notifRef = useRef<HTMLDivElement>(null);

  // Refresh button state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    window.setTimeout(() => window.location.reload(), 550);
  };

  const navItems = [
    { path: '/', label: 'HOME', icon: '🏠' },
    { path: '/matches', label: 'MATCHES', icon: '⚽' },
    { path: '/tables', label: 'TABLES', icon: '📊' },
    { path: '/teams', label: 'TEAMS', icon: '👥' },
    { path: '/news', label: 'NEWS', icon: '📰' },
    { path: '/predictions', label: 'PREDICT', icon: '🎯' },
  ];

  const isActive = (path: string) => location.pathname === path;

  // Live search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults({ teams: [], matches: [] });
      return;
    }
    const q = searchQuery.trim().toLowerCase();
    const delay = setTimeout(async () => {
      const [teamsRes, matchesRes] = await Promise.all([
        supabase.from('teams').select('id, name, short_name, primary_color').ilike('name', `%${q}%`).limit(5),
        supabase.from('matches').select('id, home_score, away_score, status, homeTeam:teams!home_team_id(name), awayTeam:teams!away_team_id(name)').or(`status.in.(first_half,second_half,extra_time,full_time,completed)`).limit(5),
      ]);
      setSearchResults({
        teams: teamsRes.data || [],
        matches: (matchesRes.data || []).filter((m: any) =>
          m.homeTeam?.name?.toLowerCase().includes(q) || m.awayTeam?.name?.toLowerCase().includes(q)
        ),
      });
    }, 300);
    return () => clearTimeout(delay);
  }, [searchQuery]);

  // Load recent match results for notifications
  const loadNotifications = async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('matches')
      .select('id, home_score, away_score, status, start_time, homeTeam:teams!home_team_id(name, short_name), awayTeam:teams!away_team_id(name, short_name)')
      .in('status', ['full_time', 'completed'])
      .gte('start_time', yesterday)
      .order('start_time', { ascending: false })
      .limit(8);
    setNotifications(data || []);
  };

  const handleNotifToggle = () => {
    if (!notifOpen) loadNotifications();
    setNotifOpen(o => !o);
    setSearchOpen(false);
  };

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <header className="sticky top-0 z-50 glass border-b border-white/10">
      <div className="container mx-auto px-4 py-3 relative flex items-center justify-between">
        {/* Refresh Button (was the icon logo) */}
        <button
          onClick={handleRefresh}
          aria-label="Refresh app"
          title="Refresh"
          className="relative flex items-center justify-center shrink-0 group focus:outline-none"
        >
          <span
            className="absolute inset-0 rounded-full opacity-40 group-hover:opacity-70 transition-opacity duration-500 animate-brand-aura -z-10"
            aria-hidden="true"
          />
          <img
            src="/kicklive-icon.png"
            alt="Refresh"
            className={`relative h-14 sm:h-16 md:h-20 w-auto object-contain drop-shadow-[0_0_14px_rgba(57,255,20,0.5)] transition-transform duration-300 ${
              isRefreshing ? 'animate-spin' : 'group-hover:rotate-[25deg] group-active:scale-90'
            }`}
          />
        </button>

        {/* Centered Wordmark Logo */}
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center cursor-pointer"
          onClick={() => navigate('/')}
        >
          <span
            className="absolute inset-0 scale-150 rounded-full opacity-50 animate-brand-aura -z-10"
            aria-hidden="true"
          />
          <img
            src="/kicklive-logo.png.png"
            alt="KickLive"
            className="relative h-9 sm:h-11 md:h-[3.25rem] w-auto object-contain drop-shadow-[0_0_10px_rgba(0,212,255,0.55)] hover:drop-shadow-[0_0_20px_rgba(255,0,212,0.7)] transition-all duration-300"
          />
        </div>

        {/* Right Side */}
        <div className="flex items-center gap-3">
          {/* Search */}
          <div ref={searchRef} className="relative hidden lg:block">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              placeholder="Search teams, matches…"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
              onFocus={() => setSearchOpen(true)}
              className="bg-white/5 border border-white/10 rounded-full pl-9 pr-9 py-1.5 text-xs text-white placeholder:text-white/40 focus:outline-none focus:border-brand-green/50 w-48 transition-all focus:w-64"
            />
            {searchQuery && (
              <button onClick={() => { setSearchQuery(''); setSearchOpen(false); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white">
                <X size={12} />
              </button>
            )}

            {/* Search Dropdown */}
            {searchOpen && (searchResults.teams.length > 0 || searchResults.matches.length > 0) && (
              <div className="absolute top-full mt-2 right-0 w-72 glass rounded-2xl border border-white/10 shadow-2xl overflow-hidden z-[200]">
                {searchResults.teams.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-white/30 px-4 pt-3 pb-1">Teams</p>
                    {searchResults.teams.map(t => (
                      <button
                        key={t.id}
                        onClick={() => { navigate(`/team/${t.id}`); setSearchOpen(false); setSearchQuery(''); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                      >
                        <div className="w-7 h-7 rounded-full flex items-center justify-center font-black text-xs border border-white/10" style={{ background: t.primary_color || '#333' }}>
                          {t.short_name?.[0] || t.name?.[0]}
                        </div>
                        <span className="text-sm font-bold">{t.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {searchResults.matches.length > 0 && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-white/30 px-4 pt-3 pb-1">Matches</p>
                    {searchResults.matches.map(m => (
                      <button
                        key={m.id}
                        onClick={() => { navigate(`/match/${m.id}`); setSearchOpen(false); setSearchQuery(''); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 transition-colors text-left"
                      >
                        <Calendar size={14} className="text-brand-green shrink-0" />
                        <span className="text-sm font-bold truncate">{m.homeTeam?.name} vs {m.awayTeam?.name}</span>
                        {['full_time','completed'].includes(m.status) && (
                          <span className="text-xs text-brand-green font-black ml-auto">{m.home_score}-{m.away_score}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Notifications Bell */}
          <div ref={notifRef} className="relative">
            <button onClick={handleNotifToggle} className="p-2 hover:bg-white/5 rounded-full relative">
              <Bell size={16} className={notifOpen ? 'text-brand-green' : 'text-white/60'} />
              {notifications.length > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-brand-green rounded-full"></span>
              )}
            </button>

            {notifOpen && (
              <div className="absolute top-full mt-2 right-0 w-80 glass rounded-2xl border border-white/10 shadow-2xl overflow-hidden z-[200]">
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
                  <p className="font-black uppercase text-xs tracking-widest">Match Results</p>
                  <span className="text-[10px] text-white/30">Last 24 hours</span>
                </div>
                {notifications.length === 0 ? (
                  <div className="p-8 text-center">
                    <Bell size={32} className="mx-auto text-white/10 mb-3" />
                    <p className="text-white/30 text-xs font-bold uppercase">No recent results</p>
                  </div>
                ) : (
                  <div className="divide-y divide-white/5 max-h-72 overflow-y-auto">
                    {notifications.map(n => (
                      <button
                        key={n.id}
                        onClick={() => { navigate(`/match/${n.id}`); setNotifOpen(false); }}
                        className="w-full flex items-center gap-3 px-5 py-3 hover:bg-white/5 transition-colors text-left"
                      >
                        <Trophy size={14} className="text-brand-green shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold truncate">{n.homeTeam?.short_name} vs {n.awayTeam?.short_name}</p>
                          <p className="text-[10px] text-white/30 uppercase font-bold">Full Time</p>
                        </div>
                        <span className="text-sm font-black text-brand-green">{n.home_score} – {n.away_score}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Admin Panel */}
          {user && profile?.role === 'admin' && (
            <button
              onClick={() => navigate('/admin')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-500/10 text-purple-500 font-bold text-sm hover:bg-purple-500 hover:text-white transition-all"
            >
              <Shield size={16} />
              <span className="hidden sm:inline">Admin</span>
            </button>
          )}

          {/* Login/Profile */}
          {user ? (
            <button
              onClick={() => navigate('/profile')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-green/10 text-brand-green font-bold text-sm hover:bg-brand-green hover:text-black transition-all"
            >
              <User size={16} />
              <span className="hidden sm:inline">{profile?.username || 'Profile'}</span>
            </button>
          ) : (
            <button
              onClick={() => navigate('/login')}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-green/10 text-brand-green font-bold text-sm hover:bg-brand-green hover:text-black transition-all"
            >
              <LogIn size={16} />
              <span className="hidden sm:inline">Login</span>
            </button>
          )}
        </div>
      </div>

      {/* Desktop Nav */}
      <nav className="hidden md:flex items-center justify-center gap-1 py-2 border-t border-white/5">
        {navItems.map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              isActive(item.path) ? 'text-brand-green bg-brand-green/10' : 'text-white/60 hover:text-brand-green hover:bg-white/5'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Mobile Nav */}
      <div className="md:hidden flex items-center justify-around py-2 border-t border-white/5">
        {navItems.slice(0, 4).map((item) => (
          <button
            key={item.path}
            onClick={() => navigate(item.path)}
            className="flex flex-col items-center gap-1 p-2"
          >
            <span className="text-lg">{item.icon}</span>
            <span className={`text-[10px] font-bold ${isActive(item.path) ? 'text-brand-green' : 'text-white/60'}`}>
              {item.label}
            </span>
          </button>
        ))}
        <button
          onClick={() => user ? navigate('/profile') : navigate('/login')}
          className="flex flex-col items-center gap-1 p-2"
        >
          <span className="text-lg">👤</span>
          <span className="text-[10px] font-bold text-white/60">{user ? 'Profile' : 'Login'}</span>
        </button>
      </div>
    </header>
  );
}