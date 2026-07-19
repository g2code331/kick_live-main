import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface EventModalProps {
  eventType: string;
  homeTeam: any;
  awayTeam: any;
  allPlayers: any[];
  currentMinute: number;
  onSubmit: (data: any) => void;
  onClose: () => void;
}

export default function EventModal({ eventType, homeTeam, awayTeam, allPlayers, currentMinute, onSubmit, onClose }: EventModalProps) {
  const [teamId, setTeamId] = useState<string>('');
  const [playerId, setPlayerId] = useState<string>('');
  const [assistId, setAssistId] = useState<string>('');
  const [minute, setMinute] = useState(currentMinute.toString());
  const [goalType, setGoalType] = useState('normal');
  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');

  const homePlayers = allPlayers.filter(p => p.team_id === homeTeam?.id);
  const awayPlayers = allPlayers.filter(p => p.team_id === awayTeam?.id);
  const selectedPlayers = teamId === homeTeam?.id?.toString() ? homePlayers : awayPlayers;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const eventData = {
      eventType,
      teamId: parseInt(teamId),
      playerId: parseInt(playerId),
      assistId: assistId ? parseInt(assistId) : null,
      minute: parseInt(minute),
      goalType: eventType === 'goal' ? goalType : null,
      reason: eventType.includes('card') ? reason : null,
      description
    };
    
    onSubmit(eventData);
  };

  const getEventTitle = () => {
    switch (eventType) {
      case 'goal': return 'GOAL';
      case 'yellow_card': return 'YELLOW CARD';
      case 'red_card': return 'RED CARD';
      case 'second_yellow': return 'SECOND YELLOW';
      case 'substitution': return 'SUBSTITUTION';
      case 'penalty': return 'PENALTY';
      default: return eventType.toUpperCase().replace('_', ' ');
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose}></div>
      <div className="relative w-full max-w-md glass rounded-[2rem] border border-white/10 shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="p-6 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-xl font-black uppercase">{getEventTitle()}</h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          
          {/* Team Selection */}
          <div>
            <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Team</label>
            <select
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                setPlayerId('');
                setAssistId('');
              }}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              required
            >
              <option value="">Select Team</option>
              <option value={homeTeam?.id}>{homeTeam?.name}</option>
              <option value={awayTeam?.id}>{awayTeam?.name}</option>
            </select>
          </div>

          {/* Player Selection */}
          <div>
            <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Player</label>
            <select
              value={playerId}
              onChange={(e) => setPlayerId(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              required
              disabled={!teamId}
            >
              <option value="">Select Player</option>
              {selectedPlayers.map(player => (
                <option key={player.id} value={player.id}>
                  {player.number} - {player.name}
                </option>
              ))}
            </select>
          </div>

          {/* Goal Type (for goals only) */}
          {eventType === 'goal' && (
            <div>
              <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Goal Type</label>
              <select
                value={goalType}
                onChange={(e) => setGoalType(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              >
                <option value="normal">Normal Goal</option>
                <option value="header">Header</option>
                <option value="penalty">Penalty</option>
                <option value="free_kick">Free Kick</option>
                <option value="own_goal">Own Goal</option>
                <option value="volley">Volley</option>
                <option value="long_shot">Long Shot</option>
              </select>
            </div>
          )}

          {/* Assist (for goals only) */}
          {eventType === 'goal' && (
            <div>
              <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Assist (Optional)</label>
              <select
                value={assistId}
                onChange={(e) => setAssistId(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              >
                <option value="">No Assist</option>
                {selectedPlayers.filter(p => p.id.toString() !== playerId).map(player => (
                  <option key={player.id} value={player.id}>
                    {player.number} - {player.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Card Reason (for cards only) */}
          {eventType.includes('card') && (
            <div>
              <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Unsporting behavior"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              />
            </div>
          )}

          {/* Minute */}
          <div>
            <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Minute</label>
            <input
              type="number"
              value={minute}
              onChange={(e) => setMinute(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Description (Optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Additional notes..."
              rows={3}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-3 rounded-xl gradient-green text-black font-black uppercase tracking-widest hover:opacity-90 transition-opacity"
            >
              Confirm
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
