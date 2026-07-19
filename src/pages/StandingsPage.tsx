import { useState, useEffect } from "react";
import { Info } from "lucide-react";
import Header from "../components/Header";
import Loading from "../components/Loading";
import { supabase } from "../lib/supabase";

export default function StandingsPage() {
  const [standings, setStandings] = useState<any[]>([]);
  const [competitions, setCompetitions] = useState<any[]>([]);
  const [selectedComp, setSelectedComp] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Load competitions once on mount
  useEffect(() => {
    async function loadComps() {
      const { data } = await supabase
        .from('competitions')
        .select('id, name, type, season')
        .order('created_at', { ascending: false })
        .limit(20);
      setCompetitions(data || []);
      if (data && data.length > 0) setSelectedComp(data[0]);
    }
    loadComps();
  }, []);

  // Re-calculate standings whenever selected competition changes
  useEffect(() => {
    if (!selectedComp) return;

    async function buildStandings() {
      setLoading(true);
      try {
        // Only fetch matches for this competition
        const { data: matchesData } = await supabase
          .from('matches')
          .select('home_team_id, away_team_id, home_score, away_score, status')
          .eq('competition_id', selectedComp.id);

        if (!matchesData || matchesData.length === 0) {
          setStandings([]);
          setLoading(false);
          return;
        }

        // Collect only the team IDs that appear in this competition's matches
        const teamIds = new Set<number>();
        matchesData.forEach(m => {
          teamIds.add(m.home_team_id);
          teamIds.add(m.away_team_id);
        });

        const { data: teamsData } = await supabase
          .from('teams')
          .select('id, name, short_name, primary_color, secondary_color')
          .in('id', Array.from(teamIds));

        const teamsMap = new Map((teamsData || []).map(t => [t.id, t]));

        // Build stats only for teams in this competition
        const teamStats: Record<number, any> = {};
        teamIds.forEach(id => {
          const team = teamsMap.get(id);
          if (!team) return;
          teamStats[id] = {
            teamId: id,
            name: team.name,
            shortName: team.short_name,
            primaryColor: team.primary_color,
            secondaryColor: team.secondary_color,
            played: 0, won: 0, drawn: 0, lost: 0,
            gf: 0, ga: 0, gd: 0, points: 0, form: []
          };
        });

        matchesData.forEach(match => {
          const finished = ['completed', 'full_time', 'finished'].includes(match.status);
          if (!finished) return;

          const home = teamStats[match.home_team_id];
          const away = teamStats[match.away_team_id];
          if (!home || !away) return;

          home.played++; away.played++;
          home.gf += match.home_score || 0;
          home.ga += match.away_score || 0;
          away.gf += match.away_score || 0;
          away.ga += match.home_score || 0;
          home.gd = home.gf - home.ga;
          away.gd = away.gf - away.ga;

          if ((match.home_score || 0) > (match.away_score || 0)) {
            home.won++; home.points += 3; home.form.push('W');
            away.lost++; away.form.push('L');
          } else if ((match.home_score || 0) < (match.away_score || 0)) {
            away.won++; away.points += 3; away.form.push('W');
            home.lost++; home.form.push('L');
          } else {
            home.drawn++; away.drawn++; home.points += 1; away.points += 1;
            home.form.push('D'); away.form.push('D');
          }
        });

        const sorted = Object.values(teamStats).sort((a: any, b: any) => {
          if (b.points !== a.points) return b.points - a.points;
          if (b.gd !== a.gd) return b.gd - a.gd;
          return b.gf - a.gf;
        });

        setStandings(sorted);
      } catch (err) {
        console.error('Error building standings:', err);
      } finally {
        setLoading(false);
      }
    }

    buildStandings();
  }, [selectedComp?.id]);

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
