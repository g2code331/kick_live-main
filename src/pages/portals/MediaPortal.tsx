import { useState, useEffect, useCallback } from 'react';
import {
  Newspaper, LogOut, TrendingUp, Eye, Clock, Plus,
  Edit, Trash2, CheckCircle2, XCircle, Loader2, RefreshCw, X, Save,
  Upload, BarChart3, FileText, Search
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import MediaPublisher from './shared/MediaPublisher';

interface MediaPortalProps {
  onNavigate: (page: string) => void;
}

type MTab = 'overview' | 'articles';

function useMsg() {
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const show = (type: 'success' | 'error', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };
  return { msg, success: (t: string) => show('success', t), error: (t: string) => show('error', t) };
}

const CATEGORY_COLORS: Record<string, string> = {
  'News': 'text-brand-green bg-brand-green/10',
  'Match Report': 'text-blue-400 bg-blue-400/10',
  'Interview': 'text-purple-400 bg-purple-400/10',
  'Announcement': 'text-yellow-400 bg-yellow-400/10',
  'Transfer': 'text-red-400 bg-red-400/10',
  'Opinion': 'text-orange-400 bg-orange-400/10',
};

const FALLBACK_IMG = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&auto=format&fit=crop';

export default function MediaPortal({ onNavigate }: MediaPortalProps) {
  const { profile, signOut } = useAuth();
  const [activeTab, setActiveTab] = useState<MTab>('overview');
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [publisherOpen, setPublisherOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { msg, success, error } = useMsg();

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('media')
      .select('id, title, excerpt, category, image_url, views, featured, published, created_at, author_id')
      .order('created_at', { ascending: false })
      .limit(100);
    setArticles(data || []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  const handleSignOut = async () => {
    await signOut();
    onNavigate('/');
  };

  const togglePublished = async (article: any) => {
    const { error: err } = await supabase
      .from('media')
      .update({ published: !article.published })
      .eq('id', article.id);
    if (err) { error('Failed to update'); return; }
    success(article.published ? 'Article unpublished' : 'Article published');
    fetchArticles();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { error: err } = await supabase.from('media').delete().eq('id', deleteTarget.id);
    if (err) { error('Delete failed'); return; }
    success('Article deleted');
    setDeleteTarget(null);
    fetchArticles();
  };

  // Stats
  const totalArticles = articles.length;
  const published = articles.filter(a => a.published).length;
  const totalViews = articles.reduce((s, a) => s + (a.views || 0), 0);
  const thisMonth = articles.filter(a => {
    const d = new Date(a.created_at);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const filtered = articles.filter(a =>
    !searchQuery || a.title?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const sidebarItems: { id: MTab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <TrendingUp size={18} /> },
    { id: 'articles', label: 'Articles', icon: <Newspaper size={18} /> },
  ];

  return (
    <div className="min-h-screen flex">
      {/* ── Toast ── */}
      {msg && (
        <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm animate-in slide-in-from-right-4 duration-300 ${
          msg.type === 'success' ? 'bg-brand-green/20 border-brand-green/40' : 'bg-red-500/20 border-red-500/40'
        }`}>
          {msg.type === 'success' ? <CheckCircle2 size={16} className="text-brand-green" /> : <XCircle size={16} className="text-red-400" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* ── Sidebar ── */}
      <aside className="hidden md:flex w-64 glass border-r border-white/10 p-6 flex-col shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 bg-purple-500/20 rounded-xl flex items-center justify-center">
            <Newspaper size={20} className="text-purple-400" />
          </div>
          <div>
            <h1 className="font-black text-sm uppercase tracking-tight">Media Center</h1>
            <p className="text-[10px] text-white/40 uppercase tracking-widest">Publisher Portal</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          {sidebarItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                activeTab === item.id
                  ? 'bg-purple-500/15 text-purple-400 font-bold'
                  : 'text-white/40 hover:text-white hover:bg-white/5 font-bold'
              }`}
            >
              {item.icon}
              <span className="text-sm">{item.label}</span>
              {item.id === 'articles' && totalArticles > 0 && (
                <span className="ml-auto px-1.5 py-0.5 rounded-full text-[9px] font-black bg-white/10 text-white/50">
                  {totalArticles}
                </span>
              )}
            </button>
          ))}
        </nav>

        {/* User info + signout */}
        <div className="pt-5 border-t border-white/10 space-y-3">
          <div className="flex items-center gap-3 px-2">
            <div className="w-9 h-9 rounded-full bg-purple-500/20 flex items-center justify-center font-black text-purple-400">
              {profile?.username?.[0]?.toUpperCase() || 'M'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate">{profile?.username || 'Media'}</p>
              <p className="text-[10px] text-white/30 uppercase tracking-widest">Publisher</p>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-white/40 hover:text-red-400 hover:bg-red-400/5 transition-all font-bold text-sm"
          >
            <LogOut size={16} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Mobile tab bar ── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 glass border-t border-white/10 flex">
        {sidebarItems.map(item => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-black uppercase tracking-widest transition-colors ${
              activeTab === item.id ? 'text-purple-400' : 'text-white/30'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        <button
          onClick={handleSignOut}
          className="flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-black uppercase tracking-widest text-white/30"
        >
          <LogOut size={18} />
          Sign Out
        </button>
      </div>

      {/* ── Main ── */}
      <main className="flex-1 p-5 md:p-8 overflow-y-auto pb-24 md:pb-8">

        {/* ════ OVERVIEW ════ */}
        {activeTab === 'overview' && (
          <div className="space-y-8 animate-in">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl md:text-3xl font-black italic uppercase tracking-tighter">
                  Media <span className="text-purple-400">Dashboard</span>
                </h2>
                <p className="text-white/40 text-sm mt-1">Welcome back, {profile?.username || 'Publisher'}</p>
              </div>
              <button
                onClick={() => setPublisherOpen(true)}
                className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-purple-500 text-white font-black text-xs uppercase tracking-widest hover:bg-purple-600 transition-colors shadow-lg shadow-purple-500/20"
              >
                <Plus size={16} /> New Article
              </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { icon: <FileText size={18} />, value: totalArticles, label: 'Total Articles', color: 'text-purple-400' },
                { icon: <CheckCircle2 size={18} />, value: published, label: 'Published', color: 'text-brand-green' },
                { icon: <Eye size={18} />, value: totalViews.toLocaleString(), label: 'Total Views', color: 'text-blue-400' },
                { icon: <Clock size={18} />, value: thisMonth, label: 'This Month', color: 'text-yellow-400' },
              ].map((s, i) => (
                <div key={i} className="glass rounded-[1.5rem] p-5 border border-white/5 text-center">
                  <div className={`${s.color} mx-auto mb-2 flex justify-center`}>{s.icon}</div>
                  <p className={`text-2xl font-black italic ${s.color}`}>{s.value}</p>
                  <p className="text-[10px] text-white/30 uppercase font-black tracking-widest mt-1">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Recent articles */}
            <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
              <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
                <h3 className="font-black italic uppercase tracking-widest text-sm">Recent Publications</h3>
                <div className="flex items-center gap-2">
                  <button onClick={fetchArticles} className="p-2 hover:bg-white/5 rounded-xl transition-colors">
                    <RefreshCw size={14} className="text-white/30" />
                  </button>
                  <button onClick={() => setActiveTab('articles')} className="text-xs text-purple-400 font-black uppercase tracking-widest hover:text-purple-300">
                    View all →
                  </button>
                </div>
              </div>
              {loading ? (
                <div className="flex justify-center py-10"><Loader2 size={24} className="animate-spin text-purple-400" /></div>
              ) : articles.length === 0 ? (
                <div className="p-12 text-center">
                  <Newspaper size={40} className="mx-auto text-white/10 mb-3" />
                  <p className="text-white/30 font-bold uppercase text-sm">No articles yet</p>
                  <button onClick={() => setPublisherOpen(true)} className="mt-4 text-purple-400 text-xs font-bold uppercase tracking-widest hover:text-purple-300">
                    + Publish your first article
                  </button>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {articles.slice(0, 8).map(article => (
                    <ArticleRow
                      key={article.id}
                      article={article}
                      onToggle={() => togglePublished(article)}
                      onEdit={() => setEditTarget(article)}
                      onDelete={() => setDeleteTarget(article)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ════ ARTICLES ════ */}
        {activeTab === 'articles' && (
          <div className="space-y-6 animate-in">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black italic uppercase tracking-tighter">All <span className="text-purple-400">Articles</span></h2>
                <p className="text-white/40 text-xs mt-1">{totalArticles} total · {published} published</p>
              </div>
              <div className="flex gap-3">
                <button onClick={fetchArticles} className="p-2.5 hover:bg-white/5 rounded-xl transition-colors border border-white/10">
                  <RefreshCw size={15} className="text-white/40" />
                </button>
                <button
                  onClick={() => setPublisherOpen(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-2xl bg-purple-500 text-white font-black text-xs uppercase tracking-widest hover:bg-purple-600 transition-colors"
                >
                  <Plus size={14} /> New
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="relative max-w-sm">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
              <input
                type="text"
                placeholder="Search articles…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-2xl pl-9 pr-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-purple-500/50"
              />
            </div>

            <div className="glass rounded-[2rem] border border-white/5 overflow-hidden">
              {loading ? (
                <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-purple-400" /></div>
              ) : filtered.length === 0 ? (
                <div className="p-12 text-center">
                  <Newspaper size={40} className="mx-auto text-white/10 mb-3" />
                  <p className="text-white/30 font-bold uppercase text-sm">No articles found</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {filtered.map(article => (
                    <ArticleRow
                      key={article.id}
                      article={article}
                      onToggle={() => togglePublished(article)}
                      onEdit={() => setEditTarget(article)}
                      onDelete={() => setDeleteTarget(article)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* ── Publisher modal ── */}
      <MediaPublisher
        isOpen={publisherOpen}
        onClose={() => { setPublisherOpen(false); fetchArticles(); }}
      />

      {/* ── Edit modal ── */}
      {editTarget && (
        <EditArticleModal
          article={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); fetchArticles(); success('Article updated!'); }}
          onError={(m) => error(m)}
        />
      )}

      {/* ── Delete confirmation ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
          <div className="relative w-full max-w-md glass rounded-[2.5rem] border border-red-500/30 p-8 text-center">
            <Trash2 size={32} className="text-red-400 mx-auto mb-4" />
            <h3 className="text-xl font-black uppercase mb-2">Delete Article?</h3>
            <p className="text-white/40 text-sm mb-6">
              "{deleteTarget.title}" will be permanently removed.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 py-3 rounded-xl bg-white/5 font-black uppercase text-sm hover:bg-white/10">Cancel</button>
              <button onClick={handleDelete} className="flex-1 py-3 rounded-xl bg-red-500 text-white font-black uppercase text-sm hover:bg-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Article row in list ───────────────────────────────────────────────────────
function ArticleRow({ article, onToggle, onEdit, onDelete }: {
  article: any; onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const FALLBACK_IMG = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=400&auto=format&fit=crop';
  return (
    <div className="flex items-center gap-4 px-5 py-4 hover:bg-white/[0.02] transition-colors group">
      {/* Thumbnail */}
      <div className="w-14 h-14 rounded-xl overflow-hidden shrink-0 border border-white/5">
        <img
          src={article.image_url || FALLBACK_IMG}
          alt={article.title}
          className="w-full h-full object-cover"
          onError={e => { e.currentTarget.src = FALLBACK_IMG; }}
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className={`text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest ${CATEGORY_COLORS[article.category] || 'text-white/40 bg-white/5'}`}>
            {article.category || 'News'}
          </span>
          {article.featured && (
            <span className="text-[9px] px-2 py-0.5 rounded-full font-black uppercase tracking-widest bg-yellow-400/10 text-yellow-400">⭐ Featured</span>
          )}
        </div>
        <h4 className="font-bold text-sm truncate group-hover:text-white text-white/80">{article.title}</h4>
        <div className="flex gap-3 text-[10px] text-white/30 mt-0.5">
          <span>{new Date(article.created_at).toLocaleDateString()}</span>
          {article.views > 0 && <span>{article.views.toLocaleString()} views</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onToggle}
          title={article.published ? 'Unpublish' : 'Publish'}
          className={`p-2 rounded-xl transition-colors ${article.published ? 'text-brand-green hover:bg-brand-green/10' : 'text-white/20 hover:text-brand-green hover:bg-brand-green/10'}`}
        >
          {article.published ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        </button>
        <button onClick={onEdit} className="p-2 rounded-xl text-white/20 hover:text-purple-400 hover:bg-purple-400/10 transition-colors">
          <Edit size={16} />
        </button>
        <button onClick={onDelete} className="p-2 rounded-xl text-white/20 hover:text-red-400 hover:bg-red-400/10 transition-colors">
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

// ── Edit article modal ────────────────────────────────────────────────────────
function EditArticleModal({ article, onClose, onSaved, onError }: {
  article: any; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const [form, setForm] = useState({
    title: article.title || '',
    category: article.category || 'News',
    image_url: article.image_url || '',
    excerpt: article.excerpt || '',
    content: article.content || '',
    featured: article.featured || false,
    published: article.published ?? true,
  });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const { error: err } = await supabase.from('media').update(form).eq('id', article.id);
    setSaving(false);
    if (err) { onError('Save failed: ' + err.message); return; }
    onSaved();
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-purple-500/10 to-transparent">
          <h2 className="text-lg font-black uppercase">Edit Article</h2>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full"><X size={18} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto">
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">Title</label>
            <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-purple-500/50" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">Category</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-purple-500/50">
                {['News', 'Match Report', 'Interview', 'Announcement', 'Transfer', 'Opinion'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">Image URL</label>
              <input value={form.image_url} onChange={e => setForm({ ...form, image_url: e.target.value })}
                placeholder="https://..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-purple-500/50" />
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">Excerpt</label>
            <textarea rows={2} value={form.excerpt} onChange={e => setForm({ ...form, excerpt: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-purple-500/50 resize-none" />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-white/40 mb-2 block">Content</label>
            <textarea rows={6} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-purple-500/50" />
          </div>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.featured} onChange={e => setForm({ ...form, featured: e.target.checked })}
                className="rounded accent-yellow-400" />
              <span className="text-xs font-bold text-white/60">⭐ Featured</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.published} onChange={e => setForm({ ...form, published: e.target.checked })}
                className="rounded accent-brand-green" />
              <span className="text-xs font-bold text-white/60">Published</span>
            </label>
          </div>
        </div>
        <div className="p-6 border-t border-white/10 flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl bg-white/5 font-black uppercase text-sm hover:bg-white/10">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-3 rounded-xl bg-purple-500 text-white font-black uppercase text-sm hover:bg-purple-600 disabled:opacity-50 flex items-center justify-center gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
