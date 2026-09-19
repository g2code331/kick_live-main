import { useMemo, useState } from 'react';
import { Bell, Send, Loader2, CheckCircle2, AlertTriangle, Users, User, Megaphone } from 'lucide-react';
import AdminPageShell from './AdminPageShell';
import {
  ADMIN_BROADCAST_KINDS,
  NOTIFICATION_AUDIENCES,
  sendNotification,
  type AdminBroadcastKind,
  type NotificationAudienceId,
  type BroadcastResult,
} from '../../../lib/data/admin-notifications';

interface NotificationSenderProps {
  /** Return to the tab the admin came from. */
  onBack: () => void;
}

const TITLE_MAX = 120;
const BODY_MAX = 480;

export default function NotificationSender({ onBack }: NotificationSenderProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AdminBroadcastKind>('announcement');
  const [audience, setAudience] = useState<NotificationAudienceId>('everyone');
  const [userId, setUserId] = useState('');
  const [confirmLarge, setConfirmLarge] = useState(false);

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const needsUser = audience === 'user';
  const canSend = useMemo(() => {
    if (!title.trim() || !body.trim()) return false;
    if (title.length > TITLE_MAX || body.length > BODY_MAX) return false;
    if (needsUser && !userId.trim()) return false;
    return true;
  }, [title, body, needsUser, userId]);

  const reset = () => {
    setTitle('');
    setBody('');
    setUserId('');
    setConfirmLarge(false);
  };

  const handleSend = async () => {
    if (!canSend || sending) return;
    setSending(true);
    setResult(null);
    setError(null);
    const res = await sendNotification({
      title: title.trim(),
      body: body.trim(),
      kind,
      audience,
      userId: needsUser ? userId.trim() : null,
      confirm: confirmLarge,
    });
    setSending(false);
    if (res.ok) {
      setResult(res.data);
      reset();
    } else {
      // The Worker wraps a SQL refusal as VALIDATION_FAILED and rides the real reason in fields.reason;
      // fall back to the transport code for network/404s.
      const reason = (res.fields?.find((f) => f.field === 'reason')?.message ?? res.code ?? '').toUpperCase();
      if (reason === 'CONFIRMATION_REQUIRED') {
        setConfirmLarge(true);
        setError('This audience is large. Tick “Confirm large send” and send again.');
      } else if (reason === 'AUDIENCE_TOO_LARGE') {
        setError('That audience is larger than this deployment will push to in one request.');
      } else if (res.status === 404) {
        setError(
          'The targeted-send endpoint is not deployed on this environment yet. “Everyone” broadcasts still work.',
        );
      } else {
        setError(res.message || 'Could not queue the notification. Please try again.');
      }
    }
  };

  return (
    <AdminPageShell
      title="Send Notification"
      icon={<Bell size={20} />}
      onBack={onBack}
      backLabel="Admin"
    >
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Audience */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/50 mb-4">
            <Users size={14} /> Audience
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {NOTIFICATION_AUDIENCES.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAudience(a.id)}
                className={`text-left rounded-xl border p-3 transition-all ${
                  audience === a.id
                    ? 'border-brand-green bg-brand-green/10'
                    : 'border-white/10 bg-white/[0.02] hover:border-white/25'
                }`}
              >
                <span className="block text-sm font-bold text-white">{a.label}</span>
                <span className="block text-[11px] text-white/40">{a.desc}</span>
              </button>
            ))}
          </div>
          {needsUser && (
            <div className="mt-4">
              <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-white/50 mb-2">
                <User size={13} /> Target user ID
              </label>
              <input
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="Profile UUID"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
              />
            </div>
          )}
        </section>

        {/* Kind */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-white/50 mb-4">
            <Megaphone size={14} /> Category
          </h3>
          <div className="flex flex-wrap gap-2">
            {ADMIN_BROADCAST_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setKind(k.id)}
                title={k.desc}
                className={`rounded-full border px-4 py-2 text-xs font-bold transition-all ${
                  kind === k.id
                    ? 'border-brand-green bg-brand-green/10 text-white'
                    : 'border-white/10 bg-white/[0.02] text-white/50 hover:border-white/25'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </section>

        {/* Message */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-widest text-white/50">Message</h3>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-white/50">Title</label>
              <span className={`text-[10px] ${title.length > TITLE_MAX ? 'text-red-400' : 'text-white/30'}`}>
                {title.length}/{TITLE_MAX}
              </span>
            </div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Matchday 12 kicks off tonight"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-white/50">Body</label>
              <span className={`text-[10px] ${body.length > BODY_MAX ? 'text-red-400' : 'text-white/30'}`}>
                {body.length}/{BODY_MAX}
              </span>
            </div>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Write the notification your audience will see…"
              className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-white/60">
            <input
              type="checkbox"
              checked={confirmLarge}
              onChange={(e) => setConfirmLarge(e.target.checked)}
              className="accent-brand-green"
            />
            Confirm large send (required above the audience cap)
          </label>
        </section>

        {result && (
          <div className="flex items-start gap-3 rounded-xl border border-brand-green/40 bg-brand-green/10 p-4 text-sm text-white">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-brand-green" />
            <div>
              <p className="font-bold">Queued for delivery.</p>
              <p className="text-white/60 text-xs mt-1">
                {typeof result.audience === 'number' ? `${result.audience.toLocaleString()} recipient(s). ` : ''}
                Status: {result.status}
                {result.jobId != null ? ` · job #${result.jobId}` : ''}
                {result.note ? ` · ${result.note}` : ''}
              </p>
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-white">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
            <p>{error}</p>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend || sending}
            className="flex items-center gap-2 rounded-xl bg-brand-green px-6 py-3 text-sm font-bold text-black transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            {sending ? 'Sending…' : 'Send Notification'}
          </button>
        </div>
      </div>
    </AdminPageShell>
  );
}
