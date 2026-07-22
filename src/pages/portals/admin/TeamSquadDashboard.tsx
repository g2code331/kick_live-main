import { useState, useEffect } from 'react';
import { ArrowLeft, Users, Plus, Edit, Trash2, Search, Filter, Activity, Trophy, Star } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import PlayerCreator from '../shared/PlayerCreator';

interface TeamSquadDashboardProps {
  team: any;
  onBack: () => void;
}

export default function TeamSquadDashboard({ team, onBack }: TeamSquadDashboardProps) {
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [positionFilter, setPositionFilter] = useState('all');
  const [showPlayerCreator, setShowPlayerCreator] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<any>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    loadPlayers();
  }, [team?.id]);

  async function loadPlayers() {
    setLoading(true);
    try {
      // Only fetch necessary columns, limit to 100 players
      const { data } = await supabase
        .from('players')
        .select('id, name, number, position, nationality, goals, assists, created_at, team_id')
        .eq('team_id', team.id)
        .order('number')
        .limit(100);
      setPlayers(data || []);
    } catch (err) {
      console.error('Error loading players:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleDeletePlayer = async (playerId: number) => {
    if (!confirm('Are you sure you want to delete this player?')) return;
    
    try {
      await supabase.from('players').delete().eq('id', playerId);
      alert('Player deleted successfully!');
      loadPlayers();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const handleEditPlayer = (player: any) => {
    setSelectedPlayer(player);
    setShowEditModal(true);
  };

  const filteredPlayers = players.filter(player => {
    const matchesSearch = player.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesPosition = positionFilter === 'all' || player.position.toLowerCase() === positionFilter.toLowerCase();
    return matchesSearch && matchesPosition;
  });

  const positionCounts = {
    all: players.length,
    goalkeeper: players.filter(p => p.position.toLowerCase().includes('goal')).length,
    defender: players.filter(p => p.position.toLowerCase().includes('defend')).length,
    midfielder: players.filter(p => p.position.toLowerCase().includes('mid')).length,
    forward: players.filter(p => p.position.toLowerCase().includes('forward') || p.position.toLowerCase().includes('striker')).length
  };

  const totalGoals = players.reduce((sum, p) => sum + (p.goals || 0), 0);
  const totalAssists = players.reduce((sum, p) => sum + (p.assists || 0), 0);

  return (
    <div className="min-h-screen bg-[#0B0E13]">
      {/* Header */}
      <div className="glass border-b border-white/10 px-8 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-white/10 rounded-lg">
            <ArrowLeft size={24} className="text-white" />
          </button>
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl font-black italic shadow-2xl" style={{
              background: `linear-gradient(135deg, ${team.primary_color || team.primaryColor}, ${team.secondary_color || team.secondaryColor})`,
              color: (team.secondary_color || team.secondaryColor || '#666') === '#000000' ? '#000' : '#fff'
            }}>
              {team.short_name[0]}
            </div>
            <div>
              <h1 className="text-2xl font-black italic uppercase tracking-tighter">{team.name}</h1>
              <p className="text-xs text-white/40">{team.city || 'Unknown'} • Squad Dashboard</p>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setShowPlayerCreator(true)}
          className="gradient-green text-black px-6 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2 hover:scale-105 transition-transform"
        >
          <Plus size={16} /> Add Player
        </button>
      </div>

      <div className="p-8 max-w-[1800px] mx-auto">
        {/* Team Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-6 mb-8">
          <div className="glass rounded-2xl p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-3">
              <Users size={24} className="text-brand-green" />
              <p className="text-xs text-white/40 uppercase">Total Players</p>
            </div>
            <p className="text-4xl font-black text-brand-green">{players.length}</p>
          </div>
          <div className="glass rounded-2xl p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-3">
              <Activity size={24} className="text-brand-blue" />
              <p className="text-xs text-white/40 uppercase">Total Goals</p>
            </div>
            <p className="text-4xl font-black text-brand-blue">{totalGoals}</p>
          </div>
          <div className="glass rounded-2xl p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-3">
              <Trophy size={24} className="text-yellow-500" />
              <p className="text-xs text-white/40 uppercase">Total Assists</p>
            </div>
            <p className="text-4xl font-black text-yellow-500">{totalAssists}</p>
          </div>
          <div className="glass rounded-2xl p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-3">
              <Star size={24} className="text-purple-500" />
              <p className="text-xs text-white/40 uppercase">Top Scorer</p>
            </div>
            <p className="text-2xl font-black text-purple-500 truncate">
              {players.length > 0 ? players.reduce((max, p) => (p.goals || 0) > (max.goals || 0) ? p : max).name : 'N/A'}
            </p>
          </div>
          <div className="glass rounded-2xl p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-3">
              <Filter size={24} className="text-brand-red" />
              <p className="text-xs text-white/40 uppercase">Avg Age</p>
            </div>
            <p className="text-4xl font-black text-brand-red">--</p>
          </div>
        </div>

        {/* Filters */}
        <div className="glass rounded-2xl p-6 border border-white/10 mb-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
                <input 
                  type="text"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search players..."
                  className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-brand-green/50"
                />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {['all', 'goalkeeper', 'defender', 'midfielder', 'forward'].map(pos => (
                <button
                  key={pos}
                  onClick={() => setPositionFilter(pos)}
                  className={`px-4 py-2 rounded-xl font-black uppercase tracking-widest text-xs transition-all ${
                    positionFilter === pos
                      ? 'bg-brand-green text-black'
                      : 'bg-white/5 text-white/40 hover:bg-white/10'
                  }`}
                >
                  {pos} ({positionCounts[pos as keyof typeof positionCounts]})
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Players Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-brand-green font-bold uppercase">Loading Squad...</p>
            </div>
          </div>
        ) : filteredPlayers.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredPlayers.map((player, i) => (
              <div key={player.id} className="glass rounded-[2rem] p-6 border border-white/10 hover:border-brand-green/30 transition-all group">
                <div className="flex items-start justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-20 h-20 rounded-2xl bg-white/5 flex items-center justify-center text-4xl font-black italic">
                      {player.number}
                    </div>
                    <div>
                      <h3 className="text-xl font-black italic uppercase">{player.name}</h3>
                      <p className="text-xs text-white/40 uppercase">{player.position} • {player.nationality || 'Unknown'}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 opacity-100 transition-opacity">
                    <button
                      type="button"
                      aria-label={`Edit ${player.name}`}
                      title="Edit player"
                      onClick={() => handleEditPlayer(player)}
                      className="p-2.5 bg-brand-blue/15 text-brand-blue hover:bg-brand-blue/25 rounded-lg transition-colors"
                    >
                      <Edit size={16} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${player.name}`}
                      title="Delete player"
                      onClick={() => handleDeletePlayer(player.id)}
                      className="p-2.5 bg-brand-red/10 hover:bg-brand-red/20 text-brand-red rounded-lg transition-colors"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-white/5 rounded-xl p-4 text-center">
                    <p className="text-2xl font-black text-brand-green">{player.goals || 0}</p>
                    <p className="text-[10px] text-white/40 uppercase">Goals</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4 text-center">
                    <p className="text-2xl font-black text-brand-blue">{player.assists || 0}</p>
                    <p className="text-[10px] text-white/40 uppercase">Assists</p>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-6 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-brand-green"></div>
                    <span className="text-xs text-white/40 uppercase">Active</span>
                  </div>
                  <span className="text-xs text-white/40">Joined {new Date(player.created_at).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-20">
            <Users size={96} className="mx-auto text-white/5 mb-6" />
            <p className="text-white/30 font-bold uppercase tracking-widest mb-2">No players found</p>
            <p className="text-white/40 text-sm">
              {searchTerm || positionFilter !== 'all' 
                ? 'Try adjusting your filters'
                : 'Add players to build your squad'}
            </p>
          </div>
        )}
      </div>

      {/* Player Creator Modal */}
      {showPlayerCreator && (
        <PlayerCreator
          isOpen={showPlayerCreator}
          onClose={() => {
            setShowPlayerCreator(false);
            loadPlayers();
          }}
          teamId={team.id}
        />
      )}

      {/* Edit Player Modal */}
      {showEditModal && selectedPlayer && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowEditModal(false)}></div>
          <div className="relative w-full max-w-2xl glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-white/10 flex items-center justify-between sticky top-0 bg-[#0B0E13]">
              <h2 className="text-xl font-black uppercase">Edit Player</h2>
              <button onClick={() => setShowEditModal(false)} className="p-2 hover:bg-white/10 rounded-lg"><Edit size={20} /></button>
            </div>
            
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Player Name</label>
                  <input
                    type="text"
                    defaultValue={selectedPlayer.name}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Jersey Number</label>
                  <input
                    type="number"
                    defaultValue={selectedPlayer.number}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Position</label>
                  <input
                    type="text"
                    defaultValue={selectedPlayer.position}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Nationality</label>
                  <input
                    type="text"
                    defaultValue={selectedPlayer.nationality}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Goals</label>
                  <input
                    type="number"
                    defaultValue={selectedPlayer.goals || 0}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Assists</label>
                  <input
                    type="number"
                    defaultValue={selectedPlayer.assists || 0}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>
            </div>

            <div className="p-6 border-t border-white/10 flex gap-4">
              <button
                onClick={() => setShowEditModal(false)}
                className="flex-1 py-3 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  alert('Edit functionality coming soon!');
                  setShowEditModal(false);
                }}
                className="flex-1 py-3 rounded-xl gradient-green text-black font-black uppercase tracking-widest flex items-center justify-center gap-2"
              >
                <Edit size={16} /> Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
