import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import Loading from "../components/Loading";
import { describeAge, useQuery } from "../lib/data";
import { matchList, type MatchFilter } from "../lib/data/queries.ts";

const PAGE_SIZE = 20;

export default function MatchesPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<MatchFilter>('all');
  const [page, setPage] = useState(0);
  const [matches, setMatches] = useState<any[]>([]);
  // One shared read for the fixture list, armed on the `fast` cadence: the 10 s `setInterval` this page owned
  // is gone, and the page that is open is the only thing that makes it tick (§4.3, F-04). Each page is its
  // own cache key, so "load more" adds a read instead of re-reading the window it already showed.
  const { data, error, loading, stale, ageMs, refetch } = useQuery(
    matchList,
    { filter, page, pageSize: PAGE_SIZE },
    { poll: page === 0 },
  );
  useEffect(() => {
    if (!data) return;
    setMatches((prev) => (data.page === 0 ? data.rows : [...prev.filter((m) => !data.rows.some((d: any) => d.id === m.id)), ...data.rows]));
  }, [data]);
  const refresh = () => void refetch();
  const loadMore = () => setPage((n) => n + 1);

  if (loading && !matches.length) return <Loading text="Loading Matches..." size="md" />;

  const filteredMatches = matches;

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Header />
      <div className="container mx-auto px-4 py-8 relative z-10">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black italic uppercase tracking-tighter">Fixtures & Results</h1>
            <p className="text-white/40 text-sm mt-1">
              {error ? (
                <button onClick={refresh} className="text-amber-400 hover:text-amber-300">
                  {`showing the last list that loaded · ${error}`}
                </button>
              ) : stale && matches.length ? (
                <button onClick={refresh} className="hover:text-white">
                  {`updated ${describeAge(ageMs)} · tap to refresh`}
                </button>
              ) : (
                'Real-time match updates'
              )}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {['all', 'live', 'scheduled', 'finished'].map(f => (
              <button
                key={f}
                onClick={() => {
                  setFilter(f as MatchFilter);
                  setPage(0);
                  setMatches([]);
                }}
                className={`px-3 sm:px-4 py-2 rounded-xl font-black uppercase text-xs tracking-widest whitespace-nowrap ${
                  filter === f ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:text-white'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {filteredMatches.map((match) => (
            <div 
              key={match.id} 
              className="glass rounded-xl p-4 border border-white/10 hover:border-brand-green/30 transition-all cursor-pointer"
              onClick={() => navigate(`/match/${match.id}`)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-white/40 uppercase truncate">{match.competitions?.[0]?.name || 'Competition'}</span>
                <span className={`text-[10px] font-bold ${
                  match.status === 'live' || match.status === 'first_half' || match.status === 'second_half' ? 'text-brand-green' : 'text-white/40'
                }`}>
                  {match.status === 'live' || match.status === 'first_half' || match.status === 'second_half' ? `${match.minute || 0}'` : 
                   match.status === 'finished' || match.status === 'full_time' || match.status === 'completed' ? 'FT' : 
                   new Date(match.start_time).toLocaleDateString()}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div 
                  className="text-center flex-1 cursor-pointer" 
                  onClick={(e) => { e.stopPropagation(); navigate(`/team/${match.homeTeam?.id}`); }}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-green/20 to-brand-blue/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                    {match.homeTeam?.short_name?.[0] || 'H'}
                  </div>
                  <p className="text-[10px] text-white/60 truncate hover:text-brand-green transition-colors">{match.homeTeam?.name || 'Home'}</p>
                </div>
                <div className="text-center px-3">
                  <p className="text-2xl font-black text-brand-green">{match.home_score ?? '-'} - {match.away_score ?? '-'}</p>
                </div>
                <div 
                  className="text-center flex-1 cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); navigate(`/team/${match.awayTeam?.id}`); }}
                >
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-brand-blue/20 to-brand-green/20 flex items-center justify-center text-lg font-black mx-auto mb-1">
                    {match.awayTeam?.short_name?.[0] || 'A'}
                  </div>
                  <p className="text-[10px] text-white/60 truncate hover:text-brand-green transition-colors">{match.awayTeam?.name || 'Away'}</p>
                </div>
              </div>
            </div>
          ))}

          {(data?.more ?? false) && (
            <button
              onClick={loadMore}
              className="w-full py-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/60 font-black uppercase text-[10px] tracking-widest"
            >
              {`Load ${PAGE_SIZE} more`}
            </button>
          )}
        </div>

        {filteredMatches.length === 0 && (
          <div className="glass rounded-2xl p-20 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/5 flex items-center justify-center">
              <span className="text-3xl"></span>
            </div>
            <p className="text-white/40 text-lg">No matches found</p>
          </div>
        )}
      </div>
    </div>
  );
}
