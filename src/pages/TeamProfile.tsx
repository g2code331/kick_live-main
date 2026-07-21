import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Users, Trophy, Calendar, MapPin, Shirt, TrendingUp, Activity, Layout } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { FORMATIONS } from '../lib/formations';

export default function TeamProfile() {
  const { teamId } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const [team, setTeam] = useState<any>(null);
  const [players, setPlayers] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [standings, setStandings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (teamId) loadTeamData();
  }, [teamId]);

  async function loadTeamData() {
    try {
      const { data: teamData } = await supabase
        .from('teams')
        .select('*')
        .eq('id', teamId)
        .single();
      setTeam(teamData);

      const { data: playersData } = await supabase
        .from('players')
        .select('id, name, number, position, goals, assists, nationality, age, photo_url')
        .eq('team_id', teamId)
        .order('number');
      setPlayers(playersData || []);

      const { data: matchesData } = await supabase
        .from('matches')
        .select(`
          id, home_score, away_score, status, minute, start_time,
          homeTeam:teams!home_team_id(id, name, short_name),
          awayTeam:teams!away_team_id(id, name, short_name),
          competitions(id, name)
        `)
        .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
        .order('start_time', { ascending: false })
        .limit(20);
      setMatches(matchesData || []);

      // Competitions & standings
      const { data: compsData } = await supabase
        .from('competitions')
        .select('id, name, type, season, matches!inner(id, home_team_id, away_team_id)')
        .filter('matches.home_team_id', 'eq', teamId)
        .or(`matches.away_team_id.eq.${teamId}`);

      if (compsData && compsData.length > 0) {
        const standingsData = await Promise.all(
          compsData.map(async (comp: any) => {
            const { data: compMatches } = await supabase
              .from('matches')
              .select('home_team_id, away_team_id, home_score, away_score, status')
              .eq('competition_id', comp.id)
              .in('status', ['completed', 'full_time', 'finished']);

            const teamStats: any = {};
            compMatches?.forEach((match: any) => {
              [match.home_team_id, match.away_team_id].forEach((tid: any) => {
                if (!teamStats[tid]) {
                  teamStats[tid] = { teamId: tid, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 };
                }
                const stats = teamStats[tid];
                stats.played++;
                const isHome = match.home_team_id === tid;
                const teamScore = isHome ? match.home_score : match.away_score;
                const oppScore = isHome ? match.away_score : match.home_score;
                stats.gf += teamScore || 0;
                stats.ga += oppScore || 0;
                stats.gd = stats.gf - stats.ga;
                if (teamScore > oppScore) { stats.won++; stats.points += 3; }
                else if (teamScore === oppScore) { stats.drawn++; stats.points += 1; }
                else stats.lost++;
              });
            });

            return {
              competition: comp,
              standings: Object.values(teamStats).sort((a: any, b: any) =>
                b.points !== a.points ? b.points - a.points : b.gd !== a.gd ? b.gd - a.gd : b.gf - a.gf
              ),
            };
          })
        );
        setStandings(standingsData);
      }
    } catch (err) {
      console.error('Error loading team data:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-brand-green font-bold uppercase">Loading Team Profile...</p>
        </div>
      </div>
    );
  }

  if (!team || (team.status && team.status !== 'active')) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/40 text-xl">Team not found</p>
          <button onClick={() => navigate('/teams')} className="mt-4 text-brand-green hover:underline">Back to Teams</button>
        </div>
      </div>
    );
  }

  const upcomingMatches = matches.filter(m => m.status === 'scheduled' || m.status === 'waiting');
  const liveMatches = matches.filter(m => ['first_half', 'second_half', 'extra_time', 'live'].includes(m.status));
  const finishedMatches = matches.filter(m => ['completed', 'full_time', 'finished'].includes(m.status));

  // Parse lineup (from DB or localStorage fallback)
  let savedLineup: { formation: string; players: any[] } | null = null;
  try {
    const raw = team.lineup || localStorage.getItem(`lineup_${team.id}`);
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed?.formation && Array.isArray(parsed?.players)) savedLineup = parsed;
    }
  } catch (_) {}

  const formationSlots = savedLineup ? (FORMATIONS[savedLineup.formation] || FORMATIONS['4-3-3']) : [];

  // Group players by position
  const byPosition: Record<string, any[]> = {};
  players.forEach(p => { const k = p.position || 'Other'; (byPosition[k] ||= []).push(p); });
  const posOrder = ['Goalkeeper', 'Defender', 'Midfielder', 'Forward', 'Other'];

  return (
    <div className="min-h-screen pb-20">
      {/* Hero banner */}
      <div className="relative h-56 overflow-hidden">
        <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${team.primary_color}55, ${team.secondary_color}33)` }} />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#0B0E13]" />
        <button onClick={() => navigate('/teams')} className="absolute top-6 left-6 p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors z-10">
          <ArrowLeft size={22} />
        </button>
      </div>

      <div className="container mx-auto px-4 -mt-28 relative z-10 max-w-6xl">

        {/* ── Team Info Card ─────────────────────────────────────────────── */}
        <div className="glass rounded-[2rem] p-6 md:p-8 border border-white/10 mb-6">
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
            {/* Badge */}
            <div className="w-24 h-24 md:w-28 md:h-28 rounded-2xl flex items-center justify-center text-5xl font-black italic shadow-2xl shrink-0" style={{
              background: `linear-gradient(135deg, ${team.primary_color}, ${team.secondary_color})`,
            }}>
              {team.short_name?.[0] || team.name?.[0]}
            </div>

            {/* Info */}
            <div className="flex-1 text-center sm:text-left">
              <h1 className="text-3xl md:text-4xl font-black italic uppercase tracking-tighter mb-1">{team.name}</h1>
              {team.short_name && (
                <span className="inline-block px-3 py-0.5 rounded-full bg-white/10 text-white/50 text-xs font-black uppercase tracking-widest mb-2">{team.short_name}</span>
              )}
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-3 text-sm text-white/50">
                {team.city && <span className="flex items-center gap-1.5"><MapPin size={14} /> {team.city}</span>}
                {team.venue && <span className="flex items-center gap-1.5">🏟 {team.venue}</span>}
                {team.coach && <span className="flex items-center gap-1.5"><Users size={14} /> {team.coach}</span>}
              </div>
            </div>

            {/* Stats strip */}
            <div className="flex sm:flex-col gap-3">
              <div className="glass-light px-5 py-3 rounded-2xl text-center min-w-[80px]">
                <p className="text-2xl font-black text-brand-green">{players.length}</p>
                <p className="text-[10px] text-white/40 uppercase font-bold">Players</p>
              </div>
              <div className="glass-light px-5 py-3 rounded-2xl text-center min-w-[80px]">
                <p className="text-2xl font-black text-brand-blue">{finishedMatches.length}</p>
                <p className="text-[10px] text-white/40 uppercase font-bold">Played</p>
              </div>
              <div className="glass-light px-5 py-3 rounded-2xl text-center min-w-[80px]">
                <p className="text-2xl font-black text-yellow-400">
                  {finishedMatches.filter(m => {
                    const isHome = m.homeTeam?.id === parseInt(teamId || '0');
                    return isHome ? m.home_score > m.away_score : m.away_score > m.home_score;
                  }).length}
                </p>
                <p className="text-[10px] text-white/40 uppercase font-bold">Wins</p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Starting XI (lineup) ───────────────────────────────────────── */}
        {savedLineup && savedLineup.players.some(Boolean) && (
          <div className="glass rounded-[2rem] p-6 border border-white/10 mb-6">
            <div className="flex items-center gap-3 mb-5">
              <Layout size={20} className="text-brand-green" />
              <h2 className="text-xl font-black uppercase">Starting XI</h2>
              <span className="ml-auto text-xs font-black text-white/30 uppercase tracking-widest">{savedLineup.formation}</span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Mini pitch */}
              <div className="relative rounded-2xl overflow-hidden" style={{ background: 'linear-gradient(180deg, #1a4a1a 0%, #1d5c1d 50%, #1a4a1a 100%)', paddingBottom: '120%' }}>
                {/* Pitch markings */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-1/2 left-[15%] right-[15%] h-px bg-white/10 -translate-y-1/2" />
                  <div className="absolute top-1/2 left-1/2 w-[22%] h-[11%] border border-white/10 -translate-x-1/2 -translate-y-1/2 rounded-full" />
                  <div className="absolute top-0 left-[30%] right-[30%] h-[9%] border border-white/10 border-t-0" />
                  <div className="absolute bottom-0 left-[30%] right-[30%] h-[9%] border border-white/10 border-b-0" />
                </div>
                {formationSlots.map((slot, i) => {
                  const player = savedLineup!.players[i];
                  return (
                    <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${slot.x}%`, top: `${slot.y}%` }}>
                      <div className="flex flex-col items-center gap-0.5">
                        <div className="w-9 h-9 rounded-full flex items-center justify-center font-black text-xs border-2 shadow-lg"
                          style={player ? {
                            background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})`,
                            borderColor: team.primary_color || '#39FF14',
                          } : { background: 'rgba(0,0,0,0.4)', borderColor: 'rgba(255,255,255,0.2)' }}>
                          {player ? (player.name?.[0] || '?') : <span className="text-white/20 text-[10px]">{slot.pos}</span>}
                        </div>
                        <p className="text-[8px] font-black text-white drop-shadow whitespace-nowrap">
                          {player ? player.name?.split(' ').pop() : slot.pos}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Player list for lineup */}
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-white/30 mb-3">Starting Players</p>
                {savedLineup.players.map((p, i) => p ? (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                    onClick={() => navigate(`/player/${p.id}`)}>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black shrink-0"
                      style={{ background: `linear-gradient(135deg, ${team.primary_color || '#39FF14'}, ${team.secondary_color || '#000'})` }}>
                      {p.name?.[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate">{p.name}</p>
                      <p className="text-[10px] text-white/30">{formationSlots[i]?.pos}</p>
                    </div>
                    <span className="text-[10px] font-black text-white/20">#{p.number || '—'}</span>
                  </div>
                ) : null)}
              </div>
            </div>
          </div>
        )}

        {/* ── Squad & Matches ────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">

          {/* Full Squad */}
          <div className="glass rounded-[2rem] p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-5">
              <Users size={20} className="text-brand-green" />
              <h2 className="text-xl font-black uppercase">Full Squad</h2>
              <span className="ml-auto text-xs font-black text-white/30">{players.length} players</span>
            </div>
            {players.length > 0 ? (
              <div className="space-y-4 max-h-[500px] overflow-y-auto custom-scrollbar pr-1">
                {posOrder.filter(pos => byPosition[pos]).map(pos => (
                  <div key={pos}>
                    <p className="text-[9px] font-black uppercase tracking-widest text-white/25 mb-2 px-1">{pos}s</p>
                    <div className="space-y-1.5">
                      {byPosition[pos].map(player => (
                        <div key={player.id}
                          className="flex items-center gap-3 p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer"
                          onClick={() => navigate(`/player/${player.id}`)}>
                          <div className="w-9 h-9 rounded-full bg-brand-green/20 flex items-center justify-center font-black text-sm text-brand-green shrink-0">
                            {player.number || '?'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{player.name}</p>
                            <p className="text-[10px] text-white/40">{player.nationality || 'Unknown'}{player.age ? ` · ${player.age}y` : ''}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-black text-brand-green">{player.goals || 0}G</p>
                            <p className="text-[10px] text-white/30">{player.assists || 0}A</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-white/30">
                <Users size={40} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm">No players in squad yet</p>
              </div>
            )}
          </div>

          {/* Matches */}
          <div className="glass rounded-[2rem] p-6 border border-white/10">
            <div className="flex items-center gap-3 mb-5">
              <Calendar size={20} className="text-brand-blue" />
              <h2 className="text-xl font-black uppercase">Matches</h2>
            </div>
            <div className="space-y-5 max-h-[500px] overflow-y-auto custom-scrollbar pr-1">
              {liveMatches.length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-red-400 mb-2 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" /> Live Now
                  </p>
                  {liveMatches.map(m => (
                    <div key={m.id} className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 cursor-pointer mb-1.5" onClick={() => navigate(`/match/${m.id}`)}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{m.homeTeam?.name}</p>
                          <p className="text-xs text-white/40 truncate">vs {m.awayTeam?.name}</p>
                        </div>
                        <div className="text-center px-3">
                          <p className="text-xl font-black text-brand-green">{m.home_score} – {m.away_score}</p>
                          {m.minute && <p className="text-[10px] text-brand-green">{m.minute}'</p>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {upcomingMatches.length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-brand-blue mb-2">Upcoming</p>
                  {upcomingMatches.slice(0, 5).map(m => (
                    <div key={m.id} className="p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer mb-1.5" onClick={() => navigate(`/match/${m.id}`)}>
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{m.homeTeam?.name}</p>
                          <p className="text-xs text-white/40 truncate">vs {m.awayTeam?.name}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-white/40">{m.start_time ? new Date(m.start_time).toLocaleDateString() : '—'}</p>
                          <p className="text-[10px] text-brand-blue">{m.start_time ? new Date(m.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {finishedMatches.length > 0 && (
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-white/30 mb-2">Recent Results</p>
                  {finishedMatches.slice(0, 5).map(m => {
                    const isHome = m.homeTeam?.id === parseInt(teamId || '0');
                    const teamScore = isHome ? m.home_score : m.away_score;
                    const oppScore = isHome ? m.away_score : m.home_score;
                    const result = teamScore > oppScore ? 'W' : teamScore < oppScore ? 'L' : 'D';
                    const resultColor = result === 'W' ? 'text-brand-green' : result === 'L' ? 'text-brand-red' : 'text-white/40';
                    return (
                      <div key={m.id} className="p-3 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer mb-1.5" onClick={() => navigate(`/match/${m.id}`)}>
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-black w-5 ${resultColor}`}>{result}</span>
                          <div className="flex-1 min-w-0">
                            <p className="font-bold text-sm truncate">{m.homeTeam?.name} vs {m.awayTeam?.name}</p>
                            <p className="text-[10px] text-white/30">{m.competitions?.name || 'Friendly'}</p>
                          </div>
                          <p className="font-black text-sm">{m.home_score} – {m.away_score}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {liveMatches.length === 0 && upcomingMatches.length === 0 && finishedMatches.length === 0 && (
                <div className="text-center py-12 text-white/30">
                  <Calendar size={40} className="mx-auto mb-3 opacity-20" />
                  <p className="text-sm">No matches yet</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Competitions & Standings ───────────────────────────────────── */}
        {standings.length > 0 && (
          <div className="glass rounded-[2rem] p-6 border border-white/10 mb-6">
            <div className="flex items-center gap-3 mb-5">
              <Trophy size={20} className="text-yellow-500" />
              <h2 className="text-xl font-black uppercase">Competitions & Standings</h2>
            </div>
            <div className="space-y-8">
              {standings.map(({ competition, standings: rows }: any) => (
                <div key={competition.id}>
                  <h3 className="text-sm font-black uppercase text-brand-green mb-3">{competition.name} · {competition.season}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[9px] font-black uppercase tracking-widest text-white/25 border-b border-white/5">
                          <th className="px-3 py-2.5 text-center">Pos</th>
                          <th className="px-3 py-2.5 text-left">Team</th>
                          <th className="px-3 py-2.5 text-center">P</th>
                          <th className="px-3 py-2.5 text-center">W</th>
                          <th className="px-3 py-2.5 text-center">D</th>
                          <th className="px-3 py-2.5 text-center">L</th>
                          <th className="px-3 py-2.5 text-center">GD</th>
                          <th className="px-3 py-2.5 text-center font-black">Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 10).map((row: any, i: number) => (
                          <tr key={row.teamId} className={`border-b border-white/5 transition-colors ${row.teamId === parseInt(teamId || '0') ? 'bg-brand-green/10' : 'hover:bg-white/[0.02]'}`}>
                            <td className="px-3 py-2.5 text-center font-bold text-white/60">{i + 1}</td>
                            <td className="px-3 py-2.5 font-bold">{row.name}</td>
                            <td className="px-3 py-2.5 text-center text-white/50">{row.played}</td>
                            <td className="px-3 py-2.5 text-center text-white/50">{row.won}</td>
                            <td className="px-3 py-2.5 text-center text-white/50">{row.drawn}</td>
                            <td className="px-3 py-2.5 text-center text-white/50">{row.lost}</td>
                            <td className="px-3 py-2.5 text-center text-white/50">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                            <td className="px-3 py-2.5 text-center font-black text-brand-green">{row.points}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}