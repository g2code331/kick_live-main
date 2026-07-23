import { useState, useEffect } from 'react';
import { 
  X, Play, Pause, Square, RotateCcw, Clock, Users, Activity, 
  MessageSquare, FileText, Trophy, AlertCircle, CheckCircle,
  Plus, Minus, Timer, UserPlus, AlertTriangle
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import EventModal from './EventModal';

interface MatchControlDashboardProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

type MatchPeriod = 'first_half' | 'second_half' | 'extra_time_first' | 'extra_time_second' | 'penalty_shootout';

export default function MatchControlDashboard({ match, isOpen, onClose, onUpdate }: MatchControlDashboardProps) {
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(match?.minute || 0);
  const [period, setPeriod] = useState<MatchPeriod>('first_half');
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [matchStatus, setMatchStatus] = useState(match?.status || 'scheduled');
  const controlsDisabled = ['scheduled', 'waiting', 'cancelled', 'abandoned', 'postponed'].includes(matchStatus);
  const [homeTeam, setHomeTeam] = useState<any>(null);
  const [awayTeam, setAwayTeam] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [showEventModal, setShowEventModal] = useState(false);
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);
  const [stats, setStats] = useState<any>({
    home_possession: 50, away_possession: 50,
    home_shots: 0, away_shots: 0,
    home_shots_on_target: 0, away_shots_on_target: 0,
    home_corners: 0, away_corners: 0,
    home_offsides: 0, away_offsides: 0,
    home_fouls: 0, away_fouls: 0,
    home_yellow_cards: 0, away_yellow_cards: 0,
    home_red_cards: 0, away_red_cards: 0,
    home_saves: 0, away_saves: 0
  });
  const [matchTime, setMatchTime] = useState({
    firstHalf: 45,
    secondHalf: 45,
    extraTime: 15,
    addedTime: 0
  });

  useEffect(() => {
    if (isOpen && match) {
      loadMatchData();
    }
  }, [isOpen, match?.id]);

  // Auto-save timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isTimerRunning) {
      interval = setInterval(() => {
        setMinute((m: number) => {
          const maxMinute = period === 'first_half' || period === 'second_half' ? 45 : period.includes('extra') ? 15 : 0;
          if (m >= maxMinute) {
            return maxMinute;
          }
          return m + 1;
        });
        
        // Auto-save every 30 seconds
        if (minute % 30 === 0 && minute > 0) {
          saveMatchState();
        }
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isTimerRunning, period, minute]);

  async function loadMatchData() {
    try {
      const { data: matchData } = await supabase
        .from('matches')
        .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*)')
        .eq('id', match.id)
        .single();
      
      if (matchData) {
        setMatchStatus(matchData.status || 'scheduled');
        setHomeTeam(matchData.homeTeam);
        setAwayTeam(matchData.awayTeam);
        setHomeScore(matchData.home_score || 0);
        setAwayScore(matchData.away_score || 0);
        setMinute(matchData.minute || 0);
        
        const { data: eventsData } = await supabase
          .from('match_events')
          .select('*, player:players(name), team:teams(short_name)')
          .eq('match_id', match.id)
          .order('minute', { ascending: true });
        setEvents(eventsData || []);
        
        const { data: commentaryData } = await supabase
          .from('match_commentary')
          .select('*')
          .eq('match_id', match.id)
          .order('minute', { ascending: true });
        setCommentary(commentaryData || []);
        
        const { data: statsData } = await supabase
          .from('match_statistics')
          .select('*')
          .eq('match_id', match.id)
          .single();
        if (statsData) setStats(statsData);
      }
    } catch (err) {
      console.error('Error loading match data:', err);
    }
  }

  const handleKickOff = async () => {
    setMatchStatus(period);
    const now = new Date();
    await supabase.from('matches').update({
      status: period,
      match_start_time: now.toISOString(),
      elapsed_seconds_before_pause: 0
    }).eq('id', match.id);
    
    setIsTimerRunning(true);
    await addEvent('kickoff', 0);
  };

  const handlePause = async () => {
    setIsTimerRunning(false);
    if (match) {
      const elapsedSeconds = minute * 60;
      await supabase.from('matches').update({
        elapsed_seconds_before_pause: elapsedSeconds
      }).eq('id', match.id);
    }
  };

  const handleResume = async () => {
    if (match) {
      const now = new Date();
      const newStartTime = new Date(now.getTime() - (minute * 60 * 1000));
      await supabase.from('matches').update({
        match_start_time: newStartTime.toISOString()
      }).eq('id', match.id);
    }
    setIsTimerRunning(true);
  };

  const handleHalfTime = async () => {
    setIsTimerRunning(false);
    setPeriod('second_half');
    setMinute(0);
    await addEvent('half_time', 45);
    await saveMatchState();
  };

  const handleFullTime = async () => {
    setIsTimerRunning(false);
    await addEvent('full_time', minute);
    await saveMatchState();
    // Toast shown via the caller; no browser alert needed
  };

  const handleExtraTime = async () => {
    setPeriod('extra_time_first');
    setMinute(0);
    await addEvent('extra_time_start', minute);
  };

  const saveMatchState = async () => {
    if (controlsDisabled) return;
    try {
      await supabase.from('matches').update({
        minute,
        home_score: homeScore,
        away_score: awayScore,
        status: period
      }).eq('id', match.id);
      onUpdate();
    } catch (err) {
      console.error('Error saving match:', err);
    }
  };

  const addEvent = async (eventType: string, matchMinute: number, data?: any) => {
    try {
      await supabase.from('match_events').insert([{
        match_id: match.id,
        event_type: eventType,
        minute: matchMinute,
        ...data
      }]);
      loadMatchData();
    } catch (err) {
      console.error('Error adding event:', err);
    }
  };

  const handleEventClick = (eventType: string) => {
    if (controlsDisabled) return;
    setSelectedEventType(eventType);
    setShowEventModal(true);
  };

  const handleEventSubmit = async (eventData: any) => {
    try {
      await supabase.from('match_events').insert([{
        match_id: match.id,
        event_type: eventData.eventType,
        minute: eventData.minute,
        team_id: eventData.teamId,
        player_id: eventData.playerId,
        assist_player_id: eventData.assistId,
        goal_type: eventData.goalType,
        card_reason: eventData.reason,
        description: eventData.description
      }]);
      
      if (eventData.eventType === 'goal') {
        if (eventData.teamId === homeTeam?.id) {
          setHomeScore((prev: number) => prev + 1);
        } else if (eventData.teamId === awayTeam?.id) {
          setAwayScore((prev: number) => prev + 1);
        }
      }
      
        if (eventData.eventType.includes('card')) {
        const isHome = eventData.teamId === homeTeam?.id;
        const cardKey = isHome ? 'home_yellow_cards' : 'away_yellow_cards';
        const redCardKey = isHome ? 'home_red_cards' : 'away_red_cards';
        
        if (eventData.eventType === 'yellow_card') {
          setStats((prev: any) => ({ ...prev, [cardKey]: (prev[cardKey] || 0) + 1 }));
        } else if (eventData.eventType === 'red_card' || eventData.eventType === 'second_yellow') {
          setStats((prev: any) => ({ ...prev, [redCardKey]: (prev[redCardKey] || 0) + 1 }));
        }
      }
      
      setShowEventModal(false);
      loadMatchData();
      onUpdate();
    } catch (err) {
      console.error('Error submitting event:', err);
    }
  };

  const addCommentary = async () => {
    if (controlsDisabled) return;
    if (!newComment.trim()) return;
    try {
      await supabase.from('match_commentary').insert([{
        match_id: match.id,
        minute,
        comment: newComment
      }]);
      setNewComment('');
      loadMatchData();
    } catch (err) {
      console.error('Error adding commentary:', err);
    }
  };

  const updateStat = async (stat: string, value: number, isHome: boolean) => {
    if (controlsDisabled) return;
    value = Math.max(0, stat === 'possession' ? Math.min(100, value) : value);
    const key = isHome ? `home_${stat}` : `away_${stat}`;
    setStats((prev: any) => ({ ...prev, [key]: value }));
    
    try {
      await supabase.from('match_statistics').update({
        [key]: value,
        updated_at: new Date().toISOString()
      }).eq('match_id', match.id);
    } catch (err) {
      console.error('Error updating stat:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] bg-[#0B0E13] overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-50 glass border-b border-white/10 px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg">
            <X size={24} className="text-white" />
          </button>
          <div>
            <h1 className="text-2xl font-black italic uppercase tracking-tighter">Match Control Center</h1>
            <p className="text-xs text-white/40">{homeTeam?.name} vs {awayTeam?.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest ${
            isTimerRunning ? 'bg-brand-red text-white animate-pulse' : 'bg-white/10 text-white/40'
          }`}>
            {isTimerRunning ? '🔴 LIVE' : period.replace('_', ' ').toUpperCase()}
          </div>
        </div>
      </div>

      <div className="p-8 max-w-[1800px] mx-auto">
        {/* Scoreboard */}
        <div className="glass rounded-[3rem] p-12 mb-8 border border-white/10">
          <div className="flex items-center justify-around">
            {/* Home Team */}
            <div className="text-center flex-1">
              <div className="w-32 h-32 rounded-full mx-auto mb-4 flex items-center justify-center text-5xl font-black italic shadow-2xl" style={{
                background: `linear-gradient(135deg, ${homeTeam?.primary_color || '#333'}, ${homeTeam?.secondary_color || '#666'})`,
                color: (homeTeam?.secondary_color || homeTeam?.color || '#666') === '#000000' ? '#000' : '#fff'
              }}>
                {homeTeam?.short_name?.[0] || 'H'}
              </div>
              <h2 className="text-2xl font-black italic uppercase">{homeTeam?.name || 'Home'}</h2>
              <div className="flex items-center justify-center gap-2 mt-4">
                <button 
                  disabled={controlsDisabled} onClick={() => setHomeScore((s: number) => Math.max(0, s - 1))}
                  className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold flex items-center justify-center"
                >
                  <Minus size={24} />
                </button>
                <span className="text-6xl font-black text-brand-green w-32">{homeScore}</span>
                <button 
                  disabled={controlsDisabled} onClick={() => setHomeScore((s: number) => s + 1)}
                  className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold flex items-center justify-center"
                >
                  <Plus size={24} />
                </button>
              </div>
            </div>

            {/* Timer & Period */}
            <div className="text-center">
              <div className="text-8xl font-black italic tracking-tighter mb-4">
                <span className="text-white/10">:</span>
              </div>
              <div className="flex items-center gap-3 justify-center mb-4">
                <Clock size={32} className="text-brand-green" />
                <span className="text-5xl font-black italic text-brand-green">{minute}'</span>
              </div>
              <div className="px-6 py-3 bg-white/5 rounded-2xl border border-white/10">
                <p className="text-sm font-black uppercase text-white/40">{period.replace('_', ' ')}</p>
              </div>
            </div>

            {/* Away Team */}
            <div className="text-center flex-1">
              <div className="w-32 h-32 rounded-full mx-auto mb-4 flex items-center justify-center text-5xl font-black italic shadow-2xl" style={{
                background: `linear-gradient(135deg, ${awayTeam?.primary_color || '#333'}, ${awayTeam?.secondary_color || '#666'})`,
                color: (awayTeam?.secondary_color || awayTeam?.color || '#666') === '#000000' ? '#000' : '#fff'
              }}>
                {awayTeam?.short_name?.[0] || 'A'}
              </div>
              <h2 className="text-2xl font-black italic uppercase">{awayTeam?.name || 'Away'}</h2>
              <div className="flex items-center justify-center gap-2 mt-4">
                <button 
                  disabled={controlsDisabled} onClick={() => setAwayScore((s: number) => Math.max(0, s - 1))}
                  className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold flex items-center justify-center"
                >
                  <Minus size={24} />
                </button>
                <span className="text-6xl font-black text-brand-green w-32">{awayScore}</span>
                <button 
                  disabled={controlsDisabled} onClick={() => setAwayScore((s: number) => s + 1)}
                  className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold flex items-center justify-center"
                >
                  <Plus size={24} />
                </button>
              </div>
            </div>
          </div>

          {/* Match Controls */}
          <div className="grid grid-cols-4 gap-4 mt-12">
            {!isTimerRunning && minute === 0 && (
              <button onClick={handleKickOff} className="gradient-green text-black py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                <Play size={24} /> Kick Off
              </button>
            )}
            {isTimerRunning ? (
              <button onClick={handlePause} className="bg-yellow-500 text-black py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                <Pause size={24} /> Pause
              </button>
            ) : minute > 0 && (
              <button onClick={handleResume} className="gradient-green text-black py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                <Play size={24} /> Resume
              </button>
            )}
            {period === 'first_half' && (
              <button onClick={handleHalfTime} className="bg-brand-blue text-black py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                <Clock size={24} /> Half Time
              </button>
            )}
            {period === 'second_half' && (
              <>
                <button onClick={handleExtraTime} className="bg-purple-500 text-white py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                  <Timer size={24} /> Extra Time
                </button>
                <button onClick={handleFullTime} className="bg-brand-red text-white py-6 rounded-2xl font-black uppercase tracking-widest text-lg flex items-center justify-center gap-3 hover:scale-105 transition-transform">
                  <Square size={24} /> Full Time
                </button>
              </>
            )}
          </div>
        </div>

        {/* Main Dashboard Grid */}
        <div className="grid grid-cols-3 gap-8">
          {/* Events Panel */}
          <div className="glass rounded-[2rem] p-6 border border-white/10 col-span-2">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-black uppercase flex items-center gap-3">
                <Activity size={24} className="text-brand-green" /> Match Events
              </h3>
              <div className="flex gap-2">
                <button onClick={() => handleEventClick('goal')} className="p-3 rounded-xl bg-brand-green/10 border border-brand-green/30 text-brand-green hover:bg-brand-green/20 transition-all">
                  <Trophy size={20} />
                </button>
                <button onClick={() => handleEventClick('yellow_card')} className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/20 transition-all">
                  🟨
                </button>
                <button onClick={() => handleEventClick('red_card')} className="p-3 rounded-xl bg-brand-red/10 border border-brand-red/30 text-brand-red hover:bg-brand-red/20 transition-all">
                  🟥
                </button>
                <button onClick={() => handleEventClick('substitution')} className="p-3 rounded-xl bg-brand-blue/10 border border-brand-blue/30 text-brand-blue hover:bg-brand-blue/20 transition-all">
                  <UserPlus size={20} />
                </button>
              </div>
            </div>
            
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {events.map((event, i) => (
                <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                  <span className="text-lg font-black text-brand-green w-16">{event.minute}'</span>
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                    {event.event_type === 'goal' ? '⚽' : event.event_type === 'yellow_card' ? '🟨' : event.event_type === 'red_card' ? '🟥' : '🔄'}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-bold">{event.event_type.replace('_', ' ').toUpperCase()}</p>
                    {event.player && (
                      <p className="text-xs text-white/40">{event.player.name} {event.team && `(${event.team.short_name})`}</p>
                    )}
                    {event.description && (
                      <p className="text-xs text-white/40 mt-1">{event.description}</p>
                    )}
                  </div>
                </div>
              ))}
              {events.length === 0 && (
                <div className="text-center py-12">
                  <Activity size={48} className="mx-auto text-white/10 mb-4" />
                  <p className="text-white/30 font-bold uppercase tracking-widest">No events yet</p>
                </div>
              )}
            </div>
          </div>

          {/* Commentary Panel */}
          <div className="glass rounded-[2rem] p-6 border border-white/10">
            <h3 className="text-xl font-black uppercase flex items-center gap-3 mb-6">
              <MessageSquare size={24} className="text-brand-blue" /> Live Commentary
            </h3>
            
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Type commentary..."
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-brand-blue/50"
                onKeyPress={(e) => e.key === 'Enter' && addCommentary()}
              />
              <button onClick={addCommentary} className="gradient-green text-black px-6 rounded-xl font-black uppercase tracking-widest">
                Post
              </button>
            </div>
            
            <div className="space-y-2 max-h-[600px] overflow-y-auto">
              {commentary.map((comm, i) => (
                <div key={i} className="p-4 rounded-xl bg-white/5 border border-white/5">
                  <span className="text-sm font-black text-brand-blue">{comm.minute}'</span>
                  <p className="text-sm mt-1">{comm.comment}</p>
                </div>
              ))}
              {commentary.length === 0 && (
                <div className="text-center py-12">
                  <MessageSquare size={48} className="mx-auto text-white/10 mb-4" />
                  <p className="text-white/30 font-bold uppercase tracking-widest">No commentary</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Statistics Panel */}
        <div className="glass rounded-[2rem] p-8 border border-white/10 mt-8">
          <h3 className="text-xl font-black uppercase flex items-center gap-3 mb-6">
            <Activity size={24} className="text-purple-500" /> Match Statistics
          </h3>
          
          <div className="grid grid-cols-2 gap-8">
            {[
              { label: 'Possession %', home: stats.home_possession, away: stats.away_possession, stat: 'possession', editable: true },
              { label: 'Shots', home: stats.home_shots, away: stats.away_shots, stat: 'shots', editable: true },
              { label: 'Shots on Target', home: stats.home_shots_on_target, away: stats.away_shots_on_target, stat: 'shots_on_target', editable: true },
              { label: 'Corners', home: stats.home_corners, away: stats.away_corners, stat: 'corners', editable: true },
              { label: 'Offsides', home: stats.home_offsides, away: stats.away_offsides, stat: 'offsides', editable: true },
              { label: 'Fouls', home: stats.home_fouls, away: stats.away_fouls, stat: 'fouls', editable: true },
              { label: 'Yellow Cards', home: stats.home_yellow_cards, away: stats.away_yellow_cards, stat: 'yellow_cards', editable: false },
              { label: 'Red Cards', home: stats.home_red_cards, away: stats.away_red_cards, stat: 'red_cards', editable: false },
              { label: 'Saves', home: stats.home_saves, away: stats.away_saves, stat: 'saves', editable: true },
            ].map((statItem, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  {statItem.editable ? (
                    <div className="flex items-center gap-1">
                      <button type="button" disabled={controlsDisabled} onClick={() => updateStat(statItem.stat, Number(statItem.home) - 1, true)} className="w-7 h-7 rounded-lg bg-white/5 text-lg disabled:opacity-30">−</button>
                      <span className="w-10 text-center font-black">{statItem.home}</span>
                      <button type="button" disabled={controlsDisabled} onClick={() => updateStat(statItem.stat, Number(statItem.home) + 1, true)} className="w-7 h-7 rounded-lg bg-brand-green/15 text-brand-green text-lg disabled:opacity-30">+</button>
                    </div>
                  ) : (
                    <span className="text-white/60 w-20 text-center">{statItem.home}</span>
                  )}
                  <span className="text-xs text-white/40">{statItem.label}</span>
                  {statItem.editable ? (
                    <div className="flex items-center gap-1">
                      <button type="button" disabled={controlsDisabled} onClick={() => updateStat(statItem.stat, Number(statItem.away) - 1, false)} className="w-7 h-7 rounded-lg bg-white/5 text-lg disabled:opacity-30">−</button>
                      <span className="w-10 text-center font-black">{statItem.away}</span>
                      <button type="button" disabled={controlsDisabled} onClick={() => updateStat(statItem.stat, Number(statItem.away) + 1, false)} className="w-7 h-7 rounded-lg bg-brand-blue/15 text-brand-blue text-lg disabled:opacity-30">+</button>
                    </div>
                  ) : (
                    <span className="text-white/60 w-20 text-center">{statItem.away}</span>
                  )}
                </div>
                {statItem.editable && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-green" style={{ width: `${statItem.home}%` }}></div>
                    </div>
                    <div className="flex-1 h-3 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-brand-blue" style={{ width: `${statItem.away}%` }}></div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Event Modal */}
      {showEventModal && selectedEventType && (
        <EventModal
          eventType={selectedEventType}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          allPlayers={[]}
          currentMinute={minute}
          onSubmit={handleEventSubmit}
          onClose={() => setShowEventModal(false)}
        />
      )}
    </div>
  );
}
