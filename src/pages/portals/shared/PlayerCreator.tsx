import { useState, useEffect } from 'react';
import { User, Save, Loader2, CheckCircle2 } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import AdminPageShell from '../admin/AdminPageShell';
import EntityImageUploader from '../../../components/EntityImageUploader';

interface PlayerCreatorProps {
  /** Return to the previous screen (replaces the old modal onClose). */
  onBack: () => void;
  teamId?: number;
}

export default function PlayerCreator({ onBack, teamId }: PlayerCreatorProps) {
  const [loading, setLoading] = useState(false);
  const [teams, setTeams] = useState<any[]>([]);
  // After a successful insert we keep the new player so a photo can be attached (uploads need the row id).
  const [createdPlayer, setCreatedPlayer] = useState<{ id: number; name: string } | null>(null);
  const [photoUrl, setPhotoUrl] = useState('');
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
      const { data, error } = await supabase.from('players').insert([{
        name: formData.name,
        position: formData.position,
        number: parseInt(formData.number as string),
        team_id: parseInt(formData.team_id as string),
        nationality: formData.nationality,
        goals: 0,
        assists: 0
      }]).select('id, name').single();

      if (error) throw error;
      // Move to the "add a photo" step instead of leaving immediately — a new player can now get a picture.
      if (data) setCreatedPlayer({ id: data.id as number, name: data.name as string });
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const savePhoto = async () => {
    if (!createdPlayer || !photoUrl) { onBack(); return; }
    await supabase.from('players').update({ photo_url: photoUrl }).eq('id', createdPlayer.id);
    onBack();
  };

  // Step 2 — the player exists; offer a photo before returning to the squad.
  if (createdPlayer) {
    return (
      <AdminPageShell
        title={<><span className="text-brand-green">{createdPlayer.name}</span> added</>}
        subtitle="Add a photo (optional)"
        icon={<CheckCircle2 size={22} />}
        onBack={onBack}
        backLabel="Skip"
      >
        <div className="glass rounded-[2rem] border border-white/10 p-6 lg:p-8 max-w-xl space-y-6">
          <div className="flex items-center gap-3 text-brand-green">
            <CheckCircle2 size={20} />
            <p className="font-black uppercase text-sm tracking-widest">Player registered</p>
          </div>
          <EntityImageUploader
            kind="players"
            entityId={createdPlayer.id}
            currentUrl={photoUrl}
            label="Player Photo"
            shape="circle"
            placeholder={createdPlayer.name?.[0] || '?'}
            onUploaded={(url) => setPhotoUrl(url)}
            onError={(m) => alert(m)}
          />
          <div className="flex gap-3 pt-2">
            <button onClick={onBack} className="flex-1 py-3 rounded-xl bg-white/5 font-black uppercase text-sm tracking-widest hover:bg-white/10">
              Skip
            </button>
            <button onClick={savePhoto} disabled={!photoUrl}
              className="flex-1 py-3 rounded-xl gradient-green text-black font-black uppercase text-sm tracking-widest flex items-center justify-center gap-2 disabled:opacity-50">
              <Save size={16} /> Save Photo
            </button>
          </div>
        </div>
      </AdminPageShell>
    );
  }

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
