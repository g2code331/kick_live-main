import { useState } from 'react';
import { 
  Users, Calendar, Trophy, LogOut, UserPlus, 
  FileText, Settings, Shield, Star, TrendingUp, Activity
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { teams, players, matches } from '../../data/mockData';

interface TeamPortalProps {
  onNavigate: (page: string) => void;
}

type TeamTab = 'overview' | 'roster' | 'matches' | 'reports';

export default function TeamPortal({ onNavigate }: TeamPortalProps) {
  const { profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<TeamTab>('overview');

  // Simulate managed team (first team in the list)
  const myTeam = teams[0];
  const myPlayers = players.filter(p => p.teamId === myTeam.id);
  const myMatches = matches.filter(m => m.homeTeamId === myTeam.id || m.awayTeamId === myTeam.id);

  const handleSignOut = async () => {
    await signOut();
    onNavigate('login');
  };

  const teamStats = {
    wins: 8,
    draws: 1,
    losses: 1,
    goalsFor: 24,
    goalsAgainst: 8,
    position: 1,
  };

  const sidebarItems = [
    { id: 'overview', label: 'Overview', icon: <TrendingUp size={20} /> },
    { id: 'roster', label: 'Squad Roster', icon: <Users size={20} /> },
    { id: 'matches', label: 'Match Reports', icon: <Calendar size={20} /> },
    { id: 'reports', label: 'Team Reports', icon: <FileText size={20} /> },
  ];

  return (
    <div className="min-h-screen bg-brand-bg flex">
      {/* Sidebar */}
      <aside className="w-64 glass border-r border-white/10 p-6 flex flex-col">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl font-black" style={{
            background: `linear-gradient(135deg, ${myTeam.primaryColor}, ${myTeam.secondaryColor})`,
          }}>
            {myTeam.shortName[0]}
          </div>
          <div>
            <h1 className="font-black text-sm uppercase tracking-tight">{myTeam.name}</h1>
            <p className="text-[10px] text-white/40 uppercase tracking-widest">Team Manager</p>
          </div>
        </div>

        <nav className="flex-1 space-y-2">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id as TeamTab)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                activeTab === item.id
                  ? 'bg-yellow-500/10 text-yellow-500'
                  : 'text-white/40 hover:text-white hover:bg-white/5'
              }`}
            >
              {item.icon}
              <span className="text-sm font-bold">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="pt-6 border-t border-white/10">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-500 font-bold">
              {profile?.username?.[0] || 'T'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{profile?.username || 'Team Manager'}</p>
              <p className="text-[10px] text-white/40 uppercase tracking-widest">Manager</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-brand-red hover:bg-brand-red/10 transition-all"
          >
            <LogOut size={20} />
            <span className="text-sm font-bold">Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-y-auto">
        {activeTab === 'overview' && (
          <div className="space-y-8">
            <div>
              <h2 className="text-3xl font-black italic uppercase tracking-tighter mb-2">
                Team Dashboard
              </h2>
              <p className="text-white/40">Manage {myTeam.name}</p>
            </div>

            {/* Team Stats */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <div className="glass rounded-2xl p-5 text-center">
                <Trophy size={20} className="mx-auto text-yellow-500 mb-2" />
                <p className="text-2xl font-black italic">#{teamStats.position}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">Position</p>
              </div>
              <div className="glass rounded-2xl p-5 text-center">
                <p className="text-2xl font-black italic text-brand-green">{teamStats.wins}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">Wins</p>
              </div>
              <div className="glass rounded-2xl p-5 text-center">
                <p className="text-2xl font-black italic text-yellow-500">{teamStats.draws}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">Draws</p>
              </div>
              <div className="glass rounded-2xl p-5 text-center">
                <p className="text-2xl font-black italic text-brand-red">{teamStats.losses}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">Losses</p>
              </div>
              <div className="glass rounded-2xl p-5 text-center">
                <p className="text-2xl font-black italic text-brand-blue">{teamStats.goalsFor}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">GF</p>
              </div>
              <div className="glass rounded-2xl p-5 text-center">
                <p className="text-2xl font-black italic text-purple-500">{teamStats.goalsAgainst}</p>
                <p className="text-[10px] text-white/40 uppercase tracking-widest">GA</p>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
               <div className="lg:col-span-2">
                 <div className="flex items-center justify-between mb-4">
                    <h3 className="font-black italic uppercase tracking-widest text-sm">Squad Management</h3>
                    <button className="flex items-center gap-2 bg-yellow-500 text-black px-4 py-1.5 rounded-lg font-black uppercase text-[10px] tracking-widest">
                       <UserPlus size={14} /> Add Player
                    </button>
                 </div>
                 <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-white/5 text-[10px] font-black uppercase tracking-widest text-white/30">
                          <th className="px-6 py-4">Player</th>
                          <th className="px-6 py-4">Position</th>
                          <th className="px-6 py-4 text-center">Goals</th>
                          <th className="px-6 py-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {myPlayers.map(player => (
                          <tr key={player.id} className="hover:bg-white/[0.02] transition-colors group">
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center font-black text-[10px]">
                                  {player.name[0]}
                                </div>
                                <span className="font-bold text-sm">{player.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                               <span className="text-[10px] font-black uppercase text-white/40 tracking-widest">{player.position}</span>
                            </td>
                            <td className="px-6 py-4 text-center font-black text-brand-green">{player.goals}</td>
                            <td className="px-6 py-4 text-right">
                               <button className="p-2 hover:text-white text-white/20 transition-colors">
                                 <Settings size={14} />
                               </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                 </div>
               </div>

               <div className="space-y-6">
                 <h3 className="font-black italic uppercase tracking-widest text-sm px-2">Upcoming Schedule</h3>
                 <div className="space-y-4">
                    {myMatches.filter(m => m.status === 'scheduled').map(match => (
                      <div key={match.id} className="glass rounded-2xl p-6 border border-white/5">
                         <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-4">{match.competition}</p>
                         <div className="flex items-center justify-between">
                            <span className="font-black italic text-sm">{match.homeTeam.shortName}</span>
                            <div className="bg-white/5 px-3 py-1 rounded-lg text-[10px] font-black uppercase">VS</div>
                            <span className="font-black italic text-sm">{match.awayTeam.shortName}</span>
                         </div>
                         <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                           <div className="flex items-center gap-2 text-white/40">
                             <Calendar size={12} />
                             <span className="text-[10px] font-bold uppercase">{match.startTime.split('T')[0]}</span>
                           </div>
                           <button className="text-[10px] font-black uppercase text-yellow-500 hover:underline">Details</button>
                         </div>
                      </div>
                    ))}
                 </div>
               </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
