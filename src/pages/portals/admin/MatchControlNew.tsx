import { useState, useEffect } from 'react';
import { X, Play, Pause, RotateCcw, Clock, CheckCircle, Plus, MessageSquare, Activity } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MatchControlNewProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export default function MatchControlNew({ match, isOpen, onClose, onUpdate }: MatchControlNewProps) {
  const [status, setStatus] = useState(match?.status || 'waiting');
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(match?.minute || 0);
  const [isTimerRunning, setIsTimerRunning] = useState(match?.status === 'live');
  const [activeTab, setActiveTab] = useState<'events' | 'commentary'>('events');
  const [events, setEvents] = useState<any[]>([]);
  const [commentary, setCommentary] = useState<any[]>([]);
  const [newComment, setNewComment] = useState('');

  useEffect(() => {
    if (isTimerRunning && status !== 'waiting' && status !== 'full_time') {
      const interval = setInterval(() => {
        setMinute((m: number) => {
          if (m >= 90) {
            setIsTimerRunning(false);
            return 90;
          }
          return m + 1;
        });
      }, 60000);
      return () => clearInterval(interval);
    }
  }, [isTimerRunning, status]);

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
    setStatus('half_time');
    setIsTimerRunning(false);
    await addEvent('half_time', minute);
    await updateMatch();
  };

  const handleFullTime = async () => {
    setStatus('full_time');
    setIsTimerRunning(false);
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

  const addEvent = async (eventType: string, matchMinute: number) => {
    try {
      await supabase.from('match_events').insert([{
        match_id: match.id,
        event_type: eventType,
        minute: matchMinute
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

  useEffect(() => {
    if (isOpen) {
      loadEvents();
      loadCommentary();
    }
  }, [isOpen]);

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
      <div className="relative w-full max-w-5xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[85vh]">
        
        {/* Header */}
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
          <div>
            <h2 className="text-xl font-black italic uppercase tracking-tighter">Match Control</h2>
            <p className="text-[10px] text-white/40 uppercase tracking-widest">{match?.competition || 'Competition'}</p>
          </div>
          <div className="flex items-center gap-4">
            <span className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${isTimerRunning ? 'bg-brand-red text-white' : 'bg-white/10 text-white/40'}`}>
              {isTimerRunning ? '🔴 LIVE' : 'PAUSED'}
            </span>
            <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full"><X /></button>
          </div>
        </div>

        {/* Scoreboard */}
        <div className="p-12 flex items-center justify-around">
          <div className="text-center">
            <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic mb-4">
              {match?.homeTeam?.short_name?.[0] || 'H'}
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest">{match?.homeTeam?.name || 'Home'}</h3>
          </div>

          <div className="text-center">
            <div className="text-6xl font-black italic tracking-tighter mb-4">
              <span className="text-brand-green">{homeScore}</span>
              <span className="text-white/10 mx-4">-</span>
              <span className="text-brand-green">{awayScore}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={20} className="text-brand-green" />
              <span className="text-2xl font-black italic text-brand-green">{minute}'</span>
            </div>
            <p className="text-xs text-white/40 uppercase mt-2">{status.replace('_', ' ')}</p>
          </div>

          <div className="text-center">
            <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic mb-4">
              {match?.awayTeam?.short_name?.[0] || 'A'}
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest">{match?.awayTeam?.name || 'Away'}</h3>
          </div>
        </div>

        {/* Controls */}
        <div className="px-12 pb-8 grid grid-cols-4 gap-4">
          {status === 'waiting' && (
            <button onClick={handleKickoff} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Kick Off
            </button>
          )}
          {isTimerRunning ? (
            <button onClick={handlePause} className="bg-yellow-500 text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Pause
            </button>
          ) : status !== 'waiting' && status !== 'full_time' && (
            <button onClick={handleResume} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Resume
            </button>
          )}
          {(status === 'first_half' || status === 'second_half') && (
            <button onClick={handleHalfTime} className="bg-brand-blue text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Half Time
            </button>
          )}
          {status === 'half_time' && (
            <button onClick={() => setStatus('second_half')} className="gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest">
              Second Half
            </button>
          )}
          {(status === 'first_half' || status === 'second_half') && (
            <button onClick={handleFullTime} className="bg-brand-red text-white py-4 rounded-xl font-black uppercase tracking-widest">
              Full Time
            </button>
          )}
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
            onClick={() => setActiveTab('commentary')}
            className={`flex items-center gap-2 px-6 py-4 rounded-t-xl font-black uppercase tracking-widest text-sm ${activeTab === 'commentary' ? 'bg-white/10 text-white' : 'text-white/40'}`}
          >
            <MessageSquare size={16} /> Commentary
          </button>
        </div>

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div className="flex-1 overflow-y-auto p-8">
            <h3 className="text-sm font-black uppercase tracking-widest text-white/40 mb-4">Match Events</h3>
            <div className="space-y-2">
              {events.map((event, i) => (
                <div key={i} className="flex items-center gap-4 p-4 rounded-xl bg-white/5">
                  <span className="text-sm font-black text-brand-green w-12">{event.minute}'</span>
                  <span className="text-lg">
                    {event.event_type === 'goal' ? '' : event.event_type.includes('card') ? '🟨' : '📋'}
                  </span>
                  <span className="text-sm">{event.event_type.replace('_', ' ')} {event.description || ''}</span>
                </div>
              ))}
              {events.length === 0 && (
                <p className="text-white/40 text-center py-8">No events yet. Kick off to start!</p>
              )}
            </div>
          </div>
        )}

        {/* Commentary Tab */}
        {activeTab === 'commentary' && (
          <div className="flex-1 overflow-y-auto p-8 flex flex-col">
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
            <div className="flex-1 space-y-2">
              {commentary.map((comm, i) => (
                <div key={i} className="p-4 rounded-xl bg-white/5">
                  <span className="text-sm font-black text-brand-green">{comm.minute}'</span>
                  <span className="text-sm ml-2">{comm.comment}</span>
                </div>
              ))}
              {commentary.length === 0 && (
                <p className="text-white/40 text-center py-8">No commentary yet. Start typing!</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
