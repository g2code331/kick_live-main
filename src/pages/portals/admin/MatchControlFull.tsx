import { useState, useEffect } from 'react';
import { 
  ArrowLeft, Play, Pause, Square, Clock, Users, Activity, 
  MessageSquare, Trophy, Plus, Minus, Timer, UserPlus, Lock
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import EventModal from './EventModal';

interface MatchControlFullProps {
  match: any;
  onBack: () => void;
}

export default function MatchControlFull({ match, onBack }: MatchControlFullProps) {
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  // Track total elapsed seconds; derive display minute/seconds from this
  const [totalSeconds, setTotalSeconds] = useState((match?.minute || 0) * 60);
  const [period, setPeriod] = useState<string>(
    (['first_half','second_half','extra_time','half_time','full_time','completed'].includes(match?.status))
      ? match.status : 'first_half'
  );
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [matchToast, setMatchToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Computed display values
  const minute = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
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
    home_fouls: 0, away_fouls: 0,
    home_yellow_cards: 0, away_yellow_cards: 0,
    home_red_cards: 0, away_red_cards: 0,
    home_saves: 0, away_saves: 0
  });
  const [showKickoffModal, setShowKickoffModal] = useState(false);
  const [kickoffSettings, setKickoffSettings] = useState({
    firstHalfDuration: 45,
    secondHalfDuration: 45,
    extraTimeDuration: 15,
    hasExtraTime: false
  });
  const [isLocked, setIsLocked] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [password, setPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');

  useEffect(() => {
    if (match?.status === 'full_time' || match?.status === 'completed') {
      setIsLocked(true);
    }
  }, [match?.status]);

  const handleUnlock = () => {
    if (password === 'jojOjo') {
      setIsLocked(false);
      setShowPasswordModal(false);
      setPassword('');
      setUnlockError('');
    } else {
      setUnlockError('Incorrect password');
    }
  };

  // Load match data on mount
  useEffect(() => {
    loadMatchData();
  }, [match?.id]);

  // Poll for match updates every 5 seconds to stay in sync
  useEffect(() => {
    if (!isTimerRunning) {
      const pollInterval = setInterval(() => {
        loadMatchData();
      }, 5000);
      return () => clearInterval(pollInterval);
    }
  }, [isTimerRunning]);

  // Timer: ticks every real second, displays MM:SS
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isTimerRunning) {
      interval = setInterval(() => {
        setTotalSeconds((s: number) => {
          const maxSeconds =
            period === 'first_half'
              ? kickoffSettings.firstHalfDuration * 60
              : period === 'second_half'
              ? (kickoffSettings.firstHalfDuration + kickoffSettings.secondHalfDuration) * 60
              : period === 'extra_time'
              ? (kickoffSettings.firstHalfDuration + kickoffSettings.secondHalfDuration + kickoffSettings.extraTimeDuration) * 60
              : 0;
          if (s >= maxSeconds) {
            setIsTimerRunning(false);
            return maxSeconds;
          }
          return s + 1;
        });
      }, 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [isTimerRunning, period, kickoffSettings]);

  // Persist minute to DB every 60 real seconds while timer is running (fan view updates)
  useEffect(() => {
    if (isTimerRunning && totalSeconds > 0 && totalSeconds % 60 === 0) {
      supabase.from('matches').update({
        minute: Math.floor(totalSeconds / 60),
        home_score: homeScore,
        away_score: awayScore,
        status: period,
      }).eq('id', match.id).then(() => {});
    }
  }, [totalSeconds]);

  async function loadMatchData() {
    try {
      // Fetch columns including timer anchor fields
      const { data: matchData } = await supabase
        .from('matches')
        .select('id, home_team_id, away_team_id, home_score, away_score, status, minute, match_start_time, elapsed_seconds_before_pause, homeTeam:teams!home_team_id(id, name, short_name, primary_color, secondary_color), awayTeam:teams!away_team_id(id, name, short_name, primary_color, secondary_color)')
        .eq('id', match.id)
        .single();
      
      if (matchData) {
        setHomeTeam(matchData.homeTeam);
        setAwayTeam(matchData.awayTeam);
        setHomeScore(matchData.home_score || 0);
        setAwayScore(matchData.away_score || 0);

        // Only reconstruct time if the timer is not currently running
        if (!isTimerRunning) {
          const liveStatuses = ['first_half', 'second_half', 'extra_time'];
          if (liveStatuses.includes(matchData.status) && matchData.match_start_time) {
            // Reconstruct elapsed seconds from the stored start time
            const now = Date.now();
            const startMs = new Date(matchData.match_start_time).getTime();
            const elapsed = Math.floor((now - startMs) / 1000) + (matchData.elapsed_seconds_before_pause || 0);
            setTotalSeconds(Math.max(0, elapsed));
          } else {
            setTotalSeconds((matchData.minute || 0) * 60);
          }
          if (matchData.status) setPeriod(matchData.status);
        }
        
        // Limit events to 50 most recent
        const { data: eventsData } = await supabase
          .from('match_events')
          .select('id, event_type, minute, player:players(id, name), team:teams(id, short_name)')
          .eq('match_id', match.id)
          .order('minute', { ascending: true })
          .limit(50);
        setEvents(eventsData || []);
        
        // Limit commentary to 100 most recent
        const { data: commentaryData } = await supabase
          .from('match_commentary')
          .select('id, minute, comment')
          .eq('match_id', match.id)
          .order('minute', { ascending: true })
          .limit(100);
        setCommentary(commentaryData || []);
        
        const { data: statsData } = await supabase
          .from('match_statistics')
          .select('id, home_possession, away_possession, home_shots, away_shots, home_shots_on_target, away_shots_on_target, home_corners, away_corners, home_fouls, away_fouls, home_yellow_cards, away_yellow_cards, home_red_cards, away_red_cards, home_saves, away_saves')
          .eq('match_id', match.id)
          .single();
        if (statsData) setStats(statsData);
      }
    } catch (err) {
      console.error('Error loading match data:', err);
    }
  }

  const handleKickOff = async () => {
    setShowKickoffModal(true);
  };

  const confirmKickOff = async () => {
    const now = new Date();
    setTotalSeconds(0);
    setPeriod('first_half');
    setIsTimerRunning(true);
    setShowKickoffModal(false);
    await supabase.from('matches').update({
      status: 'first_half',
      minute: 0,
      match_start_time: now.toISOString(),
      elapsed_seconds_before_pause: 0
    }).eq('id', match.id);
    await addEvent('kickoff', 0);
  };

  const handlePause = async () => {
    setIsTimerRunning(false);
    await supabase.from('matches').update({
      elapsed_seconds_before_pause: totalSeconds,
      minute: Math.floor(totalSeconds / 60),
      status: period,
      home_score: homeScore,
      away_score: awayScore,
    }).eq('id', match.id);
  };

  const handleResume = async () => {
    const now = new Date();
    // Anchor start-time so elapsed = totalSeconds when timer resumes
    const newStartTime = new Date(now.getTime() - (totalSeconds * 1000));
    await supabase.from('matches').update({
      match_start_time: newStartTime.toISOString(),
      elapsed_seconds_before_pause: 0,
      status: period,
    }).eq('id', match.id);
    setIsTimerRunning(true);
  };

  // Save half-time as its own status so fans see "HT", not "completed"
  const handleHalfTime = async () => {
    setIsTimerRunning(false);
    const htMinute = kickoffSettings.firstHalfDuration;
    const htSeconds = htMinute * 60;
    setTotalSeconds(htSeconds);
    setPeriod('half_time');
    await addEvent('half_time', htMinute);
    await supabase.from('matches').update({
      status: 'half_time',
      minute: htMinute,
      home_score: homeScore,
      away_score: awayScore,
    }).eq('id', match.id);
  };

  // Start the second half: timer continues from firstHalfDuration upward
  const handleStartSecondHalf = async () => {
    const startSec = kickoffSettings.firstHalfDuration * 60;
    setTotalSeconds(startSec);
    setPeriod('second_half');
    setIsTimerRunning(true);
    const now = new Date();
    const startTime = new Date(now.getTime() - (startSec * 1000));
    await supabase.from('matches').update({
      status: 'second_half',
      minute: kickoffSettings.firstHalfDuration,
      match_start_time: startTime.toISOString(),
      elapsed_seconds_before_pause: startSec,
    }).eq('id', match.id);
    await addEvent('second_half_start', kickoffSettings.firstHalfDuration);
  };

  const handleFullTime = async () => {
    if (!confirm('Are you sure you want to end this match? This action cannot be undone.')) return;
    
    setIsTimerRunning(false);
    setPeriod('full_time');
    const finalMinute = minute;
    await addEvent('full_time', finalMinute);
    
    const { error } = await supabase.from('matches').update({
      status: 'completed',
      minute: finalMinute,
      home_score: homeScore,
      away_score: awayScore
    }).eq('id', match.id);
    
    if (error) {
      setMatchToast({ type: 'error', msg: 'Error ending match: ' + error.message });
      return;
    }
    
    setMatchToast({ type: 'success', msg: `Full Time! Final score: ${homeScore} – ${awayScore}` });
    setTimeout(() => { onBack(); }, 2000);
  };

  const handleExtraTime = async () => {
    if (!kickoffSettings.hasExtraTime) {
      setMatchToast({ type: 'error', msg: 'Extra time is not enabled for this match' });
      return;
    }
    const etStartSec = (kickoffSettings.firstHalfDuration + kickoffSettings.secondHalfDuration) * 60;
    setTotalSeconds(etStartSec);
    setPeriod('extra_time');
    setIsTimerRunning(true);
    const now = new Date();
    const startTime = new Date(now.getTime() - (etStartSec * 1000));
    await supabase.from('matches').update({
      status: 'extra_time',
      minute: kickoffSettings.firstHalfDuration + kickoffSettings.secondHalfDuration,
      match_start_time: startTime.toISOString(),
      elapsed_seconds_before_pause: etStartSec,
    }).eq('id', match.id);
    await addEvent('extra_time_start', kickoffSettings.firstHalfDuration + kickoffSettings.secondHalfDuration);
  };

  const saveMatchState = async () => {
    try {
      await supabase.from('matches').update({
        minute: Math.floor(totalSeconds / 60),
        home_score: homeScore,
        away_score: awayScore,
        status: period
      }).eq('id', match.id);
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
        } else if (eventData.eventType === 'red_card') {
          setStats((prev: any) => ({ ...prev, [redCardKey]: (prev[redCardKey] || 0) + 1 }));
        }
      }
      
      setShowEventModal(false);
      loadMatchData();
    } catch (err) {
      console.error('Error submitting event:', err);
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

  return (
    <div className="min-h-screen bg-[#0B0E13]">
      {/* Inline Toast */}
      {matchToast && (
        <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${
          matchToast.type === 'success' ? 'bg-brand-green/20 border-brand-green/40' : 'bg-red-500/20 border-red-500/40'
        }`}>
          {matchToast.type === 'success' ? '✅' : '❌'}
          <span>{matchToast.msg}</span>
        </div>
      )}
      {/* Header */}
      <div className="glass border-b border-white/10 px-8 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-white/10 rounded-lg">
            <ArrowLeft size={24} className="text-white" />
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
                color: (homeTeam?.secondary_color || '#666') === '#000000' ? '#000' : '#fff'
              }}>
                {homeTeam?.short_name?.[0] || 'H'}
              </div>
              <h2 className="text-2xl font-black italic uppercase">{homeTeam?.name || 'Home'}</h2>
              <div className="flex items-center justify-center gap-2 mt-4">
                <button 
                  onClick={() => setHomeScore((s: number) => Math.max(0, s - 1))}
                  className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold flex items-center justify-center"
                >
                  <Minus size={24} />
                </button>
                <span className="text-6xl font-black text-brand-green w-32">{homeScore}</span>
                <button 
                  onClick={() => setHomeScore((s: number) => s + 1)}
                  className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold flex items-center justify-center"
                >
                  <Plus size={24} />
                </button>
              </div>
            </div>

            {/* Timer & Period */}
            <div className="text-center">
              <div className="flex items-center gap-3 justify-center mb-2">
                <Clock size={32} className={`${isTimerRunning ? 'text-brand-green animate-pulse' : 'text-white/40'}`} />
              </div>
              {/* MM:SS display - ticks every second */}
              <div className="text-5xl font-black italic text-brand-green tabular-nums">
                {String(minute).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
              </div>
              <div className="mt-3 px-6 py-3 bg-white/5 rounded-2xl border border-white/10">
                <p className="text-sm font-black uppercase text-white/40">{period.replace(/_/g, ' ')}</p>
              </div>
            </div>

            {/* Away Team */}
            <div className="text-center flex-1">
              <div className="w-32 h-32 rounded-full mx-auto mb-4 flex items-center justify-center text-5xl font-black italic shadow-2xl" style={{
                background: `linear-gradient(135deg, ${awayTeam?.primary_color || '#333'}, ${awayTeam?.secondary_color || '#666'})`,
                color: (awayTeam?.secondary_color || '#666') === '#000000' ? '#000' : '#fff'
              }}>
                {awayTeam?.short_name?.[0] || 'A'}
              </div>
              <h2 className="text-2xl font-black italic uppercase">{awayTeam?.name || 'Away'}</h2>
              <div className="flex items-center justify-center gap-2 mt-4">
                <button 
                  onClick={() => setAwayScore((s: number) => Math.max(0, s - 1))}
                  className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold flex items-center justify-center"
                >
                  <Minus size={24} />
                </button>
                <span className="text-6xl font-black text-brand-green w-32">{awayScore}</span>
                <button 
                  onClick={() => setAwayScore((s: number) => s + 1)}
                  className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold flex items-center justify-center"
                >
                  <Plus size={24} />
                </button>
              </div>
            </div>
          </div>

          {/* Match Controls */}
          <div className="flex flex-wrap gap-4 mt-12 justify-center">
            {/* Kick Off — only when first half hasn't started */}
            {!isTimerRunning && period === 'first_half' && minute === 0 && (
              <button onClick={handleKickOff} className="gradient-green text-black py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Play size={22} /> Kick Off
              </button>
            )}

            {/* Pause — while timer is running */}
            {isTimerRunning && (
              <button onClick={handlePause} className="bg-yellow-500 text-black py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Pause size={22} /> Pause
              </button>
            )}

            {/* Resume — when paused mid-half (not at half-time break, not finished) */}
            {!isTimerRunning && !['half_time', 'full_time', 'completed', 'first_half'].includes(period) && minute > 0 && (
              <button onClick={handleResume} className="gradient-green text-black py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Play size={22} /> Resume
              </button>
            )}
            {/* Also allow resume during first_half if paused with minute > 0 */}
            {!isTimerRunning && period === 'first_half' && minute > 0 && (
              <button onClick={handleResume} className="gradient-green text-black py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Play size={22} /> Resume
              </button>
            )}

            {/* Half Time — only during first half */}
            {period === 'first_half' && minute > 0 && (
              <button onClick={handleHalfTime} className="bg-brand-blue text-white py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Clock size={22} /> Half Time
              </button>
            )}

            {/* Start 2nd Half — shown at half-time break */}
            {period === 'half_time' && (
              <button onClick={handleStartSecondHalf} className="gradient-green text-black py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Play size={22} /> Start 2nd Half
              </button>
            )}

            {/* Extra Time & Full Time — during second half */}
            {period === 'second_half' && (
              <>
                {kickoffSettings.hasExtraTime && (
                  <button onClick={handleExtraTime} className="bg-purple-500 text-white py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                    <Timer size={22} /> Extra Time
                  </button>
                )}
                <button onClick={handleFullTime} className="bg-brand-red text-white py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                  <Square size={22} /> Full Time
                </button>
              </>
            )}

            {/* Full Time also available during extra time */}
            {period === 'extra_time' && (
              <button onClick={handleFullTime} className="bg-brand-red text-white py-5 px-8 rounded-2xl font-black uppercase tracking-widest text-base flex items-center gap-3 hover:scale-105 transition-transform">
                <Square size={22} /> Full Time
              </button>
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
                  🏆
                </button>
                <button onClick={() => handleEventClick('yellow_card')} className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/30 text-yellow-500 hover:bg-yellow-500/20 transition-all">
                  🟨
                </button>
                <button onClick={() => handleEventClick('red_card')} className="p-3 rounded-xl bg-brand-red/10 border border-brand-red/30 text-brand-red hover:bg-brand-red/20 transition-all">
                  🟥
                </button>
                <button onClick={() => handleEventClick('substitution')} className="p-3 rounded-xl bg-brand-blue/10 border border-brand-blue/30 text-brand-blue hover:bg-brand-blue/20 transition-all">
                  🔄
                </button>
              </div>
            </div>
            
            <div className="space-y-3 max-h-[600px] overflow-y-auto">
              {events.map((event, i) => (
                <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/5">
                  <span className="text-lg font-black text-brand-green w-16">{event.minute}'</span>
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl">
                    {event.event_type === 'goal' ? '' : event.event_type === 'yellow_card' ? '🟨' : event.event_type === 'red_card' ? '🟥' : '🔄'}
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
              { label: 'Fouls', home: stats.home_fouls, away: stats.away_fouls, stat: 'fouls', editable: true },
              { label: 'Yellow Cards', home: stats.home_yellow_cards, away: stats.away_yellow_cards, stat: 'yellow_cards', editable: false },
              { label: 'Red Cards', home: stats.home_red_cards, away: stats.away_red_cards, stat: 'red_cards', editable: false },
              { label: 'Saves', home: stats.home_saves, away: stats.away_saves, stat: 'saves', editable: true },
            ].map((statItem, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  {statItem.editable ? (
                    <input
                      type="number"
                      value={statItem.home}
                      onChange={(e) => updateStat(statItem.stat, parseInt(e.target.value), true)}
                      className="w-20 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-center focus:border-brand-green/50"
                    />
                  ) : (
                    <span className="text-white/60 w-20 text-center">{statItem.home}</span>
                  )}
                  <span className="text-xs text-white/40">{statItem.label}</span>
                  {statItem.editable ? (
                    <input
                      type="number"
                      value={statItem.away}
                      onChange={(e) => updateStat(statItem.stat, parseInt(e.target.value), false)}
                      className="w-20 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-center focus:border-brand-blue/50"
                    />
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

      {/* Kickoff Settings Modal */}
      {showKickoffModal && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowKickoffModal(false)}></div>
          <div className="relative w-full max-w-md glass rounded-[2.5rem] border border-white/10 shadow-2xl p-6">
            <h2 className="text-xl font-black uppercase mb-6 text-center">Match Settings</h2>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">First Half Duration (minutes)</label>
                <input
                  type="number"
                  value={kickoffSettings.firstHalfDuration}
                  onChange={(e) => setKickoffSettings({...kickoffSettings, firstHalfDuration: parseInt(e.target.value) || 45})}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Second Half Duration (minutes)</label>
                <input
                  type="number"
                  value={kickoffSettings.secondHalfDuration}
                  onChange={(e) => setKickoffSettings({...kickoffSettings, secondHalfDuration: parseInt(e.target.value) || 45})}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                />
              </div>
              <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5">
                <input
                  type="checkbox"
                  checked={kickoffSettings.hasExtraTime}
                  onChange={(e) => setKickoffSettings({...kickoffSettings, hasExtraTime: e.target.checked})}
                  className="w-5 h-5 rounded"
                />
                <div className="flex-1">
                  <p className="text-sm font-bold">Enable Extra Time</p>
                  <p className="text-[10px] text-white/40">For knockout matches only</p>
                </div>
              </div>
              {kickoffSettings.hasExtraTime && (
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Extra Time Duration (minutes)</label>
                  <input
                    type="number"
                    value={kickoffSettings.extraTimeDuration}
                    onChange={(e) => setKickoffSettings({...kickoffSettings, extraTimeDuration: parseInt(e.target.value) || 15})}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              )}
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setShowKickoffModal(false)}
                className="flex-1 py-3 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmKickOff}
                className="flex-1 py-3 rounded-xl gradient-green text-black font-black uppercase tracking-widest"
              >
                Kick Off
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Password Modal for Locked Matches */}
      {showPasswordModal && (
        <div className="fixed inset-0 z-[350] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowPasswordModal(false)}></div>
          <div className="relative w-full max-w-md glass rounded-[2.5rem] border border-brand-red/30 shadow-2xl p-6">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-brand-red/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Lock size={32} className="text-brand-red" />
              </div>
              <h2 className="text-xl font-black uppercase mb-2">Match Locked</h2>
              <p className="text-white/40 text-sm">This match has ended. Enter admin password to edit.</p>
            </div>
            
            <div className="space-y-4 mb-6">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleUnlock()}
                placeholder="Enter password"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-red/50"
              />
              {unlockError && (
                <p className="text-brand-red text-sm font-bold">{unlockError}</p>
              )}
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => {
                  setShowPasswordModal(false);
                  setPassword('');
                  setUnlockError('');
                }}
                className="flex-1 py-3 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUnlock}
                className="flex-1 py-3 rounded-xl gradient-green text-black font-black uppercase tracking-widest"
              >
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lock Overlay for Finished Matches */}
      {isLocked && !showPasswordModal && (
        <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-sm flex items-center justify-center">
          <div className="glass rounded-[3rem] border border-brand-red/30 p-12 text-center max-w-lg mx-4">
            <div className="w-24 h-24 bg-brand-red/20 rounded-full flex items-center justify-center mx-auto mb-6">
              <Lock size={48} className="text-brand-red" />
            </div>
            <h2 className="text-3xl font-black uppercase mb-4">Match Ended</h2>
            <p className="text-white/40 text-lg mb-8">This match has been completed and is now locked.</p>
            <div className="flex gap-4">
              <button
                onClick={onBack}
                className="flex-1 py-4 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
              >
                Back to Queue
              </button>
              <button
                onClick={() => setShowPasswordModal(true)}
                className="flex-1 py-4 rounded-xl gradient-green text-black font-black uppercase tracking-widest"
              >
                Unlock to Edit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
