import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, Search, LogIn, User, Shield, X, Trophy, Calendar, MessageSquare } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { readOnce } from '../lib/data';
import { globalSearch, recentResults } from '../lib/data/queries.ts';
import { unreadCount } from '../lib/data/messages.ts';
import { assetUrl } from "../lib/app-shell.ts";
import UpdateControl from "../components/UpdateControl.tsx";

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

  // Unread messages badge. Refreshed when signed in and on every navigation (each route change re-runs this
  // effect via location.pathname), so the count follows the user around without a background timer — the
  // query ratchet forbids adding a self-refetching poller, and a per-navigation read is the cheaper honest
  // answer anyway.
  const [unreadMsgs, setUnreadMsgs] = useState(0);
  useEffect(() => {
    if (!user) {
      setUnreadMsgs(0);
      return;
    }
    let cancelled = false;
    void unreadCount()
      .then((res) => {
        if (!cancelled && res.ok) setUnreadMsgs(res.data.count ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user, location.pathname]);

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

  // Search: debounced here, cached and deduplicated in the data layer. The 300 ms pause stays because a
  // keystroke is not a question, and the two `ilike` reads now share one key — `docs/PHASE4_DATA_ARCHITECTURE.md`
  // F-08 counted this box as two whole-table scans per pause with no reuse at all.
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults({ teams: [], matches: [] });
      return;
    }
    let cancelled = false;
    const delay = setTimeout(() => {
      void readOnce(globalSearch, { query: searchQuery })
        .then((result: { teams: any[]; matches: any[] } | null) => {
          if (cancelled || !result) return;
          setSearchResults(result);
        })
        .catch(() => {
          if (!cancelled) setSearchResults({ teams: [], matches: [] });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(delay);
    };
  }, [searchQuery]);

  // Recent results, for the bell. Read once per open — the entry outlives the panel, so re-opening it in
  // the same session is free, and `matches` invalidates it when a match finalizes.
  useEffect(() => {
    if (!notifOpen) return;
    let cancelled = false;
    void readOnce(recentResults, { hours: 24, limit: 8 })
      .then((rows: any[] | null) => {
        if (!cancelled) setNotifications(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setNotifications([]);
      });
    return () => {
      cancelled = true;
    };
  }, [notifOpen]);

  const handleNotifToggle = () => {
    // Opening the panel is the refresh: the effect on `notifOpen` reads through the cache, so this costs a
    // request only when the entry has aged out. It used to fire its own query on every open, every time.
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
      {/* Fixed bar height: the wordmark grows inside this box, but the header itself never changes height. */}
      <div className="container mx-auto px-4 h-[4.75rem] relative flex items-center justify-between">
        {/* Wordmark, doubling as the refresh control (no spin, no glow) */}
        <button
          onClick={handleRefresh}
          aria-label="Refresh app"
          title="Refresh"
          className="relative flex flex-col items-start shrink-0 group focus:outline-none"
        >
          <img
            src={assetUrl("brand/wordmark-312.png")}
            alt="KickLive"
            className="relative h-11 sm:h-14 md:h-[4.25rem] w-auto object-contain transition-opacity duration-300 group-hover:opacity-80 group-active:opacity-60"
          />
          {/* Modern refresh affordance: a thin indeterminate bar, only while refreshing */}
          <span
            className={`loader-track mt-1 h-0.5 w-full transition-opacity duration-200 ${isRefreshing ? 'opacity-100' : 'opacity-0'}`}
            aria-hidden="true"
          />
        </button>

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

          {/* Updates: desktop installer + PWA service-worker activation, one control, two surfaces */}
          <UpdateControl />

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

          {/* Messages (signed-in only) */}
          {user && (
            <button
              onClick={() => navigate('/messages')}
              className="relative flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.04] text-white/70 font-bold text-sm hover:bg-white/10 hover:text-white transition-all"
              aria-label="Messages"
              title="Messages"
            >
              <MessageSquare size={16} />
              <span className="hidden sm:inline">Messages</span>
              {unreadMsgs > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-green text-black text-[10px] font-black flex items-center justify-center">
                  {unreadMsgs > 9 ? '9+' : unreadMsgs}
                </span>
              )}
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