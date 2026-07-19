import { useState, useEffect } from 'react';
import { X, Calendar, MapPin, Edit2, Search, Filter, Loader2, Play, RotateCcw } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { CompetitionEngine } from '../../../lib/CompetitionEngine';
import MatchControlComplete from './MatchControlComplete';

interface FixturesViewerProps {
  competition: any;
  isOpen: boolean;
  onClose: () => void;
}

export default function FixturesViewer({ competition, isOpen, onClose }: FixturesViewerProps) {
  const [fixtures, setFixtures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [isMatchControlOpen, setIsMatchControlOpen] = useState(false);
  const [isReshuffling, setIsReshuffling] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);

  useEffect(() => {
    if (isOpen && competition) {
      loadFixtures();
      loadTeams();
    }
  }, [isOpen, competition]);

  async function loadTeams() {
    const { data } = await supabase.from('teams').select('id, name, short_name');
    setTeams(data || []);
  }

  async function loadFixtures() {
    setLoading(true);
    try {
      const { data: matchesData, error: matchesError } = await supabase
        .from('matches')
        .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, start_time')
        .eq('competition_id', competition.id)
        .order('start_time', { ascending: true });

      if (matchesError) throw matchesError;

      if (!matchesData || matchesData.length === 0) {
        setFixtures([]);
        return;
      }

      const teamIds = Array.from(new Set([
        ...matchesData.map(m => m.home_team_id),
        ...matchesData.map(m => m.away_team_id)
      ]));

      const { data: teamsData } = await supabase
        .from('teams')
        .select('id, name, short_name')
        .in('id', teamIds);

      const teamsMap = new Map(teamsData?.map(t => [t.id, t]));

      const combinedFixtures = matchesData.map(match => ({
        ...match,
        homeTeam: teamsMap.get(match.home_team_id),
        awayTeam: teamsMap.get(match.away_team_id)
      }));

      setFixtures(combinedFixtures);
    } catch (err) {
      console.error('Error loading fixtures:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleReshuffle = async () => {
    if (!confirm('Are you sure you want to reshuffle fixtures? This will delete all existing fixtures and generate new ones.')) return;
    
    setIsReshuffling(true);
    try {
      // Delete existing fixtures
      await supabase.from('matches').delete().eq('competition_id', competition.id);
      
      // Get teams in this competition
      const teamIdsInComp = Array.from(new Set(fixtures.map(f => [f.home_team_id, f.away_team_id]).flat()));
      const selectedTeamsList = teams.filter(t => teamIdsInComp.includes(t.id));
      
      if (selectedTeamsList.length < 2) {
        alert('Not enough teams to generate fixtures');
        setIsReshuffling(false);
        return;
      }
      
      // Generate new fixtures
      const newFixtures = CompetitionEngine.create(
        competition.type || 'league',
        selectedTeamsList,
        {
          rounds: 'single',
          pointsWin: 3,
          pointsDraw: 1,
          pointsLoss: 0,
          startDate: competition.start_date || new Date().toISOString().split('T')[0],
          endDate: competition.end_date || new Date(Date.now() + 31536000000).toISOString().split('T')[0],
          matchDays: ['Saturday', 'Sunday'],
          kickoffTimes: ['15:00', '18:00'],
          restDays: 3
        } as any,
        competition.id
      );
      
      if (newFixtures && newFixtures.length > 0) {
        const { error } = await supabase.from('matches').insert(newFixtures);
        if (error) throw error;
        
        alert(`Fixtures reshuffled! Generated ${newFixtures.length} new fixtures.`);
        loadFixtures();
      }
    } catch (err: any) {
      alert('Error reshuffling: ' + err.message);
    } finally {
      setIsReshuffling(false);
    }
  };

  const filteredFixtures = fixtures.filter(f => 
    f.homeTeam?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    f.awayTeam?.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      
      <div className="relative w-full max-w-5xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-500">
        
        {/* Header */}
        <div className="p-10 border-b border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-[#39FF14]/10 rounded-2xl flex items-center justify-center text-[#39FF14]">
              <Calendar size={28} />
            </div>
            <div>
              <h2 className="text-2xl font-black italic uppercase tracking-tighter">{competition?.name}</h2>
              <p className="text-xs text-white/40 uppercase tracking-widest font-black">Tournament Fixtures</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
              <input 
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search teams..."
                className="bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-[#39FF14]/50 w-64"
              />
            </div>
            <button 
              onClick={handleReshuffle}
              disabled={isReshuffling || fixtures.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-bold uppercase tracking-widest transition-all disabled:opacity-50"
            >
              <RotateCcw size={14} className={isReshuffling ? 'animate-spin' : ''} /> Reshuffle
            </button>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X /></button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-10 no-scrollbar">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
               <Loader2 className="animate-spin text-[#39FF14]" size={32} />
               <p className="text-xs font-black uppercase tracking-widest text-white/20">Loading Fixtures...</p>
            </div>
          ) : filteredFixtures.length > 0 ? (
            <div className="grid grid-cols-1 gap-4">
              {filteredFixtures.map((match) => (
                <div key={match.id} className="glass-light p-6 rounded-3xl border border-white/5 hover:border-white/10 transition-all flex items-center justify-between group">
                   <div className="flex items-center gap-8 flex-1">
                      <div className="text-right w-1/3">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">{match.homeTeam?.short_name}</p>
                        <p className="font-bold text-sm truncate">{match.homeTeam?.name}</p>
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <div className="bg-white/5 px-6 py-2 rounded-2xl border border-white/5 font-black italic text-lg">
                           {match.status === 'finished' ? `${match.home_score} - ${match.away_score}` : 'VS'}
                        </div>
                        <span className={`text-[8px] font-black uppercase tracking-widest ${match.status === 'live' ? 'text-[#39FF14]' : 'text-white/20'}`}>
                          {match.status}
                        </span>
                      </div>
                      <div className="text-left w-1/3">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">{match.awayTeam?.short_name}</p>
                        <p className="font-bold text-sm truncate">{match.awayTeam?.name}</p>
                      </div>
                   </div>

                   <div className="flex items-center gap-6 pl-8 border-l border-white/5">
                      <div className="hidden md:block">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest flex items-center gap-1"><MapPin size={10}/> {match.venue || 'TBD'}</p>
                        <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mt-1">{new Date(match.start_time).toLocaleDateString()}</p>
                      </div>
                      <button 
                        onClick={() => {
                          setSelectedMatch(match);
                          setIsMatchControlOpen(true);
                        }}
                        className="w-10 h-10 rounded-xl bg-[#39FF14]/10 text-[#39FF14] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-[#39FF14] hover:text-black"
                      >
                         <Play size={18} />
                      </button>
                   </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-20">
               <p className="text-white/20 font-black uppercase tracking-[0.3em]">No fixtures found</p>
               {fixtures.length === 0 && (
                 <p className="text-white/40 text-sm mt-2">Fixtures will be auto-generated when competition is created</p>
               )}
            </div>
          )}
        </div>
      </div>

      {isMatchControlOpen && (
        <MatchControlComplete 
          match={selectedMatch} 
          isOpen={isMatchControlOpen} 
          onClose={() => setIsMatchControlOpen(false)} 
          onUpdate={loadFixtures}
        />
      )}
    </div>
  );
}
