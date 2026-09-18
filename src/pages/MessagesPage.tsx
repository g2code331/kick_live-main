import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  Send,
  Loader2,
  ArrowLeft,
  Plus,
  CheckCircle2,
  Circle,
  Lock,
  Unlock,
  Inbox,
} from 'lucide-react';
import Header from '../components/Header';
import { useAuth } from '../contexts/AuthContext';
import {
  listThreads,
  getThread,
  sendMessage,
  startThread,
  setThreadStatus,
  type MessageThreadSummary,
  type Message,
  type ThreadDetail,
} from '../lib/data/messages';

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function MessagesPage() {
  const navigate = useNavigate();
  const { user, profile } = useAuth();

  const [threads, setThreads] = useState<MessageThreadSummary[]>([]);
  const [staff, setStaff] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Composer for a brand-new conversation (non-staff) or a staff-initiated one.
  const [composing, setComposing] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newBody, setNewBody] = useState('');

  const endRef = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    const res = await listThreads();
    if (res.ok) {
      setThreads(res.data.threads ?? []);
      setStaff(Boolean(res.data.staff));
    }
    setLoadingList(false);
  }, []);

  useEffect(() => {
    if (!user) {
      navigate('/login');
      return;
    }
    void refreshList();
  }, [user, navigate, refreshList]);

  const openThread = useCallback(async (id: number) => {
    setActiveId(id);
    setComposing(false);
    setLoadingThread(true);
    setError(null);
    const res = await getThread(id);
    if (res.ok) {
      setDetail(res.data.thread);
      setMessages(res.data.messages ?? []);
      // Reading clears the unread dot locally without a second list fetch.
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread: false } : t)));
    } else {
      setError(res.message || 'Could not open this conversation.');
    }
    setLoadingThread(false);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!draft.trim() || activeId === null || sending) return;
    setSending(true);
    setError(null);
    const res = await sendMessage(activeId, draft.trim());
    setSending(false);
    if (res.ok) {
      setDraft('');
      await openThread(activeId);
      void refreshList();
    } else {
      setError(res.message || 'Message not sent.');
    }
  };

  const handleCreate = async () => {
    if (!newBody.trim() || sending) return;
    if (staff && !newUserId.trim()) {
      setError('Enter the user ID to message.');
      return;
    }
    setSending(true);
    setError(null);
    const res = staff
      ? await startThread(newUserId.trim(), newBody.trim(), newSubject.trim() || undefined)
      : await sendMessage(null, newBody.trim(), newSubject.trim() || undefined);
    setSending(false);
    if (res.ok) {
      setNewBody('');
      setNewSubject('');
      setNewUserId('');
      setComposing(false);
      await refreshList();
      void openThread(res.data.threadId);
    } else {
      setError(res.message || 'Could not start the conversation.');
    }
  };

  const handleToggleStatus = async () => {
    if (!detail) return;
    const next = detail.status === 'open' ? 'closed' : 'open';
    const res = await setThreadStatus(detail.id, next);
    if (res.ok) {
      setDetail({ ...detail, status: next });
      void refreshList();
    }
  };

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-xl border border-white/10 bg-white/[0.03] hover:border-white/25 transition-all"
            aria-label="Back"
          >
            <ArrowLeft size={18} className="text-white/70" />
          </button>
          <div className="flex items-center gap-2">
            <MessageSquare size={22} className="text-brand-green" />
            <h1 className="text-xl font-black text-white">Messages</h1>
          </div>
          {staff && (
            <span className="ml-2 rounded-full border border-brand-green/40 bg-brand-green/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-brand-green">
              Staff desk
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4">
          {/* Thread list */}
          <aside className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden flex flex-col max-h-[70vh]">
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <span className="text-xs font-bold uppercase tracking-widest text-white/50">
                {staff ? 'All conversations' : 'Your conversations'}
              </span>
              <button
                onClick={() => {
                  setComposing(true);
                  setActiveId(null);
                  setError(null);
                }}
                className="flex items-center gap-1 rounded-lg bg-brand-green px-2.5 py-1.5 text-[11px] font-bold text-black hover:brightness-110 transition-all"
              >
                <Plus size={13} /> New
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {loadingList ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={22} className="animate-spin text-white/30" />
                </div>
              ) : threads.length === 0 ? (
                <div className="text-center py-16 px-4">
                  <Inbox size={40} className="mx-auto text-white/10 mb-3" />
                  <p className="text-white/30 text-sm font-medium">No conversations yet</p>
                </div>
              ) : (
                threads.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => void openThread(t.id)}
                    className={`w-full text-left px-4 py-3 border-b border-white/5 transition-all ${
                      activeId === t.id ? 'bg-brand-green/10' : 'hover:bg-white/[0.03]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-white truncate">
                        {staff ? t.user_name || 'Unknown user' : t.subject || 'Support'}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {t.status === 'closed' && <Lock size={11} className="text-white/25" />}
                        {t.unread && <span className="w-2 h-2 rounded-full bg-brand-green" />}
                      </span>
                    </div>
                    {staff && t.subject && (
                      <span className="block text-[11px] text-white/40 truncate">{t.subject}</span>
                    )}
                    <span className="block text-xs text-white/40 truncate mt-0.5">
                      {t.last_message_preview || '—'}
                    </span>
                    <span className="block text-[10px] text-white/25 mt-1">{timeAgo(t.last_message_at)}</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          {/* Conversation / composer */}
          <section className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden flex flex-col max-h-[70vh] min-h-[420px]">
            {composing ? (
              <div className="p-5 space-y-4">
                <h2 className="text-sm font-bold uppercase tracking-widest text-white/50">
                  {staff ? 'Message a user' : 'New message to staff'}
                </h2>
                {staff && (
                  <input
                    value={newUserId}
                    onChange={(e) => setNewUserId(e.target.value)}
                    placeholder="Target user ID (UUID)"
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
                  />
                )}
                <input
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  placeholder="Subject (optional)"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
                />
                <textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  rows={5}
                  placeholder="Write your message…"
                  className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none"
                />
                {error && <p className="text-sm text-red-400">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setComposing(false)}
                    className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-white/60 hover:border-white/25 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={sending || !newBody.trim()}
                    className="flex items-center gap-2 rounded-xl bg-brand-green px-5 py-2.5 text-sm font-bold text-black transition-all hover:brightness-110 disabled:opacity-40"
                  >
                    {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                    Send
                  </button>
                </div>
              </div>
            ) : activeId === null ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                <MessageSquare size={48} className="text-white/10 mb-4" />
                <p className="text-white/30 font-medium">Select a conversation, or start a new one</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between p-4 border-b border-white/10">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-white truncate">
                      {detail?.subject || (staff ? 'Conversation' : 'Support')}
                    </p>
                    {detail && (
                      <p className="text-[11px] text-white/40 flex items-center gap-1">
                        {detail.status === 'open' ? (
                          <>
                            <Circle size={9} className="text-brand-green fill-brand-green" /> Open
                          </>
                        ) : (
                          <>
                            <Lock size={10} /> Closed
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  {detail && (
                    <button
                      onClick={handleToggleStatus}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-bold text-white/60 hover:border-white/25 transition-all"
                    >
                      {detail.status === 'open' ? <Lock size={12} /> : <Unlock size={12} />}
                      {detail.status === 'open' ? 'Close' : 'Reopen'}
                    </button>
                  )}
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {loadingThread ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 size={22} className="animate-spin text-white/30" />
                    </div>
                  ) : (
                    messages.map((m) => {
                      // "Mine" is a right-aligned bubble: for staff that's the staff messages, for a user
                      // that's their own (non-staff) messages.
                      const mine = m.sender_id === profile?.id;
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[78%] rounded-2xl px-4 py-2.5 ${
                              mine
                                ? 'bg-brand-green/15 border border-brand-green/30'
                                : 'bg-white/[0.05] border border-white/10'
                            }`}
                          >
                            <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">
                              {m.sender_is_staff ? 'Staff' : m.sender_name || 'User'}
                            </p>
                            <p className="text-sm text-white whitespace-pre-wrap break-words">{m.body}</p>
                            <p className="text-[10px] text-white/25 mt-1 text-right">{timeAgo(m.created_at)}</p>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={endRef} />
                </div>

                {error && <p className="px-4 text-sm text-red-400">{error}</p>}

                {detail?.status === 'closed' ? (
                  <div className="p-4 border-t border-white/10 text-center">
                    <p className="text-xs text-white/30 flex items-center justify-center gap-1.5">
                      <CheckCircle2 size={13} /> This conversation is closed. Reopen it to reply.
                    </p>
                  </div>
                ) : (
                  <div className="p-3 border-t border-white/10 flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                      rows={1}
                      placeholder="Type a message…"
                      className="flex-1 resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder-white/25 focus:border-brand-green focus:outline-none max-h-32"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !draft.trim()}
                      className="flex items-center justify-center rounded-xl bg-brand-green w-11 h-11 shrink-0 text-black transition-all hover:brightness-110 disabled:opacity-40"
                      aria-label="Send"
                    >
                      {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
