import { useState, useEffect } from 'react';
import { X, Play, Pause, RotateCcw, Clock, Activity, BarChart3, Users, MessageSquare } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MatchControlRoomProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export default function MatchControlRoom({ match, isOpen, onClose, onUpdate }: MatchControlRoomProps) {
  const [status, setStatus] = useState(match?.status || 'waiting');
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(match?.minute || 0);
  const [isTimerRunning, setIsTimerRunning] = useState(match?.status === 'live');
  const [activeTab, setActiveTab] = useState<'events' | 'stats' | 'lineups' | 'commentary'>('events');
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  const [stats, setStats] = useState({
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
    home: { formation: '4-4-2', coach: '', starting: [] as number[] },
    away: { formation: '4-4-2', coach: '', starting: [] as number[] }
  });
  const [allPlayers, setAllPlayers] = useState<any[]>([]);

  useEffect(() => {
    if (isTimerRunning && status !== 'waiting' && status !== 'full_time' && status !== 'half_time') {
      const interval = setInterval(() => {
        setMinute((m: number) => {
          const maxMinute = status === 'first_half' ? 45 : 90;
          if (m >= maxMinute) {
            setIsTimerRunning(false);
            return maxMinute;
          }
          return m + 1;
        });
      }, 60000);
      return () => clearInterval(interval);
    }
  }, [isTimerRunning, status]);

  useEffect(() => {
    if (isOpen) {
      loadEvents();
      loadCommentary();
      loadPlayers();
    }
  }, [isOpen]);

  const handleKickoff = async () => {
    setStatus('first_half');
    setIsTimerRunning(true);
    await addEvent('kickoff', 0);
    await updateMatch();
  };

  const handlePause = async () => {
    setIsTimerRunning(false);
    await updateMatch();
  };

  const handleResume = async () => {
    setIsTimerRunning(true);
    await updateMatch();
  };

  const handleHalfTime = async () => {
    setIsTimerRunning(false);
    setStatus('half_time');
    await addEvent('half_time', minute);
    await updateMatch();
  };

  const handleSecondHalf = async () => {
    setStatus('second_half');
    setIsTimerRunning(true);
    await updateMatch();
  };

  const handleFullTime = async () => {
    setIsTimerRunning(false);
    setStatus('full_time');
    await addEvent('full_time', minute);
    await updateMatch();
  };

  const updateMatch = async () => {
    try {
      await supabase.from('matches').update({
        home_score: homeScore,
        away_score: awayScore,
        minute: minute,
        status: status
      }).eq('id', match.id);
      onUpdate();
    } catch (err) {
      console.error('Error updating match:', err);
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
      loadEvents();
    } catch (err) {
      console.error('Error adding event:', err);
    }
  };

  const loadEvents = async () => {
    const { data } = await supabase.from('match_events')
      .select('*')
      .eq('match_id', match.id)
      .order('minute', { ascending: true });
    setEvents(data || []);
  };

  const loadCommentary = async () => {
    const { data } = await supabase.from('match_commentary')
      .select('*')
      .eq('match_id', match.id)
      .order('minute', { ascending: true });
    setCommentary(data || []);
  };

  const loadPlayers = async () => {
    if (!match) return;
    const { data } = await supabase.from('players')
      .select('*')
      .in('team_id', [match.home_team_id, match.away_team_id]);
    setAllPlayers(data || []);
  };

  const addCommentary = async () => {
    if (!newComment.trim()) return;
    try {
      await supabase.from('match_commentary').insert([{
        match_id: match.id,
        minute: minute,
        comment: newComment
      }]);
      setNewComment('');
      loadCommentary();
    } catch (err) {
      console.error('Error adding commentary:', err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      <div className="relative w-full max-w-7xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[90vh]">
        
        {/* Header */}
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-6">
            <div className="px-4 py-1.5 bg-brand-red rounded-lg text-[10px] font-black uppercase tracking-widest animate-pulse">
              Match Control Room
            </div>
            <div>
              <h2 className="text-xl font-black italic uppercase tracking-tighter">{match?.homeTeam?.name || 'Home'} vs {match?.awayTeam?.name || 'Away'}</h2>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${
              status === 'first_half' || status === 'second_half' ? 'bg-brand-red text-white' : 'bg-white/10 text-white/40'
            }`}>
              {status === 'first_half' || status === 'second_half' ? '🔴 LIVE' : status.replace('_', ' ').toUpperCase()}
            </span>
            <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full"><X /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Scoreboard Area */}
            <div className="lg:col-span-8 space-y-8">
              <div className="glass rounded-[3rem] p-12 flex items-center justify-around relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-brand-green/5 to-brand-blue/5 pointer-events-none"></div>
                
                {/* Home Team */}
                <div className="text-center space-y-4 z-10">
                  <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic">
                    {match?.homeTeam?.short_name?.[0]}
                  </div>
                  <h3 className="text-sm font-black uppercase tracking-widest">{match?.homeTeam?.name}</h3>
                  <div className="flex gap-2">
                    <button onClick={() => setHomeScore((s: number) => Math.max(0, s - 1))} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-xl font-bold">-</button>
                    <button onClick={() => setHomeScore((s: number) => s + 1)} className="w-8 h-8 rounded-lg gradient-green text-black font-black text-xl">+</button>
                  </div>
                </div>

                {/* Score Display */}
                <div className="text-center z-10">
                  <div className="text-8xl font-black italic tracking-tighter flex items-center gap-4">
                    <span className="text-brand-green text-glow-green">{homeScore}</span>
                    <span className="text-white/10">:</span>
                    <span className="text-brand-green text-glow-green">{awayScore}</span>
                  </div>
                  <div className="mt-4 px-6 py-2 bg-white/5 rounded-full inline-flex items-center gap-2 border border-white/5">
                    <Clock size={16} className="text-brand-green" />
                    <span className="text-2xl font-black italic text-brand-green">{minute}'</span>
                  </div>
                </div>

                {/* Away Team */}
                <div className="text-center space-y-4 z-10">
                  <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic">
                    {match?.awayTeam?.short_name?.[0]}
                  </div>
                  <h3 className="text-sm font-black uppercase tracking-widest">{match?.awayTeam?.name}</h3>
                  <div className="flex gap-2">
                    <button onClick={() => setAwayScore((s: number) => Math.max(0, s - 1))} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-xl font-bold">-</button>
                    <button onClick={() => setAwayScore((s: number) => s + 1)} className="w-8 h-8 rounded-lg gradient-green text-black font-black text-xl">+</button>
                  </div>
                </div>
              </div>

              {/* Match Controls */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {status === 'waiting' && (
                  <button onClick={handleKickoff} className="p-6 rounded-3xl border border-brand-green bg-brand-green/10 flex flex-col items-center gap-3">
                    <Play size={24} className="text-brand-green" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Kick Off</span>
                  </button>
                )}
                {isTimerRunning ? (
                  <button onClick={handlePause} className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 hover:bg-white/10">
                    <Pause size={24} className="text-yellow-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Pause</span>
                  </button>
                ) : status !== 'waiting' && status !== 'full_time' && (
                  <button onClick={handleResume} className="p-6 rounded-3xl border border-brand-green bg-brand-green/10 flex flex-col items-center gap-3">
                    <Play size={24} className="text-brand-green" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Resume</span>
                  </button>
                )}
                {status === 'first_half' && (
                  <button onClick={handleHalfTime} className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 hover:bg-white/10">
                    <Clock size={24} className="text-brand-blue" />
                    <span className="text-[10px] font-black uppercase tracking-widest">Half Time</span>
                  </button>
                )}
                {status === 'half_time' && (
                  <button onClick={handleSecondHalf} className="p-6 rounded-3xl border border-brand-green bg-brand-green/10 flex flex-col items-center gap-3">
                    <Play size={24} className="text-brand-green" />
                    <span className="text-[10px] font-black uppercase tracking-widest">2nd Half</span>
                  </button>
                )}
                {(status === 'first_half' || status === 'second_half') && (
                  <button onClick={handleFullTime} className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 hover:bg-brand-red/20">
                    <div className="w-6 h-6 rounded-full bg-brand-red flex items-center justify-center text-white text-xs font-black">✓</div>
                    <span className="text-[10px] font-black uppercase tracking-widest">Full Time</span>
                  </button>
                )}
              </div>
            </div>

            {/* Stats & Timeline Side */}
            <div className="lg:col-span-4 space-y-6">
              {/* Stats */}
              <div className="glass rounded-[2rem] p-6">
                <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-6 flex items-center gap-2">
                  <BarChart3 size={16} /> Match Statistics
                </h3>
                <div className="space-y-4">
                  {[
                    { label: 'Possession %', home: stats.home_possession, away: stats.away_possession, stat: 'possession' },
                    { label: 'Shots', home: stats.home_shots, away: stats.away_shots, stat: 'shots' },
                    { label: 'Shots on Target', home: stats.home_shots_on_target, away: stats.away_shots_on_target, stat: 'shots_on_target' },
                    { label: 'Corners', home: stats.home_corners, away: stats.away_corners, stat: 'corners' },
                    { label: 'Offsides', home: stats.home_offsides, away: stats.away_offsides, stat: 'offsides' },
                    { label: 'Fouls', home: stats.home_fouls, away: stats.away_fouls, stat: 'fouls' },
                    { label: 'Yellow Cards', home: stats.home_yellow_cards, away: stats.away_yellow_cards, stat: 'yellow_cards' },
                    { label: 'Red Cards', home: stats.home_red_cards, away: stats.away_red_cards, stat: 'red_cards' },
                    { label: 'Saves', home: stats.home_saves, away: stats.away_saves, stat: 'saves' },
                  ].map((stat, i) => (
                    <div key={i} className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <input
                          type="number"
                          value={stat.home}
                          onChange={(e) => setStats(prev => ({ ...prev, [`home_${stat.stat}`]: parseInt(e.target.value) }))}
                          className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-center text-white"
                        />
                        <span className="text-[10px] text-white/40">{stat.label}</span>
                        <input
                          type="number"
                          value={stat.away}
                          onChange={(e) => setStats(prev => ({ ...prev, [`away_${stat.stat}`]: parseInt(e.target.value) }))}
                          className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-center text-white"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Status & Timeline */}
              <div className="glass rounded-[2rem] p-6">
                <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-6 flex items-center gap-2">
                  <Clock size={16} /> Broadcast
                </h3>
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-brand-green/10 border border-brand-green/30">
                    <p className="text-xs font-black uppercase text-brand-green">Live Syncing</p>
                    <p className="text-[10px] text-white/40 mt-1">All changes are broadcasted in real-time to all viewers</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-white/40">Authorized Official Session</p>
                    <p className="text-[10px] text-white/30">Admin UID: {match?.id}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="px-8 border-t border-white/10 flex gap-4">
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
      </div>
    </div>
  );
}
