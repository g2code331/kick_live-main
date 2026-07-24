import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, Users, MessageSquare, Activity, TrendingUp, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { FORMATIONS } from '../lib/formations';

function FanLineupPitch({ team, lineup, accent }: { team: any; lineup: { formation: string; players: any[] }; accent: string }) {
  const slots = FORMATIONS[lineup.formation] || FORMATIONS['4-3-3'];
  return <div className="space-y-2">
    <div className="flex items-center justify-between"><h3 className="text-sm font-black uppercase text-white/50">{team?.name}</h3><span className="text-sm font-black" style={{ color: accent }}>{lineup.formation}</span></div>
    <div className="relative w-full overflow-hidden rounded-2xl border border-white/10" style={{ background: 'linear-gradient(180deg,#1a4a1a 0%,#1d5c1d 50%,#1a4a1a 100%)', paddingBottom: '130%' }}>
      <div className="absolute inset-0 pointer-events-none"><div className="absolute top-1/2 left-[12%] right-[12%] h-px bg-white/15" /><div className="absolute top-1/2 left-1/2 w-[25%] h-[12%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15" /><div className="absolute top-0 left-[28%] right-[28%] h-[12%] border border-white/15 border-t-0" /><div className="absolute bottom-0 left-[28%] right-[28%] h-[12%] border border-white/15 border-b-0" /></div>
      {slots.map((slot, i) => { const player = lineup.players[i]; return <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${slot.x}%`, top: `${slot.y}%` }}><div className="flex flex-col items-center"><div className="flex h-9 w-9 items-center justify-center rounded-full border-2 text-[10px] font-black shadow-lg" style={player ? { background: `linear-gradient(135deg, ${team?.primary_color || accent}, ${team?.secondary_color || '#000'})`, borderColor: accent } : { background: 'rgba(0,0,0,.45)', borderColor: 'rgba(255,255,255,.2)' }}>{player ? (player.name?.[0] || '?') : '+'}</div><span className="mt-1 max-w-16 truncate text-center text-[9px] font-black text-white drop-shadow">{player ? player.name?.split(' ').pop() : slot.pos}</span></div></div>; })}
    </div>
  </div>;
}

export default function MatchDetails() {
  const { matchId } = useParams<{ matchId: string }>();
  const navigate = useNavigate();
  const [match, setMatch] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [lineups, setLineups] = useState<any>({ home: { players: [], formation: '4-3-3' }, away: { players: [], formation: '4-3-3' } });
  const [activeLineup, setActiveLineup] = useState<'home' | 'away'>('home');
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

  const isLive = ['first_half', 'half_time', 'second_half', 'extra_time', 'penalty_shootout', 'live'].includes(match.status);

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
                    {match.status === 'half_time' ? 'HALF TIME' : <><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>{match.minute}' LIVE</>}
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
              <div className="flex gap-2 rounded-xl bg-white/5 p-1 mb-4">
                <button onClick={() => setActiveLineup('home')} className={`flex-1 rounded-lg px-3 py-2 text-xs font-black uppercase transition-colors ${activeLineup === 'home' ? 'bg-brand-green text-black' : 'text-white/40 hover:text-white'}`}>{match.homeTeam?.short_name || match.homeTeam?.name}</button>
                <button onClick={() => setActiveLineup('away')} className={`flex-1 rounded-lg px-3 py-2 text-xs font-black uppercase transition-colors ${activeLineup === 'away' ? 'bg-brand-blue text-black' : 'text-white/40 hover:text-white'}`}>{match.awayTeam?.short_name || match.awayTeam?.name}</button>
              </div>
              <FanLineupPitch
                team={activeLineup === 'home' ? match.homeTeam : match.awayTeam}
                lineup={activeLineup === 'home' ? lineups.home : lineups.away}
                accent={activeLineup === 'home' ? '#39FF14' : '#00D4FF'}
              />
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
