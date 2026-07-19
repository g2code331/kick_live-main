import { useState, useEffect } from 'react';
import { X, User, Shield, Target, Award, Save, Loader2, Search } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface PlayerCreatorProps {
  isOpen: boolean;
  onClose: () => void;
  teamId?: number;
}

export default function PlayerCreator({ isOpen, onClose, teamId }: PlayerCreatorProps) {
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    name: '',
    position: 'Forward',
    number: '',
    team_id: teamId || '',
    nationality: 'Ghana',
  });

  useEffect(() => {
    async function loadTeams() {
      const { data } = await supabase.from('teams').select('id, name');
      setTeams(data || []);
    }
    loadTeams();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.from('players').insert([{
        name: formData.name,
        position: formData.position,
        number: parseInt(formData.number as string),
        team_id: parseInt(formData.team_id as string),
        nationality: formData.nationality,
        goals: 0,
        assists: 0
      }]);

      if (error) throw error;
      alert('Player created successfully!');
      onClose();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose}></div>
      <div className="relative w-full max-w-lg glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
        <div className="p-8 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-brand-green/10 to-transparent">
          <div className="flex items-center gap-3">
             <div className="w-10 h-10 gradient-green rounded-xl flex items-center justify-center">
               <User className="text-black" size={20} />
             </div>
             <div>
               <h2 className="text-xl font-black italic uppercase tracking-tighter">Add New <span className="text-brand-green">Player</span></h2>
               <p className="text-[10px] text-white/40 uppercase font-black tracking-widest">Squad Registration</p>
             </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-8 space-y-6">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Full Name</label>
            <input
              type="text"
              required
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-brand-green/50 transition-colors"
              placeholder="e.g. Mohammed Kudus"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Position</label>
              <select
                value={formData.position}
                onChange={e => setFormData({...formData, position: e.target.value})}
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-brand-green/50 appearance-none"
              >
                <option>Goalkeeper</option>
                <option>Defender</option>
                <option>Midfielder</option>
                <option>Forward</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Jersey Number</label>
              <input
                type="number"
                required
                value={formData.number}
                onChange={e => setFormData({...formData, number: e.target.value})}
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-brand-green/50"
                placeholder="10"
              />
            </div>
          </div>

          {!teamId && (
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40">Assign to Team</label>
              <select
                required
                value={formData.team_id}
                onChange={e => setFormData({...formData, team_id: e.target.value})}
                className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:outline-none focus:border-brand-green/50"
              >
                <option value="">Select Team</option>
                {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}

          <div className="pt-4">
            <button
              type="submit"
              disabled={loading}
              className="w-full gradient-green text-black font-black uppercase tracking-widest py-4 rounded-xl flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <><Save size={18} /> Register Player</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
