import { useState, useEffect } from 'react';
import { User, Shield, Trash2, Mail, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

export default function UserManagement() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    setLoading(true);
    const { data } = await supabase.from('profiles').select('id, email, username, role, created_at').order('created_at', { ascending: false }).limit(50);
    setUsers(data || []);
    setLoading(false);
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId);
    if (!error) {
      alert('User role updated!');
      fetchUsers();
    }
  };

  return (
    <div className="space-y-8 animate-in">
       <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-black italic uppercase tracking-tighter">User <span className="text-brand-green">Control</span></h2>
            <p className="text-xs text-white/40 uppercase tracking-widest font-black">Manage permissions and accounts</p>
          </div>
       </div>

       {loading ? (
         <div className="flex justify-center py-20"><Loader2 className="animate-spin text-brand-green" /></div>
       ) : (
         <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
           <table className="w-full text-left">
             <thead>
               <tr className="bg-white/5 text-[10px] font-black uppercase tracking-widest text-white/30">
                 <th className="px-8 py-4">User</th>
                 <th className="px-8 py-4">Role</th>
                 <th className="px-8 py-4">Joined</th>
                 <th className="px-8 py-4 text-right">Actions</th>
               </tr>
             </thead>
             <tbody className="divide-y divide-white/5">
               {users.map(u => (
                 <tr key={u.id} className="hover:bg-white/[0.02]">
                   <td className="px-8 py-6">
                      <div className="flex items-center gap-3">
                         <div className="w-10 h-10 rounded-full bg-brand-green/10 flex items-center justify-center font-bold text-brand-green border border-brand-green/20">
                           {u.username?.[0] || 'U'}
                         </div>
                         <div>
                            <p className="font-bold">{u.username}</p>
                            <p className="text-[10px] text-white/30">{u.email}</p>
                         </div>
                      </div>
                   </td>
                   <td className="px-8 py-6">
                      <select 
                        value={u.role} 
                        onChange={e => handleRoleChange(u.id, e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-lg p-2 text-xs font-bold uppercase tracking-widest focus:outline-none"
                      >
                         <option value="fan">Fan</option>
                         <option value="team_manager">Manager</option>
                         <option value="media">Media</option>
                         <option value="admin">Admin</option>
                      </select>
                   </td>
                   <td className="px-8 py-6 text-xs text-white/40">{new Date(u.created_at).toLocaleDateString()}</td>
                   <td className="px-8 py-6 text-right">
                      <button className="text-brand-red p-2 hover:bg-brand-red/10 rounded-lg transition-colors"><Trash2 size={16} /></button>
                   </td>
                 </tr>
               ))}
             </tbody>
           </table>
         </div>
       )}
    </div>
  );
}
