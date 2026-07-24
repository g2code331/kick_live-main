import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, Users, MessageSquare, Activity, TrendingUp, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function MatchDetails() {
  const { matchId } = useParams<{ matchId: string }>();
  const navigate = useNavigate();
  const [match, setMatch] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [lineups, setLineups] = useState<any>({ home: { players: [], formation: '4-3-3' }, away: { players: [], formation: '4-3-3' } });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (matchId) {
      loadMatchData();
      // Poll for live matches every 10 seconds
      const pollInterval = setInterval(() => {
        loadMatchData();
      }, 10000);
      return () => clearInterval(pollInterval);
    }
  }, [matchId]);

  async function loadMatchData() {
    try {
      // Fetch match details
      const { data: matchData } = await supabase
        .from('matches')
        .select(`
          *,
          homeTeam:teams!home_team_id(id, name, short_name, primary_color, secondary_color, lineup),
          awayTeam:teams!away_team_id(id, name, short_name, primary_color, secondary_color, lineup),
          competitions(name)
        `)
        .eq('id', matchId)
        .single();
      setMatch(matchData);

      // Fetch events
      const { data: eventsData } = await supabase
        .from('match_events')
        .select('*, player:players(name), team:teams(short_name)')
        .eq('match_id', matchId)
        .order('minute', { ascending: true });
      setEvents(eventsData || []);

      // Fetch commentary
      const { data: commentaryData } = await supabase
        .from('match_commentary')
        .select('*')
        .eq('match_id', matchId)
        .order('minute', { ascending: true });
      setCommentary(commentaryData || []);

      // Fetch statistics
      const { data: statsData } = await supabase
        .from('match_statistics')
        .select('*')
        .eq('match_id', matchId)
        .single();
      setStats(statsData);

      // Fetch lineups (players from both teams)
      if (matchData) {
        const { data: playersData } = await supabase
          .from('players')
          .select('id, name, number, position, team_id')
          .in('team_id', [matchData.home_team_id, matchData.away_team_id]);
        
        const fallbackHome = playersData?.filter((p: any) => p.team_id === matchData.home_team_id) || [];
        const fallbackAway = playersData?.filter((p: any) => p.team_id === matchData.away_team_id) || [];
        const readLineup = (team: any, fallback: any[]) => {
          try {
            const saved = typeof team?.lineup === 'string' ? JSON.parse(team.lineup) : team?.lineup;
            const players = Array.isArray(saved?.players) ? saved.players.filter(Boolean) : fallback;
            return { players: players.slice(0, 11), formation: saved?.formation || '4-3-3' };
          } catch { return { players: fallback.slice(0, 11), formation: '4-3-3' }; }
        };
        setLineups({ home: readLineup(matchData.homeTeam, fallbackHome), away: readLineup(matchData.awayTeam, fallbackAway) });
      }
    } catch (err) {
      console.error('Error loading match data:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Match...</p>
        </div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/40 text-xl">Match not found</p>
          <button onClick={() => navigate('/matches')} className="mt-4 text-brand-green hover:underline">Back to Matches</button>
        </div>
      </div>
    );
  }

  const isLive = match.status === 'first_half' || match.status === 'second_half' || match.status === 'extra_time' || match.status === 'live';

  return (
    <div className="min-h-screen pb-20">
      {/* Header */}
      <div className="glass border-b border-white/10 sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <button 
            onClick={() => navigate('/matches')}
            className="flex items-center gap-2 text-white/60 hover:text-white transition-colors mb-4"
          >
            <ArrowLeft size={20} /> Back to Matches
          </button>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4 flex-1">
              <div className="text-right">
                <p className="font-bold text-lg">{match.homeTeam?.name}</p>
                <p className="text-xs text-white/40">{match.homeTeam?.short_name}</p>
              </div>
              <div className="text-center px-6">
                <p className="text-4xl font-black text-brand-green">{match.home_score} - {match.away_score}</p>
                {isLive && (
                  <p className="text-xs text-brand-green flex items-center justify-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                    {match.minute}' LIVE
                  </p>
                )}
                {!isLive && (
                  <p className="text-xs text-white/40">{match.status === 'completed' || match.status === 'full_time' ? 'Full Time' : new Date(match.start_time).toLocaleString()}</p>
                )}
              </div>
              <div className="flex-1">
                <p className="font-bold text-lg">{match.awayTeam?.name}</p>
                <p className="text-xs text-white/40">{match.awayTeam?.short_name}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-8">
            {/* Events Timeline */}
            <div className="glass rounded-[2rem] p-6 border border-white/10">
              <div className="flex items-center gap-3 mb-6">
                <Activity size={24} className="text-brand-green" />
                <h2 className="text-2xl font-black uppercase">Match Events</h2>
              </div>
              {events.length > 0 ? (
                <div className="space-y-3">
                  {events.map((event, i) => (
                    <div key={event.id} className="flex items-center gap-4 p-4 rounded-xl bg-white/5">
                      <span className="text-lg font-black text-brand-green w-12">{event.minute}'</span>
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                        {event.event_type === 'goal' ? '⚽' : event.event_type === 'yellow_card' ? '🟨' : event.event_type === 'red_card' ? '' : '🔄'}
                      </div>
                      <div className="flex-1">
                        <p className="font-bold capitalize">{event.event_type.replace('_', ' ')}</p>
                        {event.player && (
                          <p className="text-sm text-white/60">{event.player.name} {event.team && `(${event.team.short_name})`}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-white/40">
                  <Activity size={48} className="mx-auto mb-4 opacity-20" />
                  <p>No events yet</p>
                </div>
              )}
            </div>

            {/* Commentary */}
            <div className="glass rounded-[2rem] p-6 border border-white/10">
              <div className="flex items-center gap-3 mb-6">
                <MessageSquare size={24} className="text-brand-blue" />
                <h2 className="text-2xl font-black uppercase">Live Commentary</h2>
              </div>
              {commentary.length > 0 ? (
                <div className="space-y-3 max-h-[400px] overflow-y-auto">
                  {commentary.map((comm) => (
                    <div key={comm.id} className="p-4 rounded-xl bg-white/5">
                      <span className="text-sm font-black text-brand-blue">{comm.minute}'</span>
                      <p className="text-sm mt-1">{comm.comment}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 text-white/40">
                  <MessageSquare size={48} className="mx-auto mb-4 opacity-20" />
                  <p>No commentary yet</p>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-8">
            {/* Lineups */}
            <div className="glass rounded-[2rem] p-6 border border-white/10">
              <div className="flex items-center gap-3 mb-6">
                <Users size={24} className="text-brand-green" />
                <h2 className="text-2xl font-black uppercase">Lineups</h2>
              </div>
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-black uppercase text-white/40 mb-3">{match.homeTeam?.name} <span className="text-brand-green ml-2">{lineups.home.formation}</span></h3>
                  <div className="space-y-2">
                    {lineups.home.players.map((player: any) => (
                      <div key={player.id} className="flex items-center gap-3 p-2 rounded-lg bg-white/5"
                        onClick={() => navigate(`/player/${player.id}`)}
                        style={{ cursor: 'pointer' }}>
                        <span className="text-sm font-black text-brand-green w-8">{player.number}</span>
                        <span className="text-sm">{player.name}</span>
                        <span className="text-xs text-white/40 ml-auto">{player.position}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-black uppercase text-white/40 mb-3">{match.awayTeam?.name} <span className="text-brand-blue ml-2">{lineups.away.formation}</span></h3>
                  <div className="space-y-2">
                    {lineups.away.players.map((player: any) => (
                      <div key={player.id} className="flex items-center gap-3 p-2 rounded-lg bg-white/5"
                        onClick={() => navigate(`/player/${player.id}`)}
                        style={{ cursor: 'pointer' }}>
                        <span className="text-sm font-black text-brand-blue w-8">{player.number}</span>
                        <span className="text-sm">{player.name}</span>
                        <span className="text-xs text-white/40 ml-auto">{player.position}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Statistics */}
            {stats && (
              <div className="glass rounded-[2rem] p-6 border border-white/10">
                <div className="flex items-center gap-3 mb-6">
                  <TrendingUp size={24} className="text-purple-500" />
                  <h2 className="text-2xl font-black uppercase">Statistics</h2>
                </div>
                <div className="space-y-4">
                  {[
                    { label: 'Possession %', home: stats.home_possession, away: stats.away_possession },
                    { label: 'Shots', home: stats.home_shots, away: stats.away_shots },
                    { label: 'Shots on Target', home: stats.home_shots_on_target, away: stats.away_shots_on_target },
                    { label: 'Corners', home: stats.home_corners, away: stats.away_corners },
                    { label: 'Fouls', home: stats.home_fouls, away: stats.away_fouls },
                  ].map((stat, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between text-xs mb-2">
                        <span className="font-bold">{stat.home}</span>
                        <span className="text-white/40">{stat.label}</span>
                        <span className="font-bold">{stat.away}</span>
                      </div>
                      <div className="flex h-2 rounded-full overflow-hidden bg-white/5">
                        <div className="bg-brand-green" style={{ width: `${stat.home}%` }}></div>
                        <div className="bg-brand-blue" style={{ width: `${stat.away}%` }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Match Info */}
            <div className="glass rounded-[2rem] p-6 border border-white/10">
              <div className="flex items-center gap-3 mb-6">
                <Calendar size={24} className="text-brand-blue" />
                <h2 className="text-2xl font-black uppercase">Match Info</h2>
              </div>
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-white/40 mb-1">Competition</p>
                  <p className="font-bold">{match.competitions?.[0]?.name || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Venue</p>
                  <p className="font-bold">{match.venue || 'TBD'}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Date & Time</p>
                  <p className="font-bold">{new Date(match.start_time).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Status</p>
                  <p className="font-bold capitalize">{match.status.replace('_', ' ')}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
