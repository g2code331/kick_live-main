import { useState, useEffect } from 'react';
import { User, Save, Loader2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import AdminPageShell from '../admin/AdminPageShell';

interface PlayerCreatorProps {
  /** Return to the previous screen (replaces the old modal onClose). */
  onBack: () => void;
  teamId?: number;
}

export default function PlayerCreator({ onBack, teamId }: PlayerCreatorProps) {
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
      onBack();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AdminPageShell
      title={<>Add New <span className="text-brand-green">Player</span></>}
      subtitle="Squad registration"
      icon={<User size={22} />}
      onBack={onBack}
    >
      <div className="glass rounded-[2rem] lg:rounded-[2.5rem] border border-white/10 overflow-hidden max-w-2xl">
        <form onSubmit={handleSubmit} className="p-6 lg:p-8 space-y-6">
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
    </AdminPageShell>
  );
}
