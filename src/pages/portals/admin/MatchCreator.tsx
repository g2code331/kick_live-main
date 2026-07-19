import { useState, useEffect } from 'react';
import { X, Calendar, Trophy, Users, MapPin, Video, Heart, Zap } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface MatchCreatorProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export default function MatchCreator({ isOpen, onClose, onCreated }: MatchCreatorProps) {
  const [competitions, setCompetitions] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    competition_id: '',
    home_team_id: '',
    away_team_id: '',
    start_date: '',
    start_time: '',
    venue: '',
    match_type: 'league'
  });

  useEffect(() => {
    if (isOpen) {
      loadCompetitions();
      loadTeams();
    }
  }, [isOpen]);

  async function loadCompetitions() {
    const { data } = await supabase.from('competitions').select('id, name, type').order('name').limit(20);
    setCompetitions(data || []);
  }

  async function loadTeams() {
    const { data } = await supabase.from('teams').select('id, name, short_name').order('name').limit(50);
    setTeams(data || []);
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const { error } = await supabase.from('matches').insert([{
        competition_id: parseInt(formData.competition_id),
        home_team_id: parseInt(formData.home_team_id),
        away_team_id: parseInt(formData.away_team_id),
        start_time: `${formData.start_date}T${formData.start_time}:00`,
        venue: formData.venue,
        status: 'scheduled'
      }]);

      if (error) throw error;

      alert('Match created successfully!');
      onCreated();
      onClose();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      <div className="relative w-full max-w-4xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-8 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 gradient-green rounded-2xl flex items-center justify-center">
              <Calendar className="text-black" size={24} />
            </div>
            <div>
              <h2 className="text-2xl font-black italic uppercase tracking-tighter">Match Creator</h2>
              <p className="text-[10px] text-white/40 uppercase tracking-widest">Schedule New Fixture</p>
            </div>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full"><X /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Left Column: Match Type & Details */}
            <div className="space-y-6">
              {/* Match Type Selection */}
              <div>
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-4 block">Select Match Type</label>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'league', label: 'League Match', icon: <Trophy size={16} /> },
                    { id: 'cup', label: 'Cup Match', icon: <Trophy size={16} /> },
                    { id: 'friendly', label: 'Friendly', icon: <Heart size={16} /> },
                    { id: 'quick', label: 'Quick Match', icon: <Zap size={16} /> },
                  ].map((type) => (
                    <button
                      key={type.id}
                      type="button"
                      onClick={() => setFormData(prev => ({ ...prev, match_type: type.id }))}
                      className={`p-4 rounded-xl border transition-all text-left flex items-center gap-3 ${
                        formData.match_type === type.id
                          ? 'border-brand-green bg-brand-green/10'
                          : 'border-white/10 bg-white/5 hover:border-white/20'
                      }`}
                    >
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        formData.match_type === type.id ? 'bg-brand-green text-black' : 'bg-white/10 text-white/40'
                      }`}>
                        {type.icon}
                      </div>
                      <span className="text-xs font-bold">{type.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Venue & Location */}
              <div>
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Venue & Location</label>
                <div className="relative">
                  <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                  <input
                    type="text"
                    value={formData.venue}
                    onChange={(e) => setFormData(prev => ({ ...prev, venue: e.target.value }))}
                    placeholder="e.g. Accra Sports Stadium"
                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-12 pr-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>

              {/* Date & Time */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Date</label>
                  <input
                    type="date"
                    value={formData.start_date}
                    onChange={(e) => setFormData(prev => ({ ...prev, start_date: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest mb-2 block">Time</label>
                  <input
                    type="time"
                    value={formData.start_time}
                    onChange={(e) => setFormData(prev => ({ ...prev, start_time: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                  />
                </div>
              </div>
            </div>

            {/* Right Column: Team Selection */}
            <div className="space-y-6">
              <div className="glass rounded-[2rem] p-6">
                <h3 className="text-sm font-black uppercase mb-6">Versus Setup</h3>
                <p className="text-[10px] text-white/40 mb-6">Choose competing teams</p>
                
                <div className="flex items-center justify-center gap-6 mb-6">
                  {/* Home Team */}
                  <div className="flex-1">
                    <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Home Team</label>
                    <select
                      value={formData.home_team_id}
                      onChange={(e) => setFormData(prev => ({ ...prev, home_team_id: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                    >
                      <option value="">Select Home</option>
                      {teams.map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ))}
                    </select>
                  </div>

                  <div className="text-2xl font-black text-white/40">VS</div>

                  {/* Away Team */}
                  <div className="flex-1">
                    <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Away Team</label>
                    <select
                      value={formData.away_team_id}
                      onChange={(e) => setFormData(prev => ({ ...prev, away_team_id: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-green/50"
                    >
                      <option value="">Select Away</option>
                      {teams.map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Broadcast Options */}
              <div className="glass rounded-[2rem] p-6">
                <h3 className="text-sm font-black uppercase mb-4">Official Broadcast Options</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5">
                    <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                    <div className="flex items-center gap-2">
                      <Video size={16} className="text-brand-red" />
                      <span className="text-xs font-bold">Broadcast Live</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5">
                    <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                    <div className="flex items-center gap-2">
                      <Heart size={16} className="text-brand-blue" />
                      <span className="text-xs font-bold">Allow Predictions</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-4 mt-8 pt-8 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="px-8 py-3 rounded-xl bg-white/5 text-white font-black uppercase tracking-widest"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="gradient-green text-black px-12 py-3 rounded-xl font-black uppercase tracking-widest"
            >
              Create Match
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
