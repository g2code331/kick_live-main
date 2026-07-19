import { useState, useEffect } from 'react';
import { Trophy, Play } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import MatchControlPro from './MatchControlPro';

export default function MatchControlOrganized() {
  const [competitions, setCompetitions] = useState<any[]>([]);
  const [selectedCompetition, setSelectedCompetition] = useState<any>(null);
  const [matchesByCompetition, setMatchesByCompetition] = useState<any>({});
  const [loading, setLoading] = useState(true);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  
  useEffect(() => {
    loadCompetitions();
  }, []);
  
  useEffect(() => {
    if (selectedCompetition) {
      loadMatches();
    }
  }, [selectedCompetition]);

  async function loadCompetitions() {
    try {
      const { data } = await supabase
        .from('competitions')
        .select('*')
        .order('created_at', { ascending: false });
      setCompetitions(data || []);
      if (data && data.length > 0) {
        setSelectedCompetition(data[0]);
      }
    } catch (err) {
      console.error('Error loading competitions:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMatches() {
    if (!selectedCompetition) return;
    
    try {
      const { data } = await supabase
        .from('matches')
        .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*)')
        .eq('competition_id', selectedCompetition.id)
        .order('start_time', { ascending: false });
      
      setMatchesByCompetition((prev: any) => ({
        ...prev,
        [selectedCompetition.id]: data || []
      }));
    } catch (err) {
      console.error('Error loading matches:', err);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-[#0B0E13] p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-black italic uppercase mb-2">Match Control</h1>
            <p className="text-white/40">Organized by competition</p>
          </div>
        </div>
        
        {/* Competition Selector */}
        <div className="glass rounded-2xl p-6 mb-8 border border-white/10">
          <div className="flex items-center gap-4 mb-4">
            <Trophy className="text-brand-green" size={24} />
            <h2 className="text-lg font-black uppercase">Select Competition</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {competitions.map(comp => (
              <button
                key={comp.id}
                onClick={() => setSelectedCompetition(comp)}
                className={`p-4 rounded-xl border transition-all text-left ${
                  selectedCompetition?.id === comp.id
                    ? 'border-brand-green bg-brand-green/10'
                    : 'border-white/10 bg-white/5 hover:border-white/20'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold">{comp.name}</span>
                  <span className="text-xs text-white/40">{comp.season || '2025'}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-white/40">Format</span>
                  <span>{comp.format || comp.type || 'League'}</span>
                </div>
                <div className="flex items-center justify-between text-xs mt-2">
                  <span className="text-white/40">Status</span>
                  <span className={`px-2 py-0.5 rounded ${
                    comp.status === 'live' ? 'bg-brand-green text-black' : 'bg-white/10'
                  }`}>
                    {comp.status || 'upcoming'}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
        
        {/* Matches by Competition */}
        {selectedCompetition && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-black uppercase">
                {selectedCompetition.name} - Matches ({matchesByCompetition[selectedCompetition.id]?.length || 0})
              </h2>
            </div>
            
            {matchesByCompetition[selectedCompetition.id]?.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {matchesByCompetition[selectedCompetition.id].map((match: any) => (
                  <div
                    key={match.id}
                    onClick={() => setSelectedMatch(match)}
                    className="glass rounded-xl p-4 border border-white/10 hover:border-brand-green/30 transition-all cursor-pointer group"
                  >
                    {/* Status */}
                    <div className="flex items-center justify-between mb-3">
                      <span className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-widest ${
                        match.status === 'live' || match.status === 'first_half' || match.status === 'second_half'
                          ? 'bg-brand-red text-white animate-pulse'
                          : match.status === 'finished' || match.status === 'full_time'
                          ? 'bg-white/10 text-white/40'
                          : 'bg-brand-blue/10 text-brand-blue'
                      }`}>
                        {match.status === 'live' || match.status === 'first_half' || match.status === 'second_half'
                          ? 'LIVE'
                          : match.status === 'finished' || match.status === 'full_time'
                          ? 'FT'
                          : match.status || 'SCHEDULED'}
                      </span>
                      <span className="text-xs text-white/40">{match.minute || 0}'</span>
                    </div>
                    
                    {/* Teams with Logos */}
                    <div className="flex items-center justify-between mb-3">
                      {/* Home Team */}
                      <div className="text-center flex-1">
                        <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-xl font-black italic mx-auto mb-2">
                          {match.homeTeam?.short_name?.[0] || 'H'}
                        </div>
                        <p className="text-xs font-bold truncate">{match.homeTeam?.name || 'Home Team'}</p>
                        <p className="text-[10px] text-white/40">{match.homeTeam?.city || ''}</p>
                      </div>
                      <div className="text-center px-4">
                        <p className="text-xl font-bold">{match.home_score ?? 0}</p>
                      </div>
                      
                      {/* Away Team */}
                      <div className="text-center flex-1">
                        <div className="w-12 h-12 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-xl font-black italic mx-auto mb-2">
                          {match.awayTeam?.short_name?.[0] || 'A'}
                        </div>
                        <p className="text-xs font-bold truncate">{match.awayTeam?.name || 'Away Team'}</p>
                        <p className="text-[10px] text-white/40">{match.awayTeam?.city || ''}</p>
                      </div>
                      <div className="text-center px-4">
                        <p className="text-xl font-bold">{match.away_score ?? 0}</p>
                      </div>
                    </div>
                    
                    {/* Control Button */}
                    <button className="w-full mt-3 py-2 rounded-lg bg-white/5 hover:bg-brand-green/20 text-white/40 hover:text-brand-green transition-all text-xs font-black uppercase tracking-widest flex items-center justify-center gap-2">
                      <Play size={12} /> Control Match
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="glass rounded-2xl p-12 text-center">
                <Trophy size={64} className="mx-auto text-white/10 mb-4" />
                <p className="text-white/30 font-bold uppercase tracking-widest">No matches yet</p>
                <p className="text-white/40 text-sm">Create fixtures for this competition first</p>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedMatch && (
        <MatchControlPro 
          match={selectedMatch}
          isOpen={true}
          onClose={() => setSelectedMatch(null)}
          onUpdate={loadMatches}
        />
      )}
    </div>
  );
}
