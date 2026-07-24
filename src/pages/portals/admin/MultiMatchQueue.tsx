import { useState, useEffect } from 'react';
import { Play, Pause, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import MatchControlFull from './MatchControlFull';

export default function MultiMatchQueue() {
  const [matches, setMatches] = useState<any[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Load matches on mount and set up real-time polling every 5 seconds
  useEffect(() => {
    loadMatches();
    
    // Poll for match updates every 5 seconds for real-time sync
    const pollInterval = setInterval(() => {
      loadMatches();
    }, 5000);
    
    return () => clearInterval(pollInterval);
  }, []);

  async function loadMatches() {
    try {
      // Only fetch necessary columns, limit to 100 matches max
      const { data, error } = await supabase
        .from('matches')
        .select('id, home_team_id, away_team_id, home_score, away_score, status, start_time, minute, competition_id, homeTeam:teams!home_team_id(short_name, name), awayTeam:teams!away_team_id(short_name, name)')
        .order('start_time', { ascending: false })
        .limit(100);
      
      if (error) throw error;
      setMatches(data || []);
    } catch (err) {
      console.error('Error loading matches:', err);
    } finally {
      setLoading(false);
    }
  }

  // Proper status filtering for time-sensitive match states
  const liveMatches = matches.filter(m => 
    m.status === 'first_half' || 
    m.status === 'half_time' ||
    m.status === 'second_half' ||
    m.status === 'extra_time' ||
    m.status === 'penalty_shootout' ||
    m.status === 'live'
  );
  
  const upcomingMatches = matches.filter(m => 
    m.status === 'scheduled' || 
    m.status === 'waiting'
  );
  
  const finishedMatches = matches.filter(m => 
    m.status === 'completed' ||
    m.status === 'full_time' || 
    m.status === 'finished'
  );

  if (selectedMatch) {
    return <MatchControlFull match={selectedMatch} onBack={() => setSelectedMatch(null)} />;
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'live':
      case 'first_half':
      case 'second_half':
      case 'half_time':
      case 'extra_time':
      case 'penalty_shootout':
        return <AlertCircle size={16} className="text-brand-red animate-pulse" />;
      case 'finished':
      case 'full_time':
        return <CheckCircle size={16} className="text-brand-green" />;
      default:
        return <Clock size={16} className="text-brand-blue" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Queue...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0E13] p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-black italic uppercase mb-2">Multi-Match Queue</h1>
          <p className="text-white/40">Manage multiple matches simultaneously</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Live Matches */}
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center gap-4 mb-4">
              <AlertCircle size={20} className="text-brand-red" />
              <h2 className="text-xl font-black uppercase">Live Matches ({liveMatches.length})</h2>
            </div>
            
            {liveMatches.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {liveMatches.map(match => (
                  <div
                    key={match.id}
                    onClick={() => setSelectedMatch(match)}
                    className={`glass rounded-xl p-4 border cursor-pointer transition-all hover:scale-[1.02] ${
                      selectedMatch?.id === match.id ? 'border-brand-green bg-brand-green/10' : 'border-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(match.status)}
                        <div>
                          <p className="text-xs font-bold">{match.homeTeam?.short_name || 'HOME'}</p>
                          <p className="text-lg font-black">{match.home_score ?? 0}</p>
                        </div>
                        <div className="text-white/40">-</div>
                        <div>
                          <p className="text-lg font-black">{match.away_score ?? 0}</p>
                          <p className="text-xs font-bold">{match.awayTeam?.short_name || 'AWAY'}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold">
                          {['live', 'first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout'].includes(match.status)
                            ? `${match.minute}'`
                            : match.status}
                        </p>
                        <p className="text-[10px] text-white/40">{match.competition || 'Competition'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="glass rounded-xl p-12 text-center">
                <Clock size={48} className="mx-auto text-white/10 mb-4" />
                <p className="text-white/30 font-bold uppercase tracking-widest">No live matches at the moment</p>
              </div>
            )}
            
            {/* Upcoming Matches */}
            <div className="flex items-center gap-4 mb-4 mt-8">
              <Clock size={20} className="text-brand-blue" />
              <h2 className="text-xl font-black uppercase">Upcoming ({upcomingMatches.length})</h2>
            </div>
            
            {upcomingMatches.length > 0 ? (
              <div className="space-y-2">
                 {upcomingMatches.slice(0, 5).map(match => (
                   <div
                     key={match.id}
                     onClick={() => setSelectedMatch(match)}
                     className={`glass rounded-lg p-3 border cursor-pointer transition-all hover:bg-white/5 ${
                       selectedMatch?.id === match.id ? 'border-brand-green' : 'border-white/10'
                     }`}
                   >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(match.status)}
                        <span className="text-sm font-bold">{match.homeTeam?.short_name} vs {match.awayTeam?.short_name}</span>
                      </div>
                      <span className="text-xs text-white/40">
                        {new Date(match.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="glass rounded-xl p-8 text-center">
                <p className="text-white/30 text-sm">No upcoming matches</p>
              </div>
            )}
            
            {/* Recently Finished */}
            <div className="flex items-center gap-4 mb-4 mt-8">
              <CheckCircle size={20} className="text-brand-green" />
              <h2 className="text-xl font-black uppercase">Recently Finished ({finishedMatches.length})</h2>
            </div>
            
            {finishedMatches.length > 0 ? (
              <div className="space-y-2">
                 {finishedMatches.slice(0, 5).map(match => (
                   <div
                     key={match.id}
                     onClick={() => setSelectedMatch(match)}
                     className={`glass rounded-lg p-3 border cursor-pointer transition-all hover:bg-white/5 ${
                       selectedMatch?.id === match.id ? 'border-brand-green' : 'border-white/10'
                     }`}
                   >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(match.status)}
                        <span className="text-sm font-bold">
                          {match.homeTeam?.short_name} {match.home_score} - {match.away_score} {match.awayTeam?.short_name}
                        </span>
                      </div>
                      <span className="text-xs text-white/40">FT</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="glass rounded-xl p-8 text-center">
                <p className="text-white/30 text-sm">No finished matches</p>
              </div>
            )}
          </div>

          {/* Match Control Panel */}
          <div className="lg:col-span-1">
            <div className="glass rounded-[2rem] p-6 sticky top-8">
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Quick Controls</h3>
              <p className="text-white/40 text-sm text-center py-8">
                Select a match from the queue to control it
              </p>
            </div>
          </div>
        </div>
      </div>


    </div>
  );
}
