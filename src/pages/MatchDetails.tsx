import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Calendar, Users, MessageSquare, Activity, TrendingUp, Wifi, WifiOff } from 'lucide-react';
import { useQuery } from '../lib/data';
import { matchFixture, matchSupplements } from '../lib/data/queries.ts';

import { useMatchRoom } from '../lib/live/useMatchRoom.ts';

/**
 * The fan page. Phase 3 moved its *live* half onto the room (`useMatchRoom`), replacing the 10-second
 * `setInterval` that used to re-query `matches`, `match_events`, commentary, statistics and both squads —
 * five queries per ten seconds per open tab, and a score the browser read out of a row someone else had
 * typed into.
 *
 * What is left on the legacy path is what the engine does not own: commentary text, the statistics the
 * ledger cannot answer (possession, shots, fouls), squad lists and the fixture's static identity. Those
 * refresh *event-driven* — when the room's sequence moves, throttled — rather than on a timer, so an idle
 * pre-match page asks the database nothing at all.
 */
export default function MatchDetails() {
  const { matchId } = useParams<{ matchId: string }>();
  const navigate = useNavigate();
  const id = Number(matchId);
  const { state, clock, connection, secondsSinceFrame } = useMatchRoom(Number.isFinite(id) ? id : 0, { mode: 'viewer', enabled: Number.isFinite(id) && id > 0 });

  // The fixture's static identity, and the three things the ledger does not answer — both through the shared
  // cache now, keyed by the match. That is what makes a Back trip free, what makes the console's own writes
  // invalidate this page (both are tagged `match:<id>`), and what bounded the squad read that used to pull
  // every row for two clubs with no limit (F-06).
  const valid = Number.isFinite(id) && id > 0;
  const fixtureQuery = useQuery(matchFixture, { matchId: id }, { enabled: valid });
  const fixture = fixtureQuery.data as any;
  const [commentary, setCommentary] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [lineups, setLineups] = useState<any>({ home: [], away: [] });
  const teamIds = [fixture?.home_team_id, fixture?.away_team_id].filter((v: any) => typeof v === 'number') as number[];
  const aux = useQuery(
    matchSupplements,
    { matchId: id, teamIds },
    { enabled: valid && teamIds.length > 0 || (valid && teamIds.length === 0) },
  );

  useEffect(() => {
    const data = aux.data;
    if (!data) return;
    setCommentary(data.commentary);
    setStats(data.statistics);
    setLineups({
      home: data.players.filter((p: any) => p.team_id === teamIds[0]),
      away: data.players.filter((p: any) => p.team_id === teamIds[1]),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aux.data]);

  // Refresh the auxiliary block when the ledger moves — never on its own timer. `refetch` bypasses the TTL
  // floor, so a goal in the room means a fresh commentary page here, once, for every fan watching.
  const lastSequence = useRef(0);
  useEffect(() => {
    if (state.sequence > 0 && state.sequence !== lastSequence.current) {
      lastSequence.current = state.sequence;
      void aux.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sequence]);

  const loading = fixtureQuery.loading && !fixture && !state.ready;

  // The engine's own ordering is newest-first, which is right for a console and wrong for a timeline a
  // fan reads top-to-bottom from kickoff.
  const events = [...state.events].reverse();
  const status = state.clock?.status ?? state.status;
  const isLive = ['live', 'first_half', 'second_half', 'extra_time', 'half_time', 'penalty_shootout', 'suspended'].includes(status);

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

  if (!loading && fixture === null && !state.ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/40 text-xl">Match not found</p>
          <button onClick={() => navigate('/matches')} className="mt-4 text-brand-green hover:underline">Back to Matches</button>
        </div>
      </div>
    );
  }

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
                <p className="font-bold text-lg">{state.match?.home_team_name ?? fixture?.homeTeam?.name}</p>
                <p className="text-xs text-white/40">{fixture?.homeTeam?.short_name}</p>
              </div>
              <div className="text-center px-6">
                <p className="text-4xl font-black text-brand-green">{state.ready ? `${state.score.home} - ${state.score.away}` : '- -'}</p>
                {state.score.shootout ? (
                  <p className="text-[10px] uppercase tracking-widest text-white/40">shoot-out {state.score.shootout.home}-{state.score.shootout.away}</p>
                ) : null}
                {isLive && (
                  <p className="text-xs text-brand-green flex items-center justify-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                    {clock.minute}{clock.extra > 0 ? `+${clock.extra}` : ''}' LIVE
                    <span className="text-white/30 flex items-center gap-1 ml-2">
                      {connection.status === 'live' ? <Wifi size={11} /> : <WifiOff size={11} />}
                      {secondsSinceFrame !== null ? `${secondsSinceFrame}s ago` : 'connecting'}
                    </span>
                  </p>
                )}
                {!isLive && (
                  <p className="text-xs text-white/40">{['completed', 'full_time'].includes(status) ? 'Full Time' : state.statusLabel ?? status.replace(/_/g, ' ')}</p>
                )}
                {connection.stale ? <p className="text-[10px] text-amber-300 uppercase tracking-widest">reconnecting — showing the last confirmed score</p> : null}
              </div>
              <div className="flex-1">
                <p className="font-bold text-lg">{state.match?.away_team_name ?? fixture?.awayTeam?.name}</p>
                <p className="text-xs text-white/40">{fixture?.awayTeam?.short_name}</p>
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
                  {events.map((event) => (
                    <div key={`${event.id}-${event.client_event_id ?? ''}`} className={`flex items-center gap-4 p-4 rounded-xl ${event.status === 'corrected' ? 'bg-white/[0.02] opacity-45' : 'bg-white/5'}`}>
                      <span className="text-lg font-black text-brand-green w-12">{event.minute}{event.extra_minute > 0 ? `+${event.extra_minute}` : ''}'</span>
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                        {event.event_type === 'goal' || event.event_type === 'penalty_goal' || event.event_type === 'own_goal' ? '⚽' : event.event_type === 'yellow_card' || event.event_type === 'second_yellow' ? '🟨' : event.event_type === 'red_card' ? '🟥' : event.event_type.startsWith('substitution') ? '🔄' : '📍'}
                      </div>
                      <div className="flex-1">
                        <p className={`font-bold capitalize ${event.status === 'corrected' ? 'line-through' : ''}`}>{event.event_type.replace(/_/g, ' ')}</p>
                        {event.player_name && (
                          <p className="text-sm text-white/60">
                            {event.player_name}
                            {event.team_name ? ` (${event.team_name})` : ''}
                            {event.assist_player_name ? ` — ${event.event_type === 'substitution' ? 'off' : 'assist'}: ${event.assist_player_name}` : ''}
                          </p>
                        )}
                        {event.status === 'corrected' ? (
                          <p className="text-xs text-amber-300/80">corrected{event.correction_reason ? `: ${event.correction_reason}` : ''}</p>
                        ) : null}
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
                  <h3 className="text-sm font-black uppercase text-white/40 mb-3">{state.match?.home_team_name ?? fixture?.homeTeam?.name}</h3>
                  <div className="space-y-2">
                    {lineups.home.slice(0, 11).map((player: any) => (
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
                  <h3 className="text-sm font-black uppercase text-white/40 mb-3">{state.match?.away_team_name ?? fixture?.awayTeam?.name}</h3>
                  <div className="space-y-2">
                    {lineups.away.slice(0, 11).map((player: any) => (
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
                  <p className="font-bold">{state.match?.competition ?? fixture?.competitions?.[0]?.name ?? fixture?.competitions?.name ?? 'N/A'}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Venue</p>
                  <p className="font-bold">{state.match?.venue ?? fixture?.venue ?? 'TBD'}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Date & Time</p>
                  <p className="font-bold">{fixture?.start_time ? new Date(fixture.start_time).toLocaleString() : 'TBD'}</p>
                </div>
                <div>
                  <p className="text-white/40 mb-1">Status</p>
                  <p className="font-bold capitalize">{(state.statusLabel ?? status).replace(/_/g, ' ')}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
