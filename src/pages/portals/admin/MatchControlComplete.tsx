import { useState, useEffect } from 'react';
import { X, Play, Pause, Square, Zap, AlertCircle, Share2, Clock, Trophy, Save, Loader2, MessageSquare, Activity } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MatchControlCompleteProps {
  match: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

export default function MatchControlComplete({ match, isOpen, onClose, onUpdate }: MatchControlCompleteProps) {
  const [status, setStatus] = useState(match?.status || 'scheduled');
  const [homeScore, setHomeScore] = useState(match?.home_score || 0);
  const [awayScore, setAwayScore] = useState(match?.away_score || 0);
  const [minute, setMinute] = useState(match?.minute || 0);
  const [isSaving, setIsSaving] = useState(false);
  const [isTimerRunning, setIsTimerRunning] = useState(match?.status === 'live');

  useEffect(() => {
    let interval: any;
    if (isTimerRunning && status === 'live') {
      interval = setInterval(() => {
        setMinute((m: number) => {
          if (m >= 90) {
            setIsTimerRunning(false);
            return 90;
          }
          return m + 1;
        });
      }, 60000);
    }
    return () => clearInterval(interval);
  }, [isTimerRunning, status]);

  const handleLiveUpdate = async () => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('matches')
        .update({
          home_score: homeScore,
          away_score: awayScore,
          minute: minute,
          status: status
        })
        .eq('id', match.id);

      if (error) throw error;
      alert('Match data broadcasted successfully!');
      onUpdate();
      onClose();
    } catch (err: any) {
      alert('Broadcast failed: ' + err.message);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      <div className="relative w-full max-w-5xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[85vh] animate-in slide-in-from-bottom-8 duration-500">
        
        {/* Top Bar */}
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
          <div className="flex items-center gap-6">
            <div className="px-4 py-1.5 bg-brand-red rounded-lg text-[10px] font-black uppercase tracking-widest animate-pulse">Live Control Center</div>
            <div>
              <h2 className="text-xl font-black italic uppercase tracking-tighter">{match?.competition}</h2>
              <p className="text-[10px] text-white/40 uppercase tracking-widest font-black">{match?.venue || 'Accra Sports Stadium'}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full transition-colors"><X /></button>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar p-8">
           <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* Scoreboard Area */}
              <div className="lg:col-span-8 space-y-8">
                 <div className="glass rounded-[3rem] p-12 flex items-center justify-around relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-brand-green/5 to-brand-blue/5 pointer-events-none"></div>
                    
                    {/* Home Team */}
                    <div className="text-center space-y-4 z-10">
                       <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-3xl font-black italic">
                         {match.homeTeam?.short_name?.[0]}
                       </div>
                       <h3 className="text-sm font-black uppercase tracking-widest">{match.homeTeam?.name}</h3>
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
                         {match.awayTeam?.short_name?.[0]}
                       </div>
                       <h3 className="text-sm font-black uppercase tracking-widest">{match.awayTeam?.name}</h3>
                        <div className="flex gap-2">
                           <button onClick={() => setAwayScore((s: number) => Math.max(0, s - 1))} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-xl font-bold">-</button>
                           <button onClick={() => setAwayScore((s: number) => s + 1)} className="w-8 h-8 rounded-lg gradient-green text-black font-black text-xl">+</button>
                        </div>
                    </div>
                 </div>

                 {/* Match Controls */}
                 <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <button 
                      onClick={() => { setStatus('live'); setIsTimerRunning(true); }}
                      className={`p-6 rounded-3xl border flex flex-col items-center gap-3 transition-all ${status === 'live' ? 'border-brand-green bg-brand-green/10' : 'border-white/5 bg-white/5'}`}
                    >
                       <Play size={24} className={status === 'live' ? 'text-brand-green' : 'text-white/20'} />
                       <span className="text-[10px] font-black uppercase tracking-widest">Kick Off</span>
                    </button>
                    <button 
                      onClick={() => setIsTimerRunning(!isTimerRunning)}
                      className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 transition-all hover:bg-white/10"
                    >
                       {isTimerRunning ? <Pause size={24} className="text-yellow-500" /> : <Play size={24} className="text-brand-green" />}
                       <span className="text-[10px] font-black uppercase tracking-widest">{isTimerRunning ? 'Pause Clock' : 'Resume'}</span>
                    </button>
                    <button 
                      onClick={() => { setStatus('half_time'); setIsTimerRunning(false); }}
                      className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 transition-all hover:bg-white/10"
                    >
                       <Clock size={24} className="text-brand-blue" />
                       <span className="text-[10px] font-black uppercase tracking-widest">Half Time</span>
                    </button>
                    <button 
                      onClick={() => { setStatus('finished'); setIsTimerRunning(false); }}
                      className="p-6 rounded-3xl border border-white/5 bg-white/5 flex flex-col items-center gap-3 transition-all hover:bg-brand-red/20"
                    >
                       <Square size={24} className="text-brand-red" />
                       <span className="text-[10px] font-black uppercase tracking-widest">Full Time</span>
                    </button>
                 </div>
              </div>

              {/* Action Log / Sidebar */}
              <div className="lg:col-span-4 space-y-6">
                 <div className="glass rounded-[2.5rem] p-8 border border-white/5 h-full">
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-6 flex items-center gap-2">
                       <Activity size={14}/> Match Events
                    </h4>
                    <div className="space-y-4">
                       <button className="w-full p-4 bg-white/5 rounded-2xl border border-white/5 flex items-center gap-4 hover:bg-white/10 transition-all text-left">
                          <div className="w-10 h-10 rounded-xl bg-brand-green/10 flex items-center justify-center text-brand-green">
                             <Zap size={18} />
                          </div>
                          <div>
                             <p className="text-xs font-black uppercase">Goal Scored</p>
                             <p className="text-[10px] text-white/30">Record a new goal event</p>
                          </div>
                       </button>
                       <button className="w-full p-4 bg-white/5 rounded-2xl border border-white/5 flex items-center gap-4 hover:bg-white/10 transition-all text-left">
                          <div className="w-10 h-10 rounded-xl bg-brand-red/10 flex items-center justify-center text-brand-red">
                             <AlertCircle size={18} />
                          </div>
                          <div>
                             <p className="text-xs font-black uppercase">Card Issued</p>
                             <p className="text-[10px] text-white/30">Yellow or Red card event</p>
                          </div>
                       </button>
                       <button className="w-full p-4 bg-white/5 rounded-2xl border border-white/5 flex items-center gap-4 hover:bg-white/10 transition-all text-left">
                          <div className="w-10 h-10 rounded-xl bg-brand-blue/10 flex items-center justify-center text-brand-blue">
                             <MessageSquare size={18} />
                          </div>
                          <div>
                             <p className="text-xs font-black uppercase">Add Commentary</p>
                             <p className="text-[10px] text-white/30">Real-time text update</p>
                          </div>
                       </button>
                    </div>
                 </div>
              </div>
           </div>
        </div>

        {/* Footer */}
        <div className="p-10 border-t border-white/10 flex items-center justify-end gap-4 bg-white/[0.02]">
           <button onClick={onClose} className="px-8 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-white/5 transition-colors">Discard</button>
           <button 
             onClick={handleLiveUpdate}
             disabled={isSaving}
             className="gradient-green text-black px-12 py-3 rounded-xl font-black uppercase text-xs tracking-widest shadow-[0_0_30px_rgba(57,255,20,0.3)] flex items-center gap-2 disabled:opacity-50"
           >
             {isSaving ? <Loader2 size={16} className="animate-spin" /> : <><Share2 size={16} /> Broadcast Changes</>}
           </button>
        </div>
      </div>
    </div>
  );
}
