import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import Header from "../components/Header";
import Loading from "../components/Loading";
import { useQuery } from "../lib/data";
import { competitionsIndex, standings as standingsQuery } from "../lib/data/queries.ts";

export default function StandingsPage() {
  const [selectedComp, setSelectedComp] = useState<any>(null);
  // The table used to be built in the browser from an unbounded read of every match in the competition, and
  // the rules for it lived in three files (F-05). It is now one `fast`-keyed read: `kicklive_competition_standings`
  // where the function is deployed, the shared browser rule where it is not, and one cache entry for the
  // `/tables` visit that a `MatchControlCenter` finalize can invalidate by tag.
  const { data: compRows, loading: compsLoading } = useQuery(competitionsIndex, {});
  const competitions = (compRows ?? []) as any[];
  useEffect(() => {
    if (!selectedComp && competitions.length) setSelectedComp(competitions[0]);
  }, [competitions, selectedComp]);

  const table = useQuery(standingsQuery, { competitionId: Number(selectedComp?.id ?? 0) }, { enabled: Number(selectedComp?.id) > 0 });
  const standings = (table.data ?? []) as any[];
  const loading = compsLoading || (!standings.length && !!selectedComp && table.loading);

  return (
    <div className="relative min-h-screen">
      <Header />
      <div className="container mx-auto px-4 py-12 relative z-10">
        <div className="mb-8">
          <div className="space-y-2 mb-8">
            <span className="bg-brand-green/20 text-brand-green px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-[0.2em] border border-brand-green/30">
              Live Standings
            </span>
            <h1 className="text-5xl md:text-7xl font-black italic uppercase tracking-tighter leading-none">
              Standings
            </h1>
          </div>

          {/* Competition Tabs */}
          {competitions.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {competitions.map(comp => (
                <button
                  key={comp.id}
                  onClick={() => setSelectedComp(comp)}
                  className={`px-6 py-3 rounded-xl font-black uppercase text-xs tracking-widest whitespace-nowrap transition-all ${
                    selectedComp?.id === comp.id
                      ? 'bg-brand-green text-black'
                      : 'bg-white/5 text-white/40 hover:bg-white/10'
                  }`}
                >
                  {comp.name} {comp.season}
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-brand-green font-bold uppercase text-xs tracking-widest">Loading Standings...</p>
            </div>
          </div>
        ) : standings.length === 0 ? (
          <div className="glass rounded-[3rem] p-16 text-center border border-white/5">
            <p className="text-white/30 font-black uppercase tracking-widest">No completed matches yet</p>
            <p className="text-white/20 text-sm mt-2">Standings update automatically after each match.</p>
          </div>
        ) : (
          <div className="glass rounded-[3rem] overflow-hidden border border-white/5 shadow-2xl">
            <div className="overflow-x-auto no-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white/5 text-[10px] font-black uppercase tracking-[0.25em] text-white/30">
                    <th className="px-8 py-6">Pos</th>
                    <th className="px-8 py-6">Team</th>
                    <th className="px-4 py-6 text-center">P</th>
                    <th className="px-4 py-6 text-center">W</th>
                    <th className="px-4 py-6 text-center">D</th>
                    <th className="px-4 py-6 text-center">L</th>
                    <th className="px-4 py-6 text-center">GF</th>
                    <th className="px-4 py-6 text-center">GA</th>
                    <th className="px-4 py-6 text-center">GD</th>
                    <th className="px-8 py-6 text-center bg-brand-green/10 text-brand-green">Pts</th>
                    <th className="px-8 py-6 text-center">Form</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {standings.map((row: any, i) => {
                    const isTop = i < 2;
                    const isBot = i >= standings.length - 2 && standings.length > 4;
                    return (
                      <tr key={row.teamId} className={`hover:bg-white/[0.02] transition-colors group relative ${isTop ? 'bg-brand-green/5' : isBot ? 'bg-brand-red/5' : ''}`}>
                        <td className="px-8 py-6 relative">
                          {isTop && <div className="absolute left-0 top-0 bottom-0 w-1 bg-brand-green" />}
                          {isBot && <div className="absolute left-0 top-0 bottom-0 w-1 bg-brand-red" />}
                          <span className={`text-lg font-black italic ${isTop ? 'text-brand-green' : isBot ? 'text-brand-red' : 'text-white/20'}`}>
                            {i + 1 < 10 ? `0${i + 1}` : i + 1}
                          </span>
                        </td>
                        <td className="px-8 py-6">
                          <div className="flex items-center gap-4">
                            <div
                              className="w-10 h-10 rounded-full flex items-center justify-center font-black text-xs border border-white/10 group-hover:scale-110 transition-transform"
                              style={{
                                background: `linear-gradient(135deg, ${row.primaryColor || '#333'}, ${row.secondaryColor || '#666'})`,
                                color: '#fff'
                              }}
                            >
                              {(row.shortName || row.name)?.[0]}
                            </div>
                            <span className="font-bold text-sm">{row.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.played}</td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.won}</td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.drawn}</td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.lost}</td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.gf}</td>
                        <td className="px-4 py-6 text-center text-sm text-white/60 font-bold">{row.ga}</td>
                        <td className="px-4 py-6 text-center text-sm font-bold">
                          <span className={row.gd > 0 ? 'text-brand-green' : row.gd < 0 ? 'text-brand-red' : 'text-white/40'}>
                            {row.gd > 0 ? `+${row.gd}` : row.gd}
                          </span>
                        </td>
                        <td className="px-8 py-6 text-center bg-brand-green/5">
                          <span className="text-xl font-black italic text-brand-green">{row.points}</span>
                        </td>
                        <td className="px-8 py-6 text-center">
                          <div className="flex items-center justify-center gap-1">
                            {row.form?.slice(-5).map((result: string, j: number) => (
                              <span
                                key={j}
                                className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-black ${
                                  result === 'W' ? 'bg-green-500 text-black' : result === 'D' ? 'bg-white/20 text-white' : 'bg-red-500 text-white'
                                }`}
                              >
                                {result}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-6 px-8 py-5 border-t border-white/5 bg-white/[0.01]">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-brand-green"></div>
                <span className="text-xs font-bold text-white/40 uppercase tracking-widest">Qualification</span>
              </div>
              {standings.length > 4 && (
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-brand-red"></div>
                  <span className="text-xs font-bold text-white/40 uppercase tracking-widest">Relegation Zone</span>
                </div>
              )}
              <div className="flex items-center gap-3 ml-auto">
                <Info size={14} className="text-white/20" />
                <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Updated after each match</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}