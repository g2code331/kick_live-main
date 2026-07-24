import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import Loading from "../components/Loading";
import { supabase } from "../lib/supabase";

export default function MatchesPage() {
  const navigate = useNavigate();
  const [matches, setMatches] = useState<any[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadMatches();
    
    // Poll for live match updates every 10 seconds
    const pollInterval = setInterval(() => {
      if (filter === 'live' || filter === 'all') {
        loadMatches();
      }
    }, 10000);
    
    return () => clearInterval(pollInterval);
  }, [filter]);

  async function loadMatches() {
    try {
      let query = supabase
        .from('matches')
        .select(`
          id,
          home_score,
          away_score,
          status,
          minute,
          start_time,
          competition_id,
          homeTeam:teams!home_team_id(name, short_name),
          awayTeam:teams!away_team_id(name, short_name),
          competitions(name)
        `)
        .order('start_time', { ascending: false });
      
      if (filter === 'live') {
        query = query.in('status', ['first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout', 'live']);
      } else if (filter === 'scheduled') {
        query = query.eq('status', 'scheduled');
      } else if (filter === 'finished') {
        query = query.in('status', ['full_time', 'completed', 'finished']);
      }
      
      const { data, error } = await query.limit(50);
      
      if (error) throw error;
      setMatches(data || []);
    } catch (err) {
      console.error('Matches load error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <Loading text="Loading Matches..." size="md" />;

  const filteredMatches = matches;

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Header />
      <div className="container mx-auto px-4 py-8 relative z-10">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black italic uppercase tracking-tighter">Fixtures & Results</h1>
            <p className="text-white/40 text-sm mt-1">Real-time match updates</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', 'live', 'scheduled', 'finished'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 sm:px-4 py-2 rounded-xl font-black uppercase text-xs tracking-widest whitespace-nowrap ${
                  filter === f ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:text-white'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {filteredMatches.map((match) => (
            <div 
              key={match.id} 
              className="glass rounded-xl p-4 border border-white/10 hover:border-brand-green/30 transition-all cursor-pointer"
              onClick={() => navigate(`/match/${match.id}`)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-white/40 uppercase truncate">{match.competitions?.[0]?.name || 'Competition'}</span>
                <span className={`text-[10px] font-bold ${
                  ['live', 'first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout'].includes(match.status) ? 'text-brand-green' : 'text-white/40'
                }`}>
                  {['live', 'first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout'].includes(match.status) ? `${match.minute || 0}'` : 
                   match.status === 'finished' || match.status === 'full_time' || match.status === 'completed' ? 'FT' : 
                   new Date(match.start_time).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div 
                  className="text-center flex-1 cursor-pointer" 
                  onClick={(e) => { e.stopPropagation(); navigate(`/team/${match.homeTeam?.id}`); }}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-green/20 to-brand-blue/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                    {match.homeTeam?.short_name?.[0] || 'H'}
                  </div>
                  <p className="text-[10px] text-white/60 truncate hover:text-brand-green transition-colors">{match.homeTeam?.name || 'Home'}</p>
                </div>
                <div className="text-center px-3">
                  <p className="text-2xl font-black text-brand-green">{match.home_score ?? '-'} - {match.away_score ?? '-'}</p>
                </div>
                <div 
                  className="text-center flex-1 cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); navigate(`/team/${match.awayTeam?.id}`); }}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-blue/20 to-brand-green/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                    {match.awayTeam?.short_name?.[0] || 'A'}
                  </div>
                  <p className="text-[10px] text-white/60 truncate hover:text-brand-green transition-colors">{match.awayTeam?.name || 'Away'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filteredMatches.length === 0 && (
          <div className="glass rounded-2xl p-20 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
              <span className="text-3xl"></span>
            </div>
            <p className="text-white/40 text-lg">No matches found</p>
          </div>
        )}
      </div>
    </div>
  );
}
