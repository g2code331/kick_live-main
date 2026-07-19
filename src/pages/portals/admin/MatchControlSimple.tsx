import { useState, useEffect } from 'react';
import { X, Play, Pause, RotateCcw, Clock } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MatchControlSimpleProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export default function MatchControlSimple({ match, isOpen, onClose, onUpdate }: MatchControlSimpleProps) {
  const [status, setStatus] = useState(match?.status || 'waiting');
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(match?.minute || 0);
  const [isTimerRunning, setIsTimerRunning] = useState(match?.status === 'live');

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
    await updateMatch();
  };

  const handleFullTime = async () => {
    setStatus('full_time');
    setIsTimerRunning(false);
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      <div className="relative w-full max-w-3xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden p-8">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-xl font-black italic uppercase tracking-tighter">Quick Match Control</h2>
            <p className="text-[10px] text-white/40 uppercase tracking-widest">{match?.competition || 'Competition'}</p>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full"><X /></button>
        </div>

        {/* Scoreboard */}
        <div className="flex items-center justify-around mb-8">
          <div className="text-center">
            <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-2xl font-black italic mb-3">
              {match?.homeTeam?.short_name?.[0] || 'H'}
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest">{match?.homeTeam?.name || 'Home'}</h3>
          </div>

          <div className="text-center">
            <div className="text-5xl font-black italic tracking-tighter mb-3">
              <span className="text-brand-green">{homeScore}</span>
              <span className="text-white/10 mx-3">-</span>
              <span className="text-brand-green">{awayScore}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={16} className="text-brand-green" />
              <span className="text-xl font-black italic text-brand-green">{minute}'</span>
            </div>
          </div>

          <div className="text-center">
            <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-2xl font-black italic mb-3">
              {match?.awayTeam?.short_name?.[0] || 'A'}
            </div>
            <h3 className="text-sm font-black uppercase tracking-widest">{match?.awayTeam?.name || 'Away'}</h3>
          </div>
        </div>

        {/* Score Controls */}
        <div className="grid grid-cols-2 gap-8 mb-8">
          <div className="text-center">
            <p className="text-xs text-white/40 uppercase mb-3">Home Score</p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setHomeScore((s: number) => Math.max(0, s - 1))} className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold">-</button>
              <span className="text-3xl font-black text-brand-green w-12">{homeScore}</span>
              <button onClick={() => setHomeScore((s: number) => s + 1)} className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold">+</button>
            </div>
          </div>

          <div className="text-center">
            <p className="text-xs text-white/40 uppercase mb-3">Away Score</p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => setAwayScore((s: number) => Math.max(0, s - 1))} className="w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 text-2xl font-bold">-</button>
              <span className="text-3xl font-black text-brand-green w-12">{awayScore}</span>
              <button onClick={() => setAwayScore((s: number) => s + 1)} className="w-12 h-12 rounded-xl gradient-green text-black text-2xl font-bold">+</button>
            </div>
          </div>
        </div>

        {/* Match Status Controls */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
          {(status === 'first_half' || status === 'second_half') && (
            <button onClick={handleFullTime} className="bg-brand-red text-white py-4 rounded-xl font-black uppercase tracking-widest">
              Full Time
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
