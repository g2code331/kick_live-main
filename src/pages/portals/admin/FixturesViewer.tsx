import { useState, useEffect } from 'react';
import { X, Calendar, MapPin, Edit2, Search, Filter, Loader2, Play, RotateCcw, Save }  from 'lucide-react';
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
  const [editMatch, setEditMatch] = useState<any>(null);
  const [editForm, setEditForm] = useState({ home_team_id: '', away_team_id: '', start_time: '', venue: '' });

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
    const password = window.prompt('Enter pairing management password');
    if (password !== 'jojOjo') { if (password !== null) alert('Incorrect password'); return; }
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

  const handleMatchStatus = async (match: any, nextStatus: string) => {
    const password = window.prompt('Enter match management password');
    if (password !== 'jojOjo') { if (password !== null) alert('Incorrect password'); return; }
    const payload: any = { status: nextStatus };
    if (nextStatus === 'first_half') {
      payload.match_start_time = new Date().toISOString();
      payload.elapsed_seconds_before_pause = 0;
    }
    const { error } = await supabase.from('matches').update(payload).eq('id', match.id);
    if (error) { alert('Could not update match: ' + error.message); return; }
    loadFixtures();
  };

  const handleEditMatch = (match: any) => {
    const password = window.prompt('Enter pairing management password');
    if (password !== 'jojOjo') { if (password !== null) alert('Incorrect password'); return; }
    setEditMatch(match);
    setEditForm({
      home_team_id: String(match.home_team_id),
      away_team_id: String(match.away_team_id),
      start_time: new Date(match.start_time).toISOString().slice(0, 16),
      venue: match.venue || '',
    });
  };

  const saveEditedMatch = async () => {
    if (!editMatch || editForm.home_team_id === editForm.away_team_id) {
      alert('Home and away teams must be different.');
      return;
    }
    const { error } = await supabase.from('matches').update({
      home_team_id: Number(editForm.home_team_id),
      away_team_id: Number(editForm.away_team_id),
      start_time: new Date(editForm.start_time).toISOString(),
      venue: editForm.venue || 'TBD',
    }).eq('id', editMatch.id);
    if (error) { alert('Could not save pairing: ' + error.message); return; }
    setEditMatch(null);
    loadFixtures();
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
                      {['scheduled', 'waiting', 'postponed'].includes(match.status) && <button onClick={() => handleMatchStatus(match, 'first_half')} title="Kick off match" className="px-3 h-10 rounded-xl bg-brand-green/10 text-brand-green text-[10px] font-black uppercase hover:bg-brand-green hover:text-black transition-all">Kick Off</button>}
                      {!['full_time', 'completed', 'cancelled'].includes(match.status) && <button onClick={() => handleMatchStatus(match, 'cancelled')} title="Remove from schedule" className="px-3 h-10 rounded-xl bg-red-500/10 text-red-400 text-[10px] font-black uppercase hover:bg-red-500 hover:text-white transition-all">Cancel</button>}
                      <button
                        onClick={() => handleEditMatch(match)}
                        aria-label="Edit pairing"
                        title="Edit pairing (password protected)"
                        className="w-10 h-10 rounded-xl bg-brand-blue/10 text-brand-blue flex items-center justify-center hover:bg-brand-blue hover:text-black transition-all"
                      ><Edit2 size={16} /></button>
                      <button
                        onClick={() => {
                          setSelectedMatch(match);
                          setIsMatchControlOpen(true);
                        }}
                        aria-label="Open match control"
                        className="w-10 h-10 rounded-xl bg-[#39FF14]/10 text-[#39FF14] flex items-center justify-center hover:bg-[#39FF14] hover:text-black transition-all"
                      ><Play size={18} /></button>
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

      {editMatch && (
        <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setEditMatch(null)} />
          <div className="relative w-full max-w-lg glass rounded-3xl border border-brand-blue/30 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-6"><h3 className="text-lg font-black uppercase">Edit Pairing</h3><button onClick={() => setEditMatch(null)} className="p-2 hover:bg-white/10 rounded-lg"><X size={18} /></button></div>
            <div className="space-y-4">
              <label className="block text-xs font-black uppercase text-white/50">Home team<select value={editForm.home_team_id} onChange={e => setEditForm(f => ({ ...f, home_team_id: e.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 p-3">{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
              <label className="block text-xs font-black uppercase text-white/50">Away team<select value={editForm.away_team_id} onChange={e => setEditForm(f => ({ ...f, away_team_id: e.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 p-3">{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
              <label className="block text-xs font-black uppercase text-white/50">Date and time<input type="datetime-local" value={editForm.start_time} onChange={e => setEditForm(f => ({ ...f, start_time: e.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 p-3" /></label>
              <label className="block text-xs font-black uppercase text-white/50">Venue<input value={editForm.venue} onChange={e => setEditForm(f => ({ ...f, venue: e.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 p-3" placeholder="TBD" /></label>
              <button onClick={saveEditedMatch} className="w-full rounded-xl bg-brand-green py-3 font-black uppercase text-black flex items-center justify-center gap-2"><Save size={16} /> Save pairing</button>
            </div>
          </div>
        </div>
      )}

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
