import { useState, useEffect, useRef } from 'react';
import { X, Play, Pause, RotateCcw, Clock, CheckCircle, AlertCircle, Plus, Edit2, Save, Download, Settings, Activity, BarChart3, Users, MessageSquare, Camera, FileText, UserPlus, RotateCw, AlertTriangle } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import EventModal from './EventModal';

interface MatchControlProProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

type MatchStatus = 'scheduled' | 'waiting' | 'first_half' | 'half_time' | 'second_half' | 'extra_time' | 'penalty_shootout' | 'full_time' | 'suspended' | 'postponed' | 'abandoned' | 'cancelled' | 'completed';

export default function MatchControlPro({ match, isOpen, onClose, onUpdate }: MatchControlProProps) {
  const [status, setStatus] = useState<MatchStatus>(match?.status || 'scheduled');
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'events' | 'stats' | 'lineups' | 'commentary'>('events');
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [showEventModal, setShowEventModal] = useState(false);
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);
  const [homeTeam, setHomeTeam] = useState<any>(null);
  const [awayTeam, setAwayTeam] = useState<any>(null);
  const [allPlayers, setAllPlayers] = useState<any[]>([]);
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
  const [lineups, setLineups] = useState({
    home: { formation: '4-4-2', coach: '', starting: [] as number[], bench: [] as number[] },
    away: { formation: '4-4-2', coach: '', starting: [] as number[], bench: [] as number[] }
  });
  
  // TIMESTAMP PHYSICS - Zero egress timer
  const matchStartTimeRef = useRef<Date | null>(null);
  const elapsedBeforePauseRef = useRef<number>(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load match data
  useEffect(() => {
    if (isOpen && match) {
      loadMatchData();
    }
  }, [isOpen, match?.id]);

  // TIMESTAMP PHYSICS TIMER - Runs locally, zero database requests
  useEffect(() => {
    if (isTimerRunning && matchStartTimeRef.current && !['half_time', 'full_time', 'suspended'].includes(status)) {
      timerIntervalRef.current = setInterval(() => {
        const now = new Date();
        const startTime = matchStartTimeRef.current!;
        const elapsedSeconds = Math.floor((now.getTime() - startTime.getTime()) / 1000) + elapsedBeforePauseRef.current;
        const calculatedMinute = Math.floor(elapsedSeconds / 60);
        setMinute(calculatedMinute);
        
        // Auto-save match state every 30 seconds (not every second!)
        if (elapsedSeconds % 30 === 0) {
          saveMatchState(calculatedMinute);
        }
      }, 1000);
    }
    
    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [isTimerRunning, status]);

  async function loadMatchData() {
    try {
      // Load match with teams
      const { data: matchData } = await supabase
        .from('matches')
        .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*)')
        .eq('id', match.id)
        .single();
      
      if (matchData) {
        setHomeTeam(matchData.homeTeam);
        setAwayTeam(matchData.awayTeam);
        setHomeScore(matchData.home_score || 0);
        setAwayScore(matchData.away_score || 0);
        setStatus(matchData.status || 'scheduled');
        setMinute(matchData.minute || 0);
        
        // Store match start time for timestamp physics
        if (matchData.match_start_time) {
          matchStartTimeRef.current = new Date(matchData.match_start_time);
          elapsedBeforePauseRef.current = matchData.elapsed_seconds_before_pause || 0;
        }
        
        // Load players
        const { data: playersData } = await supabase.from('players')
          .select('*')
          .in('team_id', [matchData.home_team_id, matchData.away_team_id]);
        setAllPlayers(playersData || []);
        
        // Load events
        const { data: eventsData } = await supabase.from('match_events')
          .select('*, player:players(name), team:teams(short_name)')
          .eq('match_id', match.id)
          .order('minute', { ascending: true });
        setEvents(eventsData || []);
        
        // Load commentary
        const { data: commentaryData } = await supabase.from('match_commentary')
          .select('*')
          .eq('match_id', match.id)
          .order('minute', { ascending: true });
        setCommentary(commentaryData || []);
        
        // Load statistics
        const { data: statsData } = await supabase.from('match_statistics')
          .select('*')
          .eq('match_id', match.id)
          .single();
        if (statsData) setStats(statsData);
      }
    } catch (err) {
      console.error('Error loading match data:', err);
    }
  }

  // TIMESTAMP PHYSICS: Start Match (1 database request)
  const handleKickoff = async () => {
    const now = new Date();
    matchStartTimeRef.current = now;
    elapsedBeforePauseRef.current = 0;
    
    setStatus('first_half');
    setIsTimerRunning(true);
    
    // Save to database ONCE
    await supabase.from('matches').update({
      status: 'first_half',
      match_start_time: now.toISOString(),
      elapsed_seconds_before_pause: 0
    }).eq('id', match.id);
    
    // Add kickoff event
    await addEvent('kickoff', 0);
  };

  // TIMESTAMP PHYSICS: Pause (1 database request)
  const handlePause = async () => {
    setIsTimerRunning(false);
    
    // Calculate elapsed time before pause
    if (matchStartTimeRef.current) {
      const now = new Date();
      const elapsedSeconds = Math.floor((now.getTime() - matchStartTimeRef.current.getTime()) / 60000) * 60;
      elapsedBeforePauseRef.current = elapsedSeconds;
      
      // Save to database ONCE
      await supabase.from('matches').update({
        elapsed_seconds_before_pause: elapsedSeconds
      }).eq('id', match.id);
    }
  };

  // TIMESTAMP PHYSICS: Resume (1 database request)
  const handleResume = async () => {
    // Reset start time to now minus elapsed time
    if (elapsedBeforePauseRef.current > 0) {
      const now = new Date();
      const newStartTime = new Date(now.getTime() - (elapsedBeforePauseRef.current * 1000));
      matchStartTimeRef.current = newStartTime;
      
      // Save to database ONCE
      await supabase.from('matches').update({
        match_start_time: newStartTime.toISOString()
      }).eq('id', match.id);
    }
    
    setIsTimerRunning(true);
  };

  const handleHalfTime = async () => {
    setIsTimerRunning(false);
    setStatus('half_time');
    await addEvent('half_time', minute);
    await updateMatchInDB();
  };

  const handleSecondHalf = async () => {
    setStatus('second_half');
    setIsTimerRunning(true);
    await updateMatchInDB();
  };

  const handleFullTime = async () => {
    setIsTimerRunning(false);
    setStatus('full_time');
    await addEvent('full_time', minute);
    await updateMatchInDB();
    
    // Trigger automation (standings, brackets, etc.)
    // This would call your MatchAutomation functions
  };

  const updateMatchInDB = async () => {
    try {
      await supabase.from('matches').update({
        minute,
        home_score: homeScore,
        away_score: awayScore,
        status
      }).eq('id', match.id);
      onUpdate();
    } catch (err) {
      console.error('Error updating match:', err);
    }
  };

  const saveMatchState = async (currentMinute: number) => {
    try {
      await supabase.from('matches').update({
        minute: currentMinute,
        status
      }).eq('id', match.id);
    } catch (err) {
      console.error('Error auto-saving:', err);
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

  const addCommentary = async () => {
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

  const handleEventClick = (eventType: string) => {
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
      
      // Auto-update score for goals
      if (eventData.eventType === 'goal') {
        if (eventData.teamId === homeTeam?.id) {
          setHomeScore((prev: number) => prev + 1);
        } else if (eventData.teamId === awayTeam?.id) {
          setAwayScore((prev: number) => prev + 1);
        }
      }
      
      // Auto-update cards count
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      <div className="relative w-full max-w-7xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[90vh]">
        
        {/* Header */}
        <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-4">
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg">
              <X size={20} className="text-white" />
            </button>
            <div>
              <h2 className="text-xl font-black italic uppercase tracking-tighter">Match Control</h2>
              <p className="text-[10px] text-white/40">{homeTeam?.name} vs {awayTeam?.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${
              isTimerRunning ? 'bg-brand-red text-white animate-pulse' : 'bg-white/10 text-white/40'
            }`}>
              {isTimerRunning ? '🔴 LIVE' : status.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Scoreboard */}
        <div className="p-8 bg-gradient-to-b from-white/[0.05] to-transparent">
          <div className="flex items-center justify-around">
            {/* Home Team */}
            <div className="text-center flex-1">
              <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-2xl font-black italic mx-auto mb-3" style={{
                background: `linear-gradient(135deg, ${homeTeam?.primary_color || '#333'}, ${homeTeam?.secondary_color || '#666'})`
              }}>
                {homeTeam?.short_name?.[0] || 'H'}
              </div>
              <h3 className="text-sm font-black uppercase tracking-widest">{homeTeam?.name || 'Home'}</h3>
            </div>

            {/* Score & Timer */}
            <div className="text-center">
              <div className="text-6xl font-black italic tracking-tighter mb-4">
                <span className="text-brand-green">{homeScore}</span>
                <span className="text-white/10 mx-4">-</span>
                <span className="text-brand-green">{awayScore}</span>
              </div>
              <div className="flex items-center gap-2 justify-center">
                <Clock size={20} className="text-brand-green" />
                <span className="text-2xl font-black italic text-brand-green">{minute}'</span>
              </div>
            </div>

            {/* Away Team */}
            <div className="text-center flex-1">
              <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-2xl font-black italic mx-auto mb-3" style={{
                background: `linear-gradient(135deg, ${awayTeam?.primary_color || '#333'}, ${awayTeam?.secondary_color || '#666'})`
              }}>
                {awayTeam?.short_name?.[0] || 'A'}
              </div>
              <h3 className="text-sm font-black uppercase tracking-widest">{awayTeam?.name || 'Away'}</h3>
            </div>
          </div>
        </div>

        {/* Match Controls */}
        <div className="px-8 pb-6 grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-white/10">
          {status === 'scheduled' && (
            <button onClick={handleKickoff} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2">
              <Play size={18} /> Kick Off
            </button>
          )}
          {isTimerRunning ? (
            <button onClick={handlePause} className="bg-yellow-500 text-black py-4 rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2">
              <Pause size={18} /> Pause
            </button>
          ) : status !== 'scheduled' && status !== 'full_time' && (
            <button onClick={handleResume} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2">
              <Play size={18} /> Resume
            </button>
          )}
          {status === 'first_half' && (
            <button onClick={handleHalfTime} className="bg-brand-blue text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Half Time
            </button>
          )}
          {status === 'half_time' && (
            <button onClick={handleSecondHalf} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Second Half
            </button>
          )}
          {(status === 'first_half' || status === 'second_half') && (
            <button onClick={handleFullTime} className="bg-brand-red text-white py-4 rounded-xl font-black uppercase tracking-widest">
              Full Time
            </button>
          )}
        </div>

        {/* Quick Event Buttons */}
        <div className="px-8 py-4 border-b border-white/10">
          <p className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-3">Quick Events</p>
          <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
            <button onClick={() => handleEventClick('goal')} className="p-3 rounded-xl bg-brand-green/10 border border-brand-green/30 text-brand-green hover:bg-brand-green/20 transition-all text-xs font-black uppercase">
              ⚽ Goal
            </button>
            <button onClick={() => handleEventClick('yellow_card')} className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/20 transition-all text-xs font-black uppercase">
              🟨 Yellow
            </button>
            <button onClick={() => handleEventClick('red_card')} className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 hover:bg-red-500/20 transition-all text-xs font-black uppercase">
              🟥 Red
            </button>
            <button onClick={() => handleEventClick('substitution')} className="p-3 rounded-xl bg-brand-blue/10 border border-brand-blue/30 text-brand-blue hover:bg-brand-blue/20 transition-all text-xs font-black uppercase">
              🔄 Sub
            </button>
            <button onClick={() => handleEventClick('penalty')} className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-500 hover:bg-purple-500/20 transition-all text-xs font-black uppercase">
              🎯 Penalty
            </button>
            <button onClick={() => handleEventClick('corner')} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all text-xs font-black uppercase">
              📐 Corner
            </button>
            <button onClick={() => handleEventClick('offside')} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all text-xs font-black uppercase">
              🚩 Offside
            </button>
            <button onClick={() => handleEventClick('var')} className="p-3 rounded-xl bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all text-xs font-black uppercase">
              📺 VAR
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-8 border-b border-white/10 flex gap-4">
          <button
            onClick={() => setActiveTab('events')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'events' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <Activity size={16} /> Events
          </button>
          <button
            onClick={() => setActiveTab('stats')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'stats' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <BarChart3 size={16} /> Stats
          </button>
          <button
            onClick={() => setActiveTab('lineups')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'lineups' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <Users size={16} /> Lineups
          </button>
          <button
            onClick={() => setActiveTab('commentary')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'commentary' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <MessageSquare size={16} /> Commentary
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'events' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Match Timeline</h3>
              <div className="space-y-2">
                {events.map((event, i) => (
                  <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                    <span className="text-sm font-black text-brand-green w-12">{event.minute}'</span>
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-lg">
                      {event.event_type === 'goal' ? '⚽' : event.event_type === 'yellow_card' ? '🟨' : event.event_type === 'red_card' ? '🟥' : ''}
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
                    <p className="text-white/40 text-sm">Kick off to start recording</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'stats' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-6">Live Statistics</h3>
              <div className="space-y-6">
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
                    <div className="flex items-center justify-between text-xs">
                      {statItem.editable ? (
                        <input
                          type="number"
                          value={statItem.home}
                          onChange={(e) => updateStat(statItem.stat, parseInt(e.target.value), true)}
                          className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-center text-white focus:border-brand-green/50"
                        />
                      ) : (
                        <span className="text-white/60 w-16 text-center">{statItem.home}</span>
                      )}
                      <span className="text-[10px] text-white/40">{statItem.label}</span>
                      {statItem.editable ? (
                        <input
                          type="number"
                          value={statItem.away}
                          onChange={(e) => updateStat(statItem.stat, parseInt(e.target.value), false)}
                          className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-center text-white focus:border-brand-blue/50"
                        />
                      ) : (
                        <span className="text-white/60 w-16 text-center">{statItem.away}</span>
                      )}
                    </div>
                    {statItem.editable && (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-green" style={{ width: `${statItem.home}%` }}></div>
                        </div>
                        <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                          <div className="h-full bg-brand-blue" style={{ width: `${statItem.away}%` }}></div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'lineups' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-6">Match Lineups</h3>
              <div className="grid grid-cols-2 gap-8">
                {/* Home Team */}
                <div className="glass rounded-2xl p-6">
                  <h4 className="text-sm font-black uppercase mb-4">{homeTeam?.name || 'Home'}</h4>
                  <p className="text-xs text-white/40 mb-4">Formation: {lineups.home.formation}</p>
                  <div className="space-y-2">
                    <p className="text-xs font-black uppercase text-white/30">Starting XI:</p>
                    {lineups.home.starting.length > 0 ? (
                      lineups.home.starting.map((playerId: number, i: number) => {
                        const player = allPlayers.find(p => p.id === playerId);
                        return player ? (
                          <div key={i} className="flex items-center gap-2 p-2 rounded-lg bg-white/5">
                            <span className="text-sm font-black text-brand-green w-8">{player.number}</span>
                            <span className="text-sm">{player.name}</span>
                          </div>
                        ) : null;
                      })
                    ) : (
                      <p className="text-white/30 text-sm">Not set</p>
                    )}
                  </div>
                </div>

                {/* Away Team */}
                <div className="glass rounded-2xl p-6">
                  <h4 className="text-sm font-black uppercase mb-4">{awayTeam?.name || 'Away'}</h4>
                  <p className="text-xs text-white/40 mb-4">Formation: {lineups.away.formation}</p>
                  <div className="space-y-2">
                    <p className="text-xs font-black uppercase text-white/30">Starting XI:</p>
                    {lineups.away.starting.length > 0 ? (
                      lineups.away.starting.map((playerId: number, i: number) => {
                        const player = allPlayers.find(p => p.id === playerId);
                        return player ? (
                          <div key={i} className="flex items-center gap-2 p-2 rounded-lg bg-white/5">
                            <span className="text-sm font-black text-brand-blue w-8">{player.number}</span>
                            <span className="text-sm">{player.name}</span>
                          </div>
                        ) : null;
                      })
                    ) : (
                      <p className="text-white/30 text-sm">Not set</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'commentary' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Live Commentary</h3>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Type commentary..."
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/20 focus:outline-none focus:border-brand-green/50"
                  onKeyPress={(e) => e.key === 'Enter' && addCommentary()}
                />
                <button onClick={addCommentary} className="gradient-green text-black px-6 rounded-xl font-black uppercase tracking-widest">
                  Post
                </button>
              </div>
              <div className="space-y-2">
                {commentary.map((comm, i) => (
                  <div key={i} className="p-4 rounded-xl bg-white/5">
                    <span className="text-sm font-black text-brand-green">{comm.minute}'</span>
                    <span className="text-sm ml-2">{comm.comment}</span>
                  </div>
                ))}
                {commentary.length === 0 && (
                  <div className="text-center py-12">
                    <MessageSquare size={48} className="mx-auto text-white/10 mb-4" />
                    <p className="text-white/30 font-bold uppercase tracking-widest">No commentary yet</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Event Modal */}
        {showEventModal && selectedEventType && (
          <EventModal
            eventType={selectedEventType}
            homeTeam={homeTeam}
            awayTeam={awayTeam}
            allPlayers={allPlayers}
            currentMinute={minute}
            onSubmit={handleEventSubmit}
            onClose={() => setShowEventModal(false)}
          />
        )}
      </div>
    </div>
  );
}
