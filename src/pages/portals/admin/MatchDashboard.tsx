import { useState, useEffect, useRef } from 'react';
import { 
  ArrowLeft, Play, Pause, RotateCcw, Clock, CheckCircle,
  AlertCircle, Plus, X, Edit2, Save, Download, Settings,
  Activity, BarChart3, Users, MessageSquare, Camera, FileText
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { updateStandingsAfterMatch, sendMatchNotification } from '../../../lib/MatchAutomation';

interface MatchDashboardProps {
  matchId: number;
  onBack: () => void;
}

type MatchStatus = 'waiting' | 'ready' | 'kickoff' | 'first_half' | 'half_time' | 
                   'second_half' | 'extra_time' | 'penalty_shootout' | 
                   'full_time' | 'suspended' | 'postponed' | 'abandoned' | 
                   'cancelled' | 'completed';

export default function MatchDashboard({ matchId, onBack }: MatchDashboardProps) {
  // Match State
  const [match, setMatch] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>('waiting');
  const [minute, setMinute] = useState(0);
  const [extraTime, setExtraTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [period, setPeriod] = useState(1);
  const [matchLength, setMatchLength] = useState(90);
  
  // Score
  const [homeScore, setHomeScore] = useState(0);
  const [awayScore, setAwayScore] = useState(0);
  
  // Teams
  const [homeTeam, setHomeTeam] = useState<any>(null);
  const [awayTeam, setAwayTeam] = useState<any>(null);
  const [allPlayers, setAllPlayers] = useState<any[]>([]);
  
  // Events
  const [events, setEvents] = useState<any[]>([]);
  const [showEventModal, setShowEventModal] = useState(false);
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);
  const [eventForm, setEventForm] = useState({
    teamId: '',
    playerId: '',
    assistId: '',
    minute: 0,
    goalType: 'normal',
    cardReason: '',
    description: ''
  });
  
  // Statistics
  const [stats, setStats] = useState<any>({
    home_possession: 50, away_possession: 50,
    home_shots: 0, away_shots: 0,
    home_shots_on_target: 0, away_shots_on_target: 0,
    home_corners: 0, away_corners: 0,
    home_fouls: 0, away_fouls: 0,
    home_yellow_cards: 0, away_yellow_cards: 0,
    home_red_cards: 0, away_red_cards: 0
  });
  
  // Commentary
  const [commentary, setCommentary] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');
  
  // Active Tab
  const [activeTab, setActiveTab] = useState<'events' | 'stats' | 'commentary'>('events');
  
  // Undo/Redo
  const [history, setHistory] = useState<any[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // Timer Ref
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Load Match Data
  useEffect(() => {
    loadMatch();
  }, [matchId]);
  
  // Auto Timer Effect
  useEffect(() => {
    if (isTimerRunning && !['half_time', 'full_time', 'waiting', 'suspended'].includes(matchStatus)) {
      timerRef.current = setInterval(() => {
        setMinute((m: number) => {
          const maxMinute = period === 1 ? 45 : 90;
          if (m >= maxMinute) {
            return maxMinute;
          }
          return m + 1;
        });
        
        // Auto-save every 30 seconds
        if (minute % 1 === 0) {
          saveMatchState();
        }
      }, 1000);
    }
    
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isTimerRunning, matchStatus, period, minute]);
  
  async function loadMatch() {
    try {
      const { data: matchData } = await supabase
        .from('matches')
        .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*), competition:competitions(*)')
        .eq('id', matchId)
        .single();
      
      if (matchData) {
        setMatch(matchData);
        setHomeTeam(matchData.homeTeam);
        setAwayTeam(matchData.awayTeam);
        setHomeScore(matchData.home_score || 0);
        setAwayScore(matchData.away_score || 0);
        setMatchStatus(matchData.status || 'waiting');
        setMinute(matchData.minute || 0);
        setMatchLength(matchData.match_length || 90);
        
        // Load players
        const { data: playersData } = await supabase
          .from('players')
          .select('*')
          .in('team_id', [matchData.home_team_id, matchData.away_team_id]);
        setAllPlayers(playersData || []);
        
        // Load events
        const { data: eventsData } = await supabase
          .from('match_events')
          .select('*')
          .eq('match_id', matchId)
          .order('minute', { ascending: true });
        setEvents(eventsData || []);
        
        // Load stats
        const { data: statsData } = await supabase
          .from('match_statistics')
          .select('*')
          .eq('match_id', matchId)
          .single();
        if (statsData) setStats(statsData);
        
        // Load commentary
        const { data: commentaryData } = await supabase
          .from('match_commentary')
          .select('*')
          .eq('match_id', matchId)
          .order('minute', { ascending: true });
        setCommentary(commentaryData || []);
      }
    } catch (err) {
      console.error('Error loading match:', err);
    } finally {
      setLoading(false);
    }
  }
  
  // Save to history for undo
  const saveToHistory = () => {
    const newState = { minute, homeScore, awayScore, matchStatus, events: [...events], stats: { ...stats } };
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newState);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  };
  
  // Undo
  const undo = async () => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      setMinute(prevState.minute);
      setHomeScore(prevState.homeScore);
      setAwayScore(prevState.awayScore);
      setMatchStatus(prevState.matchStatus);
      setEvents(prevState.events);
      setStats(prevState.stats);
      setHistoryIndex(historyIndex - 1);
      await updateMatchInDB();
    }
  };
  
  // Redo
  const redo = async () => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      setMinute(nextState.minute);
      setHomeScore(nextState.homeScore);
      setAwayScore(nextState.awayScore);
      setMatchStatus(nextState.matchStatus);
      setEvents(nextState.events);
      setStats(nextState.stats);
      setHistoryIndex(historyIndex + 1);
      await updateMatchInDB();
    }
  };
  
  // Auto-save match state
  const saveMatchState = async () => {
    try {
      await supabase.from('matches').update({
        minute,
        status: matchStatus,
        status_detail: matchStatus.replace('_', ' ').toUpperCase()
      }).eq('id', matchId);
    } catch (err) {
      console.error('Error auto-saving:', err);
    }
  };
  
  // Update match in database
  const updateMatchInDB = async () => {
    try {
      await supabase.from('matches').update({
        minute,
        home_score: homeScore,
        away_score: awayScore,
        status: matchStatus
      }).eq('id', matchId);
    } catch (err) {
      console.error('Error updating match:', err);
    }
  };
  
  // Match Controls
  const startFirstHalf = async () => {
    saveToHistory();
    setPeriod(1);
    setMatchStatus('first_half');
    setIsTimerRunning(true);
    await addEvent('kickoff', 0);
    await updateMatchInDB();
  };
  
  const pauseMatch = async () => {
    setIsTimerRunning(false);
    await updateMatchInDB();
  };
  
  const resumeMatch = async () => {
    setIsTimerRunning(true);
    await updateMatchInDB();
  };
  
  const endFirstHalf = async () => {
    setIsTimerRunning(false);
    setMatchStatus('half_time');
    await addEvent('half_time', minute);
    await updateMatchInDB();
  };
  
  const startSecondHalf = async () => {
    saveToHistory();
    setPeriod(2);
    setMatchStatus('second_half');
    setIsTimerRunning(true);
    await addEvent('second_half_start', minute);
    await updateMatchInDB();
  };
  
  const endMatch = async () => {
    setIsTimerRunning(false);
    setMatchStatus('full_time');
    await addEvent('full_time', minute);
    await updateMatchInDB();
    
    // Trigger automation
    await updateStandingsAfterMatch(matchId);
    await sendMatchNotification('full_time', matchId);
  };
  
  // Add Event
  const addEvent = async (eventType: string, matchMinute: number, data?: any) => {
    try {
      await supabase.from('match_events').insert([{
        match_id: matchId,
        event_type: eventType,
        minute: matchMinute,
        ...data
      }]);
      loadMatch();
    } catch (err) {
      console.error('Error adding event:', err);
    }
  };
  
  // Add Commentary
  const addCommentary = async () => {
    if (!newComment.trim()) return;
    try {
      await supabase.from('match_commentary').insert([{
        match_id: matchId,
        minute: minute,
        comment: newComment
      }]);
      setNewComment('');
      loadMatch();
    } catch (err) {
      console.error('Error adding commentary:', err);
    }
  };
  
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Match...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-[#0B0E13] p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button onClick={onBack} className="flex items-center gap-2 text-white/40 hover:text-white">
            <ArrowLeft size={20} />
            <span className="font-bold">Back</span>
          </button>
          <div className="text-center">
            <h1 className="text-2xl font-black italic uppercase">{homeTeam?.name} vs {awayTeam?.name}</h1>
            <p className="text-xs text-white/40">{match?.competition?.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={undo} disabled={historyIndex <= 0} className="p-2 hover:bg-white/10 rounded-lg disabled:opacity-50">
              <RotateCcw size={20} className="rotate-180" />
            </button>
            <button onClick={redo} disabled={historyIndex >= history.length - 1} className="p-2 hover:bg-white/10 rounded-lg disabled:opacity-50">
              <RotateCcw size={20} />
            </button>
            <button onClick={saveMatchState} className="p-2 hover:bg-white/10 rounded-lg">
              <Save size={20} />
            </button>
          </div>
        </div>
        
        {/* Scoreboard */}
        <div className="glass rounded-[3rem] p-12 mb-8">
          <div className="flex items-center justify-around">
            <div className="text-center">
              <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic mb-4">
                {homeTeam?.short_name?.[0]}
              </div>
              <h3 className="text-lg font-black uppercase">{homeTeam?.name}</h3>
            </div>
            
            <div className="text-center">
              <div className="text-8xl font-black italic mb-4">
                <span className="text-brand-green">{homeScore}</span>
                <span className="text-white/10 mx-4">-</span>
                <span className="text-brand-green">{awayScore}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock size={20} className="text-brand-green" />
                <span className="text-2xl font-black text-brand-green">{minute}'</span>
              </div>
              <p className="text-xs text-white/40 uppercase mt-2">{matchStatus.replace('_', ' ')}</p>
            </div>
            
            <div className="text-center">
              <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic mb-4">
                {awayTeam?.short_name?.[0]}
              </div>
              <h3 className="text-lg font-black uppercase">{awayTeam?.name}</h3>
            </div>
          </div>
        </div>
        
        {/* Controls */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {matchStatus === 'waiting' && (
            <button onClick={startFirstHalf} className="gradient-green text-black py-6 rounded-xl font-black uppercase tracking-widest">
              Kick Off
            </button>
          )}
          {isTimerRunning ? (
            <button onClick={pauseMatch} className="bg-yellow-500 text-black py-6 rounded-xl font-black uppercase tracking-widest">
              Pause
            </button>
          ) : matchStatus !== 'waiting' && matchStatus !== 'full_time' && (
            <button onClick={resumeMatch} className="gradient-green text-black py-6 rounded-xl font-black uppercase tracking-widest">
              Resume
            </button>
          )}
          {matchStatus === 'first_half' && (
            <button onClick={endFirstHalf} className="bg-brand-blue text-black py-6 rounded-xl font-black uppercase tracking-widest">
              Half Time
            </button>
          )}
          {matchStatus === 'half_time' && (
            <button onClick={startSecondHalf} className="gradient-green text-black py-6 rounded-xl font-black uppercase tracking-widest">
              Second Half
            </button>
          )}
          {(matchStatus === 'first_half' || matchStatus === 'second_half') && (
            <button onClick={endMatch} className="bg-brand-red text-white py-6 rounded-xl font-black uppercase tracking-widest">
              Full Time
            </button>
          )}
        </div>
        
        {/* Tabs */}
        <div className="flex gap-4 mb-8">
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
            onClick={() => setActiveTab('commentary')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'commentary' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <MessageSquare size={16} /> Commentary
          </button>
        </div>
        
        {/* Tab Content */}
        <div className="glass rounded-[2rem] p-8 min-h-[400px]">
          {activeTab === 'events' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Match Events</h3>
              <div className="space-y-2">
                {events.map((event, i) => (
                  <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/5">
                    <span className="text-sm font-black text-brand-green w-12">{event.minute}'</span>
                    <span className="text-lg">{event.event_type === 'goal' ? '' : event.event_type.includes('card') ? '🟨' : '📋'}</span>
                    <span className="text-sm">{event.event_type.replace('_', ' ')} {event.description || ''}</span>
                  </div>
                ))}
                {events.length === 0 && (
                  <p className="text-white/40 text-center py-8">No events yet</p>
                )}
              </div>
            </div>
          )}
          
          {activeTab === 'stats' && (
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Match Statistics</h3>
              <div className="space-y-4">
                {Object.entries(stats).map(([key, value]: [string, any]) => (
                  <div key={key} className="flex items-center justify-between p-4 rounded-xl bg-white/5">
                    <span className="text-sm text-white/60">{key.replace('_', ' ')}</span>
                    <span className="text-lg font-black">{value}</span>
                  </div>
                ))}
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
                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
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
                  <p className="text-white/40 text-center py-8">No commentary yet</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
