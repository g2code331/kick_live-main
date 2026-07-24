import { useState, useEffect } from 'react';
import { 
  Shield, Users, Calendar, Trophy, Newspaper, Settings, Target,
  LogOut, TrendingUp, AlertCircle, CheckCircle, ChevronRight,
  UserPlus, FileText, Activity, Plus
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import CompetitionWizard from './admin/CompetitionWizard';
import CompetitionEditor from './admin/CompetitionEditor';
import FixturesViewer from './admin/FixturesViewer';
import MatchControlComplete from './admin/MatchControlComplete';
import PlayerCreator from './shared/PlayerCreator';
import MediaPublisher from './shared/MediaPublisher';
import AppSettingsDashboard from './admin/AppSettingsDashboard';
import UserManagement from './admin/UserManagement';
import TeamDashboard from './admin/TeamDashboard';
import TableStatistics from './admin/TableStatistics';
import MultiMatchQueue from './admin/MultiMatchQueue';
import SeasonManagement from './admin/SeasonManagement';

type AdminTab = 'overview' | 'users' | 'matches' | 'teams' | 'media' | 'competitions' | 'tables' | 'settings';

export default function AdminPortal({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [teamsList, setTeamsList] = useState<any[]>([]);
  const [matchesList, setMatchesList] = useState<any[]>([]);
  const [mediaList, setMediaList] = useState<any[]>([]);
  const [activityList, setActivityList] = useState<any[]>([]);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [competitionsList, setCompetitionsList] = useState<any[]>([]);
  const [_loading, setLoading] = useState(true);
  const [pendingTeamsCount, setPendingTeamsCount] = useState(0);

  const [isCompetitionWizardOpen, setIsCompetitionWizardOpen] = useState(false);
  const [isCompetitionEditorOpen, setIsCompetitionEditorOpen] = useState(false);
  const [isFixturesViewerOpen, setIsFixturesViewerOpen] = useState(false);
  const [selectedCompetition, setSelectedCompetition] = useState<any>(null);
  const [isPlayerCreatorOpen, setIsPlayerCreatorOpen] = useState(false);
  const [isMediaPublisherOpen, setIsMediaPublisherOpen] = useState(false);
  const [isTeamAdderOpen, setIsTeamAdderOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<any>(null);
  const [isTeamDashboardOpen, setIsTeamDashboardOpen] = useState(false);

  useEffect(() => {
    async function loadAdminData() {
      try {
        const [teams, matches, users, competitions, pending] = await Promise.all([
          supabase.from('teams').select('id, name, short_name, city, primary_color, secondary_color'),
          supabase.from('matches').select('id, home_team_id, away_team_id, home_score, away_score, status, start_time, competition_id').limit(50),
          supabase.from('profiles').select('id, email, username, role, created_at').limit(50),
          supabase.from('competitions').select('id, name, type, format, season, status, start_date, end_date, settings, created_at').order('created_at', { ascending: false }).limit(20),
          supabase.from('teams').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        ]);
        
        setTeamsList(teams.data || []);
        setMatchesList(matches.data || []);
        setUsersList(users.data || []);
        setCompetitionsList(competitions.data || []);
        setPendingTeamsCount(pending.count || 0);
        
        const media = await supabase.from('media').select('id, title, category, image_url, created_at').order('created_at', { ascending: false }).limit(10);
        setMediaList(media.data || []);
        
        const activity = await supabase.from('activity_logs').select('id, action, entity_type, entity_name, created_at, profiles(username)').order('created_at', { ascending: false }).limit(10);
        setActivityList(activity.data || []);
      } catch (err) {
        console.error('Load error:', err);
      } finally {
        setLoading(false);
      }
    }
    loadAdminData();
  }, []);

  const handleSignOut = async () => {
    await signOut();
    window.location.hash = '/login';
  };

  const [adminMsg, setAdminMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const menuItems = [
    { id: 'overview', label: 'Overview', icon: <Activity size={16} />, badge: 0 },
    { id: 'competitions', label: 'Tournaments', icon: <Trophy size={16} />, badge: 0 },
    { id: 'matches', label: 'Matches', icon: <Calendar size={16} />, badge: 0 },
    { id: 'teams', label: 'Teams', icon: <Users size={16} />, badge: pendingTeamsCount },
    { id: 'media', label: 'Media', icon: <Newspaper size={16} />, badge: 0 },
    { id: 'users', label: 'Users', icon: <Shield size={16} />, badge: 0 },
    { id: 'tables', label: 'Tables', icon: <Target size={16} />, badge: 0 },
    { id: 'settings', label: 'Settings', icon: <Settings size={16} />, badge: 0 },
  ];

  const logActivity = async (action: string, entityType: string, entityId: number, entityName: string, details?: any) => {
    try {
      await supabase.from('activity_logs').insert([{
        user_id: profile?.id,
        action,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: entityName,
        details: details || {}
      }]);
      const { data: activityData } = await supabase.from('activity_logs').select('*, profiles(username)').order('created_at', { ascending: false }).limit(10);
      setActivityList(activityData || []);
    } catch (err) {
      console.error('Error logging activity:', err);
    }
  };

  const handleDeleteCompetition = async (compId: number, compName: string) => {
    if (!confirm(`Are you sure you want to delete "${compName}"? This will delete all fixtures and cannot be undone!`)) return;
    
    try {
      await supabase.from('matches').delete().eq('competition_id', compId);
      const { error } = await supabase.from('competitions').delete().eq('id', compId);
      if (error) throw error;
      setAdminMsg({ type: 'success', text: 'Tournament deleted successfully!' });
      const { data } = await supabase.from('competitions').select('id, name, type, format, season, status, start_date, end_date, settings, created_at').order('created_at', { ascending: false }).limit(20);
      setCompetitionsList(data || []);
      await logActivity('Competition Deleted', 'competition', compId, compName);
    } catch (err: any) {
      setAdminMsg({ type: 'error', text: 'Error: ' + err.message });
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0E13] flex">
      {/* Admin Toast */}
      {adminMsg && (
        <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${
          adminMsg.type === 'success' ? 'bg-brand-green/20 border-brand-green/40' : 'bg-red-500/20 border-red-500/40'
        }`}>
          {adminMsg.type === 'success' ? '✅' : '❌'} {adminMsg.text}
        </div>
      )}

      {/* ── Sidebar — desktop only ──────────────────────────────────────── */}
      <aside className="hidden lg:flex w-64 shrink-0 sticky top-0 h-screen glass border-r border-white/10 p-6 flex-col">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-10 h-10 gradient-green rounded-xl flex items-center justify-center">
            <Shield size={20} className="text-black" />
          </div>
          <span className="font-black italic uppercase tracking-tighter text-lg">Admin<span className="text-[#39FF14]">Panel</span></span>
        </div>

        <nav className="flex-1 space-y-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as AdminTab)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-bold text-sm ${
                activeTab === item.id ? 'bg-[#39FF14]/10 text-[#39FF14]' : 'text-white/70 hover:text-white hover:bg-white/5'
              }`}
            >
              {item.icon}
              {item.label}
              {item.badge > 0 && (
                <span className="ml-auto px-2 py-0.5 rounded-full bg-yellow-500 text-black text-[10px] font-black">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="pt-6 border-t border-white/10">
          <button onClick={handleSignOut} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-brand-red hover:bg-brand-red/10 transition-all font-bold text-sm">
            <LogOut size={20} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main Content ────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-screen overflow-x-hidden">

        {/* ── Top header ──────────────────────────────────────────────── */}
        <header className="glass border-b border-white/10 sticky top-0 z-50">
          <div className="flex items-center justify-between px-4 lg:px-8 py-3">
            {/* Left: logo (mobile) + title */}
            <div className="flex items-center gap-3">
              {/* Shield icon — only on mobile since desktop has sidebar */}
              <div className="lg:hidden w-9 h-9 gradient-green rounded-xl flex items-center justify-center shrink-0">
                <Shield size={16} className="text-black" />
              </div>
              <div>
                <h1 className="text-lg lg:text-2xl font-black italic uppercase tracking-tighter leading-none">
                  System <span className="text-[#39FF14]">Dashboard</span>
                </h1>
                <p className="text-white/40 text-[10px] hidden sm:block mt-0.5">Real-time infrastructure management</p>
              </div>
            </div>

            {/* Right: actions */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsCompetitionWizardOpen(true)}
                className="gradient-green text-black px-3 sm:px-5 py-2 rounded-xl font-black uppercase text-[10px] sm:text-xs tracking-widest flex items-center gap-1.5 hover:scale-105 transition-transform"
              >
                <Plus size={14} /> <span className="hidden xs:inline">New</span> Tournament
              </button>
              {/* Sign out — mobile only (desktop has sidebar) */}
              <button onClick={handleSignOut} className="lg:hidden p-2 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors">
                <LogOut size={16} />
              </button>
            </div>
          </div>

          {/* ── Mobile tab bar ────────────────────────────────────────── */}
          <div className="lg:hidden flex overflow-x-auto no-scrollbar gap-1 px-4 pb-3">
            {menuItems.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as AdminTab)}
                className={`relative flex items-center gap-1.5 px-3 py-2 rounded-xl font-black text-[10px] uppercase tracking-widest whitespace-nowrap shrink-0 transition-all ${
                  activeTab === tab.id
                    ? 'bg-brand-green text-black shadow-lg shadow-brand-green/20'
                    : 'text-white/70 hover:text-white hover:bg-white/10'
                }`}
              >
                {tab.icon}
                {tab.label}
                {tab.badge > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-yellow-500 text-black text-[8px] font-black flex items-center justify-center">
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </header>

        {/* ── Page content ──────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-10 pb-32">

          {activeTab === 'overview' && (
            <div className="space-y-8 animate-in">
              {/* Pending Team Requests Alert */}
              {pendingTeamsCount > 0 && (
                <div
                  onClick={() => setActiveTab('teams')}
                  className="glass rounded-2xl border border-yellow-500/40 bg-yellow-500/5 p-5 flex items-center gap-4 cursor-pointer hover:bg-yellow-500/10 transition-all"
                >
                  <div className="w-10 h-10 rounded-xl bg-yellow-500/20 flex items-center justify-center shrink-0">
                    <Users size={18} className="text-yellow-400" />
                  </div>
                  <div className="flex-1">
                    <p className="font-black text-yellow-400 text-sm uppercase tracking-widest">
                      {pendingTeamsCount} Team Registration{pendingTeamsCount > 1 ? 's' : ''} Awaiting Approval
                    </p>
                    <p className="text-white/40 text-xs mt-0.5">Team managers submitted their clubs and are waiting for you to approve or reject.</p>
                  </div>
                  <div className="px-4 py-2 rounded-xl bg-yellow-500/20 text-yellow-400 font-black text-xs uppercase tracking-widest shrink-0">
                    Review →
                  </div>
                </div>
              )}

              {/* Quick Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
                {[
                  { label: 'Total Users', value: usersList.length, icon: <Users />, color: 'blue', tab: 'users' as AdminTab },
                  { label: 'Active Matches', value: matchesList.filter((m: any) => m.status === 'live').length, icon: <Activity />, color: 'green', tab: 'matches' as AdminTab },
                  { label: 'Tournaments', value: competitionsList.length, icon: <Trophy />, color: 'yellow', tab: 'competitions' as AdminTab },
                  { label: 'Media Posts', value: mediaList.length, icon: <FileText />, color: 'purple', tab: 'media' as AdminTab },
                ].map((stat, i) => (
                  <div
                    key={i}
                    onClick={() => setActiveTab(stat.tab)}
                    className="glass p-4 lg:p-6 rounded-2xl lg:rounded-3xl border border-white/5 cursor-pointer hover:border-brand-green/30 hover:bg-brand-green/5 transition-all group"
                  >
                    <div className={`w-10 h-10 lg:w-12 lg:h-12 rounded-xl lg:rounded-2xl bg-${stat.color}-500/20 text-${stat.color}-500 flex items-center justify-center mb-3 lg:mb-4 group-hover:scale-110 transition-transform`}>
                      {stat.icon}
                    </div>
                    <p className="text-2xl lg:text-3xl font-black italic">{stat.value}</p>
                    <p className="text-[9px] lg:text-[10px] font-black uppercase tracking-widest text-white/40 mt-1">{stat.label}</p>
                  </div>
                ))}
              </div>

              {/* Recent Activity */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
                <div className="glass rounded-2xl lg:rounded-[2.5rem] border border-white/5 overflow-hidden">
                  <div className="p-5 lg:p-8 border-b border-white/5 flex items-center justify-between">
                    <h3 className="font-black italic uppercase tracking-widest text-sm">System Activity</h3>
                    <TrendingUp size={16} className="text-[#39FF14]" />
                  </div>
                  <div className="p-3 lg:p-4 space-y-1 lg:space-y-2">
                    {activityList.length > 0 ? activityList.map((log, i) => (
                      <div key={i} className="flex items-start gap-3 lg:gap-4 p-3 lg:p-4 rounded-xl lg:rounded-2xl hover:bg-white/5 transition-colors">
                        <div className="w-9 h-9 lg:w-10 lg:h-10 rounded-xl bg-white/5 flex items-center justify-center shrink-0">
                          {log.action?.includes('Update') ? <Settings size={14} /> : <Plus size={14} />}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white/80">{log.action} <span className="text-[#39FF14]">{log.entity_name}</span></p>
                          <p className="text-[10px] text-white/30 uppercase mt-0.5 font-bold">{log.profiles?.username} • {new Date(log.created_at).toLocaleTimeString()}</p>
                        </div>
                      </div>
                    )) : (
                      <p className="p-8 text-center text-white/20 text-xs font-bold uppercase tracking-widest">No recent activity</p>
                    )}
                  </div>
                </div>

                <div className="glass rounded-2xl lg:rounded-[2.5rem] border border-white/5 overflow-hidden">
                  <div className="p-5 lg:p-8 border-b border-white/5 flex items-center justify-between">
                    <h3 className="font-black italic uppercase tracking-widest text-sm">Live Infrastructure</h3>
                    <Target size={16} className="text-brand-blue" />
                  </div>
                  <div className="p-5 lg:p-8 space-y-5 lg:space-y-6">
                    {[
                      { name: 'API Server', status: 'Online', color: 'green' },
                      { name: 'Database Instance', status: 'Healthy', color: 'green' },
                      { name: 'Storage Engine', status: 'Online', color: 'green' },
                      { name: 'Real-time Sync', status: 'Connected', color: 'green' },
                    ].map((sys, i) => (
                      <div key={i} className="flex items-center justify-between">
                        <span className="text-sm font-bold text-white/60">{sys.name}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-black uppercase tracking-widest text-white/40">{sys.status}</span>
                          <div className={`w-2 h-2 rounded-full bg-brand-${sys.color} animate-pulse`}></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'competitions' && (
            <div className="space-y-6 animate-in">
              {/* Section header with Create button */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl lg:text-2xl font-black italic uppercase tracking-tighter">
                    Tournaments <span className="text-[#39FF14]">& Cups</span>
                  </h2>
                  <p className="text-white/40 text-xs mt-1">{competitionsList.length} tournament{competitionsList.length !== 1 ? 's' : ''} configured</p>
                </div>
                <button
                  onClick={() => setIsCompetitionWizardOpen(true)}
                  className="gradient-green text-black px-4 py-2.5 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 hover:scale-105 transition-transform"
                >
                  <Plus size={14} /> Create Tournament
                </button>
              </div>

              {competitionsList.length === 0 ? (
                /* Empty state */
                <div className="glass rounded-2xl p-12 text-center border border-white/5">
                  <Trophy size={48} className="mx-auto text-white/10 mb-4" />
                  <p className="text-white/40 font-black uppercase tracking-widest mb-2">No tournaments yet</p>
                  <p className="text-white/20 text-sm mb-6">Create your first tournament to get started.</p>
                  <button
                    onClick={() => setIsCompetitionWizardOpen(true)}
                    className="gradient-green text-black px-6 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 mx-auto hover:scale-105 transition-transform"
                  >
                    <Plus size={14} /> Create First Tournament
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
                  {competitionsList.map((comp) => (
                    <div key={comp.id} className="glass rounded-2xl lg:rounded-[2rem] p-6 lg:p-8 border border-white/10 flex flex-col hover:border-[#39FF14]/30 transition-all group">
                      <div className="flex justify-between items-start mb-5">
                        <div className="w-11 h-11 bg-[#39FF14]/10 rounded-2xl flex items-center justify-center text-[#39FF14]">
                          <Trophy size={22} />
                        </div>
                        <span className={`px-3 py-1 rounded-full text-[8px] font-black uppercase tracking-widest ${
                          comp.status === 'live' ? 'bg-[#39FF14] text-black' : 'bg-white/10 text-white/40'
                        }`}>
                          {comp.status}
                        </span>
                      </div>
                      <h3 className="text-lg font-black italic uppercase tracking-tighter mb-1 group-hover:text-[#39FF14] transition-colors">{comp.name}</h3>
                      <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em] mb-5">{comp.type} • {comp.season}</p>

                      <div className="mt-auto grid grid-cols-3 gap-2 pt-5 border-t border-white/5">
                        <button
                          onClick={() => { setSelectedCompetition(comp); setIsFixturesViewerOpen(true); }}
                          className="py-2.5 bg-white/5 rounded-xl hover:bg-white/10 transition-colors text-[10px] font-black uppercase tracking-widest"
                        >
                          Fixtures
                        </button>
                        <button
                          onClick={() => { setSelectedCompetition(comp); setIsCompetitionEditorOpen(true); }}
                          className="py-2.5 bg-white/5 rounded-xl hover:bg-white/10 transition-colors text-[10px] font-black uppercase tracking-widest"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDeleteCompetition(comp.id, comp.name)}
                          className="py-2.5 bg-brand-red/10 rounded-xl hover:bg-brand-red/20 text-brand-red transition-colors text-[10px] font-black uppercase tracking-widest"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'matches' && (
            <div className="animate-in">
              <MultiMatchQueue />
            </div>
          )}

          {activeTab === 'media' && (
            <div className="animate-in">
              <div className="glass rounded-2xl lg:rounded-[2rem] p-5 lg:p-8 border border-white/10">
                <div className="flex items-center justify-between mb-6 lg:mb-8">
                  <div>
                    <h2 className="text-xl lg:text-2xl font-black italic uppercase tracking-tighter">Media <span className="text-[#39FF14]">Hub</span></h2>
                    <p className="text-white/40 text-sm">Manage all media content and publications</p>
                  </div>
                  <button
                    onClick={() => setIsMediaPublisherOpen(true)}
                    className="gradient-green text-black px-4 lg:px-6 py-2.5 lg:py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2"
                  >
                    <Plus size={14} /> New Article
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
                  {mediaList.length > 0 ? mediaList.map((item: any) => (
                    <div key={item.id} className="glass rounded-2xl overflow-hidden group cursor-pointer">
                      <div className="h-36 lg:h-40 overflow-hidden">
                        <img
                          src={item.image_url || 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400'}
                          alt={item.title}
                          className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                          onError={(e) => { (e.target as HTMLImageElement).src = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400'; }}
                        />
                      </div>
                      <div className="p-4 lg:p-5">
                        <span className="text-[10px] font-bold text-purple-500 uppercase tracking-widest">{item.category || 'News'}</span>
                        <h3 className="font-bold mt-1.5 line-clamp-2 text-sm">{item.title}</h3>
                        <p className="text-xs text-white/40 mt-1.5 line-clamp-2">{item.excerpt || 'No excerpt'}</p>
                        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/5">
                          <span className="text-[10px] text-white/30">{new Date(item.created_at).toLocaleDateString()}</span>
                          <button className="text-[10px] font-bold text-purple-500 hover:underline">Edit</button>
                        </div>
                      </div>
                    </div>
                  )) : (
                    <div className="col-span-full text-center py-16">
                      <Newspaper size={48} className="mx-auto text-white/10 mb-4" />
                      <p className="text-white/30 font-bold uppercase tracking-widest">No media posts yet</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'users' && <UserManagement />}
          {activeTab === 'teams' && <TeamDashboard />}
          {activeTab === 'tables' && <TableStatistics />}
          {activeTab === 'settings' && (
            <div className="space-y-8">
              <AppSettingsDashboard isOpen={true} onClose={() => setActiveTab('overview')} />
              <SeasonManagement />
            </div>
          )}

        </main>
      </div>

      {/* Modals & Wizards */}
      {isCompetitionWizardOpen && <CompetitionWizard isOpen={isCompetitionWizardOpen} onClose={() => setIsCompetitionWizardOpen(false)} />}
      {isCompetitionEditorOpen && <CompetitionEditor competition={selectedCompetition} isOpen={isCompetitionEditorOpen} onClose={() => setIsCompetitionEditorOpen(false)} onUpdate={() => {}} />}
      {isFixturesViewerOpen && <FixturesViewer competition={selectedCompetition} isOpen={isFixturesViewerOpen} onClose={() => setIsFixturesViewerOpen(false)} onOpenMatchQueue={() => setActiveTab('matches')} />}
      {isPlayerCreatorOpen && <PlayerCreator isOpen={isPlayerCreatorOpen} onClose={() => setIsPlayerCreatorOpen(false)} />}
      {isMediaPublisherOpen && <MediaPublisher isOpen={isMediaPublisherOpen} onClose={() => setIsMediaPublisherOpen(false)} />}
      {isSettingsOpen && <AppSettingsDashboard isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />}
    </div>
  );
}
