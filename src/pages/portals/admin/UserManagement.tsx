import { useState, useEffect, useCallback } from 'react';
import { User, Shield, Trash2, Mail, Loader2, CheckCircle, XCircle, Inbox } from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import type { UserRole } from '../../../lib/supabase';
import { cancelMyAccessRequest, decideAccessRequest, listPendingAccessRequests, setUserRole } from '../../../lib/access';
import type { AccessRequest } from '../../../lib/access';
import { log } from '../../../lib/log';

interface RowUser {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  created_at: string;
}

/**
 * Admin surface for identity.
 *
 * Role changes go through `kicklive_set_user_role` instead of `profiles.update({ role })` so that
 * (a) the *database* decides the caller may do it, not this component, (b) every grant lands in
 * `activity_logs`, and (c) the last admin cannot be demoted. This screen is a convenience, not the
 * security boundary — an attacker who skips it still cannot write `profiles.role`.
 */
export default function UserManagement() {
  const [users, setUsers] = useState<RowUser[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, pending] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, email, username, role, created_at')
        .order('created_at', { ascending: false })
        .limit(200),
      listPendingAccessRequests(),
    ]);
    setUsers((data || []) as RowUser[]);
    setRequests(pending);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRoleChange = async (userId: string, newRole: UserRole) => {
    setBusyId(userId);
    setNotice(null);
    const { ok, error } = await setUserRole(userId, newRole);
    if (ok) {
      setNotice({ kind: 'ok', text: 'Role updated and written to the audit log.' });
      await load();
    } else {
      log.warn('role change rejected');
      setNotice({ kind: 'error', text: error || 'Role change rejected' });
    }
    setBusyId(null);
  };

  const handleDecision = async (request: AccessRequest, decision: 'approved' | 'rejected') => {
    setBusyId(request.id);
    setNotice(null);
    const { ok, error } = await decideAccessRequest(request.id, decision);
    if (ok) {
      setNotice({
        kind: 'ok',
        text: decision === 'approved' ? `Granted ${request.requested_role.replace('_', ' ')} access.` : 'Request rejected.',
      });
      await load();
    } else {
      setNotice({ kind: 'error', text: error || 'Decision could not be saved' });
    }
    setBusyId(null);
  };

  const handleCancel = async (request: AccessRequest) => {
    setBusyId(request.id);
    const { error } = await cancelMyAccessRequest(request.id);
    if (error) setNotice({ kind: 'error', text: error });
    await load();
    setBusyId(null);
  };

  return (
    <div className="space-y-8 animate-in">
       <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className="text-2xl font-black italic uppercase tracking-tighter">User <span className="text-brand-green">Control</span></h2>
            <p className="text-xs text-white/40 uppercase tracking-widest font-black">Manage permissions and accounts</p>
          </div>
       </div>

      {notice && (
        <div
          className={`px-4 py-3 rounded-xl text-sm font-medium border ${
            notice.kind === 'ok'
              ? 'bg-brand-green/10 border-brand-green/30 text-brand-green'
              : 'bg-brand-red/10 border-brand-red/30 text-brand-red'
          }`}
          role="status"
        >
          {notice.text}
        </div>
      )}

      {/* Pending access requests */}
      <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
        <div className="px-8 py-5 bg-white/5 flex items-center gap-3">
          <Inbox size={16} className="text-brand-green" />
          <h3 className="text-[10px] font-black uppercase tracking-widest text-white/60">
            Access requests {requests.length > 0 ? `(${requests.length})` : ''}
          </h3>
        </div>
        {requests.length === 0 ? (
          <p className="px-8 py-6 text-xs text-white/30">
            Nothing waiting. Manager and media applications appear here after signup.
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {requests.map(r => (
              <li key={r.id} className="px-8 py-5 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-bold text-sm truncate">
                    {r.profiles?.username || 'Unknown user'}{' '}
                    <span className="text-white/30 font-normal">·</span>{' '}
                    <span className="text-brand-green uppercase tracking-widest text-[10px] font-black">
                      {r.requested_role.replace('_', ' ')}
                    </span>
                  </p>
                  <p className="text-[10px] text-white/30 flex items-center gap-1">
                    <Mail size={10} /> {r.profiles?.email} · {new Date(r.created_at).toLocaleDateString()}
                  </p>
                  {r.reason && <p className="text-xs text-white/40 mt-2 max-w-2xl whitespace-pre-line">{r.reason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDecision(r, 'approved')}
                    disabled={busyId === r.id}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-green/10 text-brand-green text-[10px] font-black uppercase tracking-widest hover:bg-brand-green/20 transition-colors disabled:opacity-40"
                  >
                    <CheckCircle size={14} /> Approve
                  </button>
                  <button
                    onClick={() => handleDecision(r, 'rejected')}
                    disabled={busyId === r.id}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 text-white/50 text-[10px] font-black uppercase tracking-widest hover:text-white transition-colors disabled:opacity-40"
                  >
                    <XCircle size={14} /> Reject
                  </button>
                  <button
                    onClick={() => handleCancel(r)}
                    disabled={busyId === r.id}
                    title="Mark as withdrawn"
                    className="px-3 py-2 rounded-lg text-white/20 hover:text-white/60 transition-colors disabled:opacity-40"
                  >
                    <XCircle size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
                      disabled={busyId === u.id}
                      onChange={e => handleRoleChange(u.id, e.target.value as UserRole)}
                      className="bg-white/5 border border-white/10 rounded-lg p-2 text-xs font-bold uppercase tracking-widest focus:outline-none disabled:opacity-40"
                    >
                      <option value="fan">Fan</option>
                      <option value="team_manager">Manager</option>
                      <option value="media">Media</option>
                      <option value="admin">Admin</option>
                    </select>
                    {busyId === u.id && (
                      <span className="ml-3 inline-flex items-center gap-1 text-[9px] uppercase tracking-widest text-white/30">
                        <Loader2 size={10} className="animate-spin" /> Saving
                      </span>
                    )}
                  </td>
                  <td className="px-8 py-6 text-xs text-white/40">{new Date(u.created_at).toLocaleDateString()}</td>
                  <td className="px-8 py-6 text-right">
                    <span className="inline-flex items-center gap-2 text-[9px] uppercase tracking-widest text-white/20 mr-4">
                      <Shield size={12} /> enforced in database
                    </span>
                    <button
                      className="text-brand-red p-2 hover:bg-brand-red/10 rounded-lg transition-colors"
                      title="Account deletion is not wired up yet — use the Supabase dashboard"
                      disabled
                    >
                      <Trash2 size={16} />
                    </button>
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
