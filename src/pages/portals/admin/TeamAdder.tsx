import { useState } from 'react';
import { X, Users, Save, Loader2, Shield } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

export default function TeamAdder({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    short_name: '',
    city: '',
    coach: '',
    venue: '',
    primaryColor: '#39FF14',
    secondaryColor: '#000000',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.from('teams').insert([formData]);
      if (error) throw error;
      alert('Club registered successfully!');
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
      <div className="relative w-full max-w-lg glass rounded-[2.5rem] p-8 border border-white/10 shadow-2xl animate-in zoom-in-95">
        <div className="flex justify-between items-start mb-8">
           <div className="flex items-center gap-3">
              <div className="w-10 h-10 gradient-green rounded-xl flex items-center justify-center">
                <Users size={20} className="text-black" />
              </div>
              <h2 className="text-xl font-black italic uppercase tracking-tighter">Register <span className="text-brand-green">Club</span></h2>
           </div>
           <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full"><X /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
           <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Club Name</label>
                 <input type="text" required value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:border-brand-green" placeholder="Kumasi United" />
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Short Name</label>
                 <input type="text" required maxLength={3} value={formData.short_name} onChange={e => setFormData({...formData, short_name: e.target.value.toUpperCase()})} className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:border-brand-green" placeholder="KUM" />
              </div>
           </div>

           <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">City</label>
                 <input type="text" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:border-brand-green" />
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Coach</label>
                 <input type="text" value={formData.coach} onChange={e => setFormData({...formData, coach: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm focus:border-brand-green" />
              </div>
           </div>

           <div className="flex gap-4">
              <div className="flex-1 space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Primary Color</label>
                 <input type="color" value={formData.primaryColor} onChange={e => setFormData({...formData, primaryColor: e.target.value})} className="w-full h-10 bg-transparent border-none cursor-pointer" />
              </div>
              <div className="flex-1 space-y-2">
                 <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Secondary Color</label>
                 <input type="color" value={formData.secondaryColor} onChange={e => setFormData({...formData, secondaryColor: e.target.value})} className="w-full h-10 bg-transparent border-none cursor-pointer" />
              </div>
           </div>

           <button disabled={loading} className="w-full gradient-green text-black py-4 rounded-xl font-black uppercase tracking-widest flex items-center justify-center gap-2">
              {loading ? <Loader2 size={18} className="animate-spin" /> : <><Save size={18} /> Complete Registration</>}
           </button>
        </form>
      </div>
    </div>
  );
}
