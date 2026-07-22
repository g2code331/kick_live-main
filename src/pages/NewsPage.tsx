import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, X, ChevronRight, Clock, Eye, Tag, ArrowLeft, Loader2, Newspaper } from 'lucide-react';
import Header from '../components/Header';
import { supabase } from '../lib/supabase';

const FALLBACK_IMG = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800&auto=format&fit=crop';

const CATEGORIES = ['All', 'News', 'Match Report', 'Interview', 'Announcement', 'Transfer', 'Opinion'] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_COLORS: Record<string, string> = {
  'News': 'text-brand-green bg-brand-green/10 border-brand-green/20',
  'Match Report': 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  'Interview': 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  'Announcement': 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  'Transfer': 'text-red-400 bg-red-400/10 border-red-400/20',
  'Opinion': 'text-orange-400 bg-orange-400/10 border-orange-400/20',
};

function imgSrc(url: string | null | undefined) {
  return url && url.trim() ? url : FALLBACK_IMG;
}

function timeSince(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function NewsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<Category>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<any>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const PAGE_SIZE = 12;

  const fetchArticles = useCallback(async (reset = false) => {
    const currentPage = reset ? 0 : page;
    setLoading(true);
    // Build query with only guaranteed-to-exist columns (matches home page query)
    // views / featured / tags are added later via SQL migration
    let q = supabase
      .from('media')
      .select('id, title, excerpt, content, category, image_url, created_at')
      .order('created_at', { ascending: false })
      .range(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE - 1);

    if (category !== 'All') q = q.eq('category', category);
    if (searchQuery.trim()) q = q.ilike('title', `%${searchQuery.trim()}%`);

    const { data, error } = await q;
    if (error) console.error('Failed to load articles:', error.message);
    if (!error) {
      const incoming = data || [];
      setArticles(prev => reset ? incoming : [...prev, ...incoming]);
      setHasMore(incoming.length === PAGE_SIZE);
      if (!reset) setPage(p => p + 1);
    }
    setLoading(false);
  }, [category, searchQuery, page]);

  // Reset + refetch when filters change
  useEffect(() => {
    setPage(0);
    setArticles([]);
    fetchArticles(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, searchQuery]);

  // If we arrived here from the homepage carousel with a specific article in mind,
  // fetch it directly (regardless of current filters/pagination) and open it.
  useEffect(() => {
    const articleId = (location.state as any)?.articleId;
    if (!articleId) return;
    (async () => {
      const { data } = await supabase
        .from('media')
        .select('id, title, excerpt, content, category, image_url, created_at, views')
        .eq('id', articleId)
        .maybeSingle();
      if (data) {
        setSelected(data);
        supabase.from('media').update({ views: (data.views || 0) + 1 }).eq('id', data.id).then(() => {});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Increment views when article is opened (best-effort, ignore errors)
  const openArticle = async (article: any) => {
    setSelected(article);
    supabase.from('media').update({ views: (article.views || 0) + 1 }).eq('id', article.id).then(() => {});
  };

  const featured = articles.find(a => a.featured) || articles[0];
  const rest = articles.filter(a => a !== featured);

  return (
    <div className="relative min-h-screen pb-20">
      <Header />

      <div className="container mx-auto px-4 py-6 max-w-6xl">
        {/* ── Page title ── */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-2xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center">
            <Newspaper size={22} className="text-brand-green" />
          </div>
          <div>
            <h1 className="text-3xl font-black italic uppercase tracking-tighter">
              Media <span className="text-brand-green">&</span> News
            </h1>
            <p className="text-white/30 text-xs uppercase font-black tracking-widest">Latest stories &amp; updates</p>
          </div>
        </div>

        {/* ── Search + category filters ── */}
        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              type="text"
              placeholder="Search articles…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-2xl pl-9 pr-9 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-brand-green/50"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white">
                <X size={13} />
              </button>
            )}
          </div>

          {/* Category pills */}
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar flex-wrap sm:flex-nowrap">
            {CATEGORIES.map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-4 py-2.5 rounded-2xl font-black text-[10px] uppercase tracking-widest whitespace-nowrap transition-all border ${
                  category === c
                    ? 'bg-brand-green text-black border-brand-green'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white hover:bg-white/10'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* ── Featured hero (only on first load with no filters) ── */}
        {category === 'All' && !searchQuery && featured && page <= 1 && (
          <div
            onClick={() => openArticle(featured)}
            className="relative overflow-hidden rounded-[2rem] mb-10 cursor-pointer group border border-white/5 hover:border-brand-green/30 transition-all"
            style={{ minHeight: '340px' }}
          >
            <img
              src={imgSrc(featured.image_url)}
              alt={featured.title}
              className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
              onError={e => { e.currentTarget.src = FALLBACK_IMG; }}
            />
            {/* Dark gradient */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
            {featured.featured && (
              <div className="absolute top-5 left-5 px-3 py-1 bg-brand-green text-black text-[10px] font-black uppercase tracking-widest rounded-full">
                ⭐ Featured
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 p-8">
              <span className={`inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border mb-3 ${CATEGORY_COLORS[featured.category] || CATEGORY_COLORS['News']}`}>
                {featured.category || 'News'}
              </span>
              <h2 className="text-2xl sm:text-3xl font-black italic uppercase tracking-tighter leading-tight mb-3 text-white drop-shadow-lg line-clamp-2">
                {featured.title}
              </h2>
              {featured.excerpt && (
                <p className="text-white/60 text-sm mb-4 line-clamp-2 max-w-2xl">{featured.excerpt}</p>
              )}
              <div className="flex items-center gap-4 text-xs text-white/40">
                <span className="flex items-center gap-1"><Clock size={11} /> {timeSince(featured.created_at)}</span>
                {featured.views > 0 && <span className="flex items-center gap-1"><Eye size={11} /> {featured.views.toLocaleString()} views</span>}
                <span className="ml-auto flex items-center gap-1 text-brand-green font-black group-hover:gap-2 transition-all">
                  Read story <ChevronRight size={14} />
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ── Articles grid ── */}
        {loading && articles.length === 0 ? (
          <div className="flex justify-center py-20">
            <Loader2 size={32} className="animate-spin text-brand-green" />
          </div>
        ) : articles.length === 0 ? (
          <div className="glass rounded-[2rem] p-16 text-center border border-white/5">
            <Newspaper size={48} className="mx-auto text-white/10 mb-4" />
            <p className="text-white/30 font-bold uppercase">No articles found</p>
            {searchQuery && <button onClick={() => setSearchQuery('')} className="mt-3 text-brand-green text-sm font-bold">Clear search</button>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {(category === 'All' && !searchQuery && featured ? rest : articles).map(article => (
              <ArticleCard
                key={article.id}
                article={article}
                onClick={() => openArticle(article)}
              />
            ))}
          </div>
        )}

        {/* ── Load more ── */}
        {hasMore && articles.length > 0 && (
          <div className="mt-10 text-center">
            <button
              onClick={() => fetchArticles(false)}
              disabled={loading}
              className="px-8 py-3 rounded-2xl bg-white/5 border border-white/10 text-white/60 font-black text-xs uppercase tracking-widest hover:bg-white/10 hover:text-white transition-all disabled:opacity-40 flex items-center gap-2 mx-auto"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              Load More
            </button>
          </div>
        )}
      </div>

      {/* ── Article Detail Modal ── */}
      {selected && (
        <ArticleModal article={selected} onClose={() => setSelected(null)} navigate={navigate} />
      )}
    </div>
  );
}

// ── Article card ──────────────────────────────────────────────────────────────
function ArticleCard({ article, onClick }: { article: any; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="glass rounded-[1.5rem] overflow-hidden border border-white/5 hover:border-brand-green/30 cursor-pointer transition-all group hover:-translate-y-1 hover:shadow-xl hover:shadow-brand-green/5"
    >
      {/* Image */}
      <div className="aspect-[16/9] overflow-hidden relative">
        <img
          src={imgSrc(article.image_url)}
          alt={article.title}
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          onError={e => { e.currentTarget.src = FALLBACK_IMG; }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
        {/* Category badge over image */}
        <span className={`absolute top-3 left-3 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border ${CATEGORY_COLORS[article.category] || CATEGORY_COLORS['News']}`}>
          {article.category || 'News'}
        </span>
      </div>

      {/* Content */}
      <div className="p-5">
        <h3 className="font-black uppercase tracking-tight text-sm leading-tight line-clamp-2 mb-2 group-hover:text-brand-green transition-colors">
          {article.title}
        </h3>
        {article.excerpt && (
          <p className="text-white/40 text-xs line-clamp-2 mb-3">{article.excerpt}</p>
        )}
        <div className="flex items-center justify-between text-[10px] text-white/30">
          <span className="flex items-center gap-1"><Clock size={10} /> {timeSince(article.created_at)}</span>
          {article.views > 0 && <span className="flex items-center gap-1"><Eye size={10} /> {article.views.toLocaleString()}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Article detail modal ──────────────────────────────────────────────────────
function ArticleModal({ article, onClose, navigate }: { article: any; onClose: () => void; navigate: any }) {
  return (
    <div className="fixed inset-0 z-[400] flex items-start justify-center overflow-y-auto p-4 py-8">
      <div className="absolute inset-0 bg-black/85 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl glass rounded-[2.5rem] border border-white/10 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300 my-auto">
        {/* Hero image */}
        <div className="aspect-video overflow-hidden relative">
          <img
            src={imgSrc(article.image_url)}
            alt={article.title}
            className="w-full h-full object-cover"
            onError={e => { e.currentTarget.src = FALLBACK_IMG; }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/60 backdrop-blur-sm flex items-center justify-center hover:bg-black/80 transition-colors"
          >
            <X size={18} />
          </button>
          <button
            onClick={onClose}
            className="absolute top-4 left-4 flex items-center gap-2 px-3 py-2 rounded-full bg-black/60 backdrop-blur-sm text-white/70 hover:text-white text-xs font-bold transition-colors"
          >
            <ArrowLeft size={14} /> Back
          </button>
          {/* Category + title overlay */}
          <div className="absolute bottom-0 left-0 right-0 p-6">
            <span className={`inline-block px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border mb-3 ${CATEGORY_COLORS[article.category] || CATEGORY_COLORS['News']}`}>
              {article.category || 'News'}
            </span>
            <h2 className="text-xl sm:text-2xl font-black italic uppercase tracking-tighter leading-tight text-white drop-shadow-lg">
              {article.title}
            </h2>
          </div>
        </div>

        {/* Article body */}
        <div className="p-6 sm:p-8 space-y-5">
          {/* Meta */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-white/30 border-b border-white/5 pb-5">
            <span className="flex items-center gap-1.5"><Clock size={12} /> {timeSince(article.created_at)}</span>
            {article.views > 0 && (
              <span className="flex items-center gap-1.5"><Eye size={12} /> {article.views.toLocaleString()} views</span>
            )}
            {article.tags?.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Tag size={12} />
                {article.tags.map((t: string) => (
                  <span key={t} className="px-2 py-0.5 rounded-full bg-white/5 text-[10px] font-bold">{t}</span>
                ))}
              </div>
            )}
          </div>

          {/* Excerpt */}
          {article.excerpt && (
            <p className="text-white/70 font-bold text-base leading-relaxed border-l-2 border-brand-green pl-4">
              {article.excerpt}
            </p>
          )}

          {/* Full content */}
          {article.content ? (
            <div className="text-white/60 text-sm leading-7 space-y-4 whitespace-pre-line">
              {article.content}
            </div>
          ) : (
            <p className="text-white/30 text-sm italic">No additional content.</p>
          )}
        </div>
      </div>
    </div>
  );
}