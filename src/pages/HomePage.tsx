import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Loading from "../components/Loading";
import Header from "../components/Header";
import { supabase } from "../lib/supabase";

export default function HomePage() {
  const navigate = useNavigate();
  const [liveMatches, setLiveMatches] = useState<any[]>([]);
  const [topScorers, setTopScorers] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newsIndex, setNewsIndex] = useState(0);
  const newsScrollRef = useRef<HTMLDivElement>(null);
  const newsHovering = useRef(false);

  useEffect(() => {
    async function loadRealData() {
      try {
        const [matchesRes, playersRes, mediaRes] = await Promise.all([
          supabase
            .from('matches')
            .select('id, home_score, away_score, status, minute, homeTeam:teams!home_team_id(name, short_name), awayTeam:teams!away_team_id(name, short_name), competitions(name)')
            .in('status', ['first_half', 'second_half', 'extra_time', 'half_time', 'live'])
            .limit(10),
          supabase
            .from('players')
            .select('id, name, goals, nationality, teams(name)')
            .gt('goals', 0)
            .order('goals', { ascending: false })
            .limit(3),
          supabase
            .from('media')
            .select('id, title, category, image_url, created_at, excerpt')
            .order('created_at', { ascending: false })
            .limit(6),
        ]);

        setLiveMatches(matchesRes.data || []);
        setTopScorers(playersRes.data || []);
        setNews(mediaRes.data || []);
      } catch (err) {
        console.error('Error loading data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadRealData();

    // Poll live matches every 30 s to save egress
    const pollInterval = setInterval(async () => {
      const { data } = await supabase
        .from('matches')
        .select('id, home_score, away_score, status, minute, homeTeam:teams!home_team_id(name, short_name), awayTeam:teams!away_team_id(name, short_name)')
        .in('status', ['first_half', 'second_half', 'extra_time', 'half_time', 'live'])
        .limit(10);
      setLiveMatches(data || []);
    }, 30000); // 30 s instead of 10 s

    return () => clearInterval(pollInterval);
  }, []);

  // Auto-advance the "Latest News" carousel every 4s, pausing while the user is interacting
  useEffect(() => {
    if (news.length <= 1) return;
    const id = setInterval(() => {
      if (newsHovering.current) return;
      setNewsIndex(prev => {
        const next = (prev + 1) % news.length;
        const card = newsScrollRef.current?.children[next] as HTMLElement | undefined;
        card?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
        return next;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [news.length]);

  if (loading) return <Loading text="Loading..." size="md" />;

  return (
    <div className="relative min-h-screen pb-20">
      <Header />

      <div className="container mx-auto px-4 py-4">
        {/* Live Matches */}
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-ping"></span>
            <h2 className="text-xl font-black uppercase">Live Now</h2>
          </div>
          {liveMatches.length > 0 ? (
            <div className="space-y-3">
              {liveMatches.map((match) => (
                <div
                  key={match.id}
                  className="glass rounded-xl p-4 border border-white/10 hover:border-brand-green/30 transition-all cursor-pointer"
                  onClick={() => navigate(`/match/${match.id}`)}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] text-white/40 uppercase truncate flex-1">{match.competitions?.[0]?.name || 'Competition'}</span>
                    <span className="text-[10px] text-brand-green font-bold bg-brand-green/10 px-2 py-0.5 rounded">{match?.minute || 0}'</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-center flex-1">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-green/20 to-brand-blue/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                        {match?.homeTeam?.short_name?.[0] || 'H'}
                      </div>
                      <p className="text-[10px] text-white/60 truncate">{match?.homeTeam?.name || 'Home'}</p>
                    </div>
                    <div className="text-center px-3">
                      <p className="text-2xl font-black text-brand-green">{match?.home_score ?? 0} - {match?.away_score ?? 0}</p>
                      <p className="text-[10px] text-brand-green font-bold mt-1 flex items-center justify-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
                        LIVE
                      </p>
                    </div>
                    <div className="text-center flex-1">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-blue/20 to-brand-green/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                        {match?.awayTeam?.short_name?.[0] || 'A'}
                      </div>
                      <p className="text-[10px] text-white/60 truncate">{match?.awayTeam?.name || 'Away'}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="glass rounded-xl p-8 text-center text-white/40">
              <p className="text-sm">No live matches right now</p>
            </div>
          )}
        </section>

        {/* Top Scorers */}
        <section className="mb-6">
          <h2 className="text-xl font-black uppercase mb-4">⚽ Top Scorers</h2>
          <div className="glass rounded-xl overflow-hidden">
            <div className="divide-y divide-white/5">
              {topScorers.slice(0, 3).map((player, i) => (
                <div
                  key={player.id}
                  className="flex items-center justify-between p-3 hover:bg-white/5 transition-all cursor-pointer"
                  onClick={() => navigate(`/player/${player.id}`)}
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-sm font-black w-6 ${i === 0 ? 'text-yellow-500' : i === 1 ? 'text-gray-400' : 'text-orange-400'}`}>#{i + 1}</span>
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-green/20 to-brand-blue/20 flex items-center justify-center font-black text-xs">
                      {player.name?.[0] || 'P'}
                    </div>
                    <div>
                      <p className="text-sm font-bold">{player.name || 'Player'}</p>
                      <p className="text-[10px] text-white/40">{player.teams?.[0]?.name || player.nationality || 'Unknown'}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-black text-brand-green">{player.goals || 0}</p>
                    <p className="text-[10px] text-white/40 uppercase">Goals</p>
                  </div>
                </div>
              ))}
              {topScorers.length === 0 && (
                <div className="p-8 text-center text-white/30 text-sm">No scorer data yet</div>
              )}
            </div>
          </div>
        </section>

        {/* Latest News */}
        <section className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-black uppercase">📰 Latest News</h2>
            {news.length > 0 && (
              <button onClick={() => navigate('/news')} className="text-xs font-bold text-brand-green hover:underline">
                See all
              </button>
            )}
          </div>
          {news.length > 0 ? (
            <>
              <div
                ref={newsScrollRef}
                onMouseEnter={() => { newsHovering.current = true; }}
                onMouseLeave={() => { newsHovering.current = false; }}
                onTouchStart={() => { newsHovering.current = true; }}
                onTouchEnd={() => { newsHovering.current = false; }}
                className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-2 -mx-4 px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ touchAction: 'pan-y' }}
              >
                {news.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => navigate('/news', { state: { articleId: item.id } })}
                    className="snap-start shrink-0 w-[78%] sm:w-[320px] glass rounded-xl overflow-hidden border border-white/10 hover:border-brand-green/30 transition-all cursor-pointer"
                  >
                    <div className="aspect-video overflow-hidden">
                      <img
                        src={item.image_url || 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800&auto=format&fit=crop'}
                        alt={item.title}
                        className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
                        onError={e => { e.currentTarget.src = 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?w=800&auto=format&fit=crop'; }}
                      />
                    </div>
                    <div className="p-4">
                      <span className="text-[10px] text-brand-green font-bold uppercase">{item.category || 'News'}</span>
                      <h3 className="font-bold mt-1 text-sm line-clamp-2">{item.title || 'News Title'}</h3>
                      <p className="text-[10px] text-white/40 mt-2">
                        {item.created_at ? new Date(item.created_at).toLocaleDateString() : 'Recent'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              {news.length > 1 && (
                <div className="flex items-center justify-center gap-1.5 mt-3">
                  {news.map((_, i) => (
                    <span
                      key={i}
                      className={`h-1.5 rounded-full transition-all ${i === newsIndex ? 'w-5 bg-brand-green' : 'w-1.5 bg-white/20'}`}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="glass rounded-xl p-8 text-center">
              <p className="text-white/40 text-sm">No news yet</p>
              <p className="text-white/30 text-xs mt-1">Check back later</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}