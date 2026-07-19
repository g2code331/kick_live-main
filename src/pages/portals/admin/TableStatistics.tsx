import { useState, useEffect } from 'react';
import { Trophy, Users, Calendar, TrendingUp, Award, BarChart3, Filter, Search } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

export default function TableStatistics() {
  const [competitions, setCompetitions] = useState<any[]>([]);
  const [selectedCompetition, setSelectedCompetition] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadCompetitions();
  }, []);

  async function loadCompetitions() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('competitions')
        .select('*')
        .order('created_at', { ascending: false });
      setCompetitions(data || []);
      if (data && data.length > 0) {
        setSelectedCompetition(data[0]);
      }
    } catch (err) {
      console.error('Error loading competitions:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Statistics...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0E13] p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-4xl font-black italic uppercase mb-2">Tables & <span className="text-brand-green">Standings</span></h1>
            <p className="text-white/40">Competition standings, groups, and statistics</p>
          </div>
        </div>

        {/* Competition Selector */}
        <div className="glass rounded-2xl p-6 mb-8 border border-white/10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-4">
              <Filter size={20} className="text-brand-green" />
              <h2 className="text-lg font-black uppercase">Select Competition</h2>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
              <input 
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                placeholder="Search competitions..."
                className="bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-brand-green/50 w-64"
              />
            </div>
          </div>
          
          {competitions.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase())).length === 0 ? (
            <div className="text-center py-8">
              <Trophy size={48} className="mx-auto text-white/10 mb-4" />
              <p className="text-white/30 font-bold uppercase tracking-widest">No competitions found</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {competitions.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase())).map(comp => (
                <button
                  key={comp.id}
                  onClick={() => setSelectedCompetition(comp)}
                  className={`p-4 rounded-xl border transition-all text-left ${
                    selectedCompetition?.id === comp.id
                      ? 'border-brand-green bg-brand-green/10'
                      : 'border-white/10 bg-white/5 hover:border-white/20'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold">{comp.name}</span>
                    <span className="text-xs text-white/40">{comp.season || '2025'}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/40">Format</span>
                    <span className="uppercase">{comp.format || comp.type || 'League'}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs mt-2">
                    <span className="text-white/40">Status</span>
                    <span className={`px-2 py-0.5 rounded ${
                      comp.status === 'live' ? 'bg-brand-green text-black' : 'bg-white/10'
                    }`}>
                      {comp.status || 'upcoming'}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedCompetition ? (
          <CompetitionTables competition={selectedCompetition} />
        ) : (
          competitions.length === 0 && (
            <div className="text-center py-20">
              <Trophy size={96} className="mx-auto text-white/5 mb-6" />
              <p className="text-white/30 font-bold uppercase tracking-widest">No Competitions Yet</p>
              <p className="text-white/40 text-sm">Create a competition to view tables and statistics</p>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function CompetitionTables({ competition }: { competition: any }) {
  const [matches, setMatches] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'groups' | 'knockout' | 'fixtures' | 'stats'>('groups');

  useEffect(() => {
    loadCompetitionData();
  }, [competition]);

  async function loadCompetitionData() {
    setLoading(true);
    try {
      const [matchesRes, teamsRes] = await Promise.all([
        supabase.from('matches').select('id, home_team_id, away_team_id, home_score, away_score, status').eq('competition_id', competition.id).order('start_time').limit(100),
        supabase.from('teams').select('id, name, short_name, primary_color, secondary_color')
      ]);
      
      setMatches(matchesRes.data || []);
      setTeams(teamsRes.data || []);
    } catch (err) {
      console.error('Error loading competition data:', err);
    } finally {
      setLoading(false);
    }
  }

  // Calculate group standings
  const calculateGroupStandings = () => {
    const groups = matches.reduce((acc: any, match: any) => {
      if (match.group) {
        if (!acc[match.group]) acc[match.group] = [];
        acc[match.group].push(match);
      }
      return acc;
    }, {});

    const standings: Record<string, any[]> = {};

    Object.entries(groups).forEach(([groupName, groupMatches]) => {
      const teamStats = new Map<number, any>();

      (groupMatches as any[]).forEach((match: any) => {
        if (!teamStats.has(match.home_team_id)) {
          teamStats.set(match.home_team_id, {
            teamId: match.home_team_id,
            played: 0, won: 0, drawn: 0, lost: 0,
            gf: 0, ga: 0, gd: 0, points: 0, form: []
          });
        }
        if (!teamStats.has(match.away_team_id)) {
          teamStats.set(match.away_team_id, {
            teamId: match.away_team_id,
            played: 0, won: 0, drawn: 0, lost: 0,
            gf: 0, ga: 0, gd: 0, points: 0, form: []
          });
        }

        const home = teamStats.get(match.home_team_id)!;
        const away = teamStats.get(match.away_team_id)!;

        if (match.status === 'finished' || match.status === 'full_time') {
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
            home.drawn++; away.drawn++;
            home.points += 1; away.points += 1;
            home.form.push('D'); away.form.push('D');
          }
        }
      });

      standings[groupName] = Array.from(teamStats.values())
        .map((stat: any) => {
          const team = teams.find(t => t.id === stat.teamId);
          return { ...stat, teamName: team?.name || 'Unknown', teamShort: team?.short_name || '?', teamColor: team?.primary_color };
        })
        .sort((a: any, b: any) => {
          if (b.points !== a.points) return b.points - a.points;
          if (b.gd !== a.gd) return b.gd - a.gd;
          if (b.gf !== a.gf) return b.gf - a.gf;
          return 0;
        });
    });

    return standings;
  };

  const groupStandings = calculateGroupStandings();
  const compFormat = competition.format || competition.type || 'league';

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Tables...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Tabs */}
      <div className="flex gap-4 overflow-x-auto">
        {compFormat === 'cup' && Object.keys(groupStandings).length > 0 && (
          <button
            onClick={() => setActiveTab('groups')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap ${activeTab === 'groups' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}
          >
            Group Stage
          </button>
        )}
        {(compFormat === 'league' || !compFormat || compFormat === 'league') && (
          <button
            onClick={() => setActiveTab('groups')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap ${activeTab === 'groups' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}
          >
            League Table
          </button>
        )}
        <button
          onClick={() => setActiveTab('fixtures')}
          className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap ${activeTab === 'fixtures' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}
        >
          Fixtures
        </button>
        <button
          onClick={() => setActiveTab('stats')}
          className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap ${activeTab === 'stats' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}
        >
          Statistics
        </button>
      </div>

      {/* Group Tables */}
      {activeTab === 'groups' && compFormat === 'cup' && Object.keys(groupStandings).length > 0 && (
        <div className="space-y-8">
          {Object.entries(groupStandings).map(([groupName, standings]) => (
            <div key={groupName} className="glass rounded-[2rem] border border-white/10 overflow-hidden">
              <div className="p-6 border-b border-white/5 flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand-green/10 flex items-center justify-center text-brand-green font-black">
                  {groupName}
                </div>
                <h3 className="text-xl font-black uppercase">Group {groupName}</h3>
              </div>
              <div className="p-6 overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] font-black uppercase tracking-widest text-white/30 border-b border-white/5">
                      <th className="px-4 py-3 text-left">Pos</th>
                      <th className="px-4 py-3 text-left">Team</th>
                      <th className="px-4 py-3 text-center">P</th>
                      <th className="px-4 py-3 text-center">W</th>
                      <th className="px-4 py-3 text-center">D</th>
                      <th className="px-4 py-3 text-center">L</th>
                      <th className="px-4 py-3 text-center">GF</th>
                      <th className="px-4 py-3 text-center">GA</th>
                      <th className="px-4 py-3 text-center">GD</th>
                      <th className="px-4 py-3 text-center">Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {standings.map((row: any, i: number) => (
                      <tr key={row.teamId} className={`border-b border-white/5 ${i < 2 ? 'bg-green-500/5' : ''}`}>
                        <td className={`px-4 py-3 text-center ${i < 2 ? 'text-green-500' : 'text-white/40'}`}>
                          {i + 1}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs" style={{ background: row.teamColor || '#333' }}>
                              {row.teamShort}
                            </div>
                            <span className="font-bold text-sm">{row.teamName}</span>
                            {i < 2 && (
                              <span className="text-[8px] font-black bg-green-500 text-black px-2 py-0.5 rounded">Q</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center">{row.played}</td>
                        <td className="px-4 py-3 text-center">{row.won}</td>
                        <td className="px-4 py-3 text-center">{row.drawn}</td>
                        <td className="px-4 py-3 text-center">{row.lost}</td>
                        <td className="px-4 py-3 text-center">{row.gf}</td>
                        <td className="px-4 py-3 text-center">{row.ga}</td>
                        <td className="px-4 py-3 text-center">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                        <td className="px-4 py-3 text-center font-black">{row.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* League Table */}
      {activeTab === 'groups' && (compFormat === 'league' || !compFormat) && (
        <LeagueTable matches={matches} teams={teams} />
      )}

      {/* Fixtures */}
      {activeTab === 'fixtures' && (
        <FixturesList matches={matches} teams={teams} />
      )}

      {/* Statistics */}
      {activeTab === 'stats' && (
        <CompetitionStats matches={matches} />
      )}
    </div>
  );
}

function LeagueTable({ matches, teams }: { matches: any[], teams: any[] }) {
  const teamStats = new Map<number, any>();
  
  matches.forEach((match: any) => {
    if (!teamStats.has(match.home_team_id)) {
      teamStats.set(match.home_team_id, {
        teamId: match.home_team_id,
        played: 0, won: 0, drawn: 0, lost: 0,
        gf: 0, ga: 0, gd: 0, points: 0, form: []
      });
    }
    if (!teamStats.has(match.away_team_id)) {
      teamStats.set(match.away_team_id, {
        teamId: match.away_team_id,
        played: 0, won: 0, drawn: 0, lost: 0,
        gf: 0, ga: 0, gd: 0, points: 0, form: []
      });
    }

    const home = teamStats.get(match.home_team_id)!;
    const away = teamStats.get(match.away_team_id)!;

    if (match.status === 'finished' || match.status === 'full_time') {
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
        home.drawn++; away.drawn++;
        home.points += 1; away.points += 1;
        home.form.push('D'); away.form.push('D');
      }
    }
  });

  const standings = Array.from(teamStats.values())
    .map((stat: any) => {
      const team = teams.find(t => t.id === stat.teamId);
      return { ...stat, teamName: team?.name || 'Unknown', teamShort: team?.short_name || '?', teamColor: team?.primary_color };
    })
    .sort((a: any, b: any) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return 0;
    });

  return (
    <div className="glass rounded-[2rem] border border-white/10 overflow-hidden">
      <div className="p-6 border-b border-white/5 flex items-center gap-4">
        <Trophy size={24} className="text-brand-green" />
        <h3 className="text-xl font-black uppercase">League Standings</h3>
      </div>
      <div className="p-6 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-[10px] font-black uppercase tracking-widest text-white/30 border-b border-white/5">
              <th className="px-4 py-3 text-left">Pos</th>
              <th className="px-4 py-3 text-left">Team</th>
              <th className="px-4 py-3 text-center">P</th>
              <th className="px-4 py-3 text-center">W</th>
              <th className="px-4 py-3 text-center">D</th>
              <th className="px-4 py-3 text-center">L</th>
              <th className="px-4 py-3 text-center">GF</th>
              <th className="px-4 py-3 text-center">GA</th>
              <th className="px-4 py-3 text-center">GD</th>
              <th className="px-4 py-3 text-center">Pts</th>
              <th className="px-4 py-3 text-center">Form</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row: any, i: number) => (
              <tr key={row.teamId} className={`border-b border-white/5 ${i < 2 ? 'bg-green-500/5' : i >= standings.length - 2 ? 'bg-red-500/5' : ''}`}>
                <td className={`px-4 py-3 text-center ${i < 2 ? 'text-green-500' : i >= standings.length - 2 ? 'text-red-500' : 'text-white/40'}`}>
                  {i + 1}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-xs" style={{ background: row.teamColor || '#333' }}>
                      {row.teamShort}
                    </div>
                    <span className="font-bold text-sm">{row.teamName}</span>
                    {i < 2 && (
                      <span className="text-[8px] font-black bg-green-500 text-black px-2 py-0.5 rounded">Q</span>
                    )}
                    {i >= standings.length - 2 && standings.length > 4 && (
                      <span className="text-[8px] font-black bg-red-500 text-white px-2 py-0.5 rounded">R</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-center">{row.played}</td>
                <td className="px-4 py-3 text-center">{row.won}</td>
                <td className="px-4 py-3 text-center">{row.drawn}</td>
                <td className="px-4 py-3 text-center">{row.lost}</td>
                <td className="px-4 py-3 text-center">{row.gf}</td>
                <td className="px-4 py-3 text-center">{row.ga}</td>
                <td className="px-4 py-3 text-center">{row.gd > 0 ? `+${row.gd}` : row.gd}</td>
                <td className="px-4 py-3 text-center font-black">{row.points}</td>
                <td className="px-4 py-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {row.form?.slice(-5).map((result: string, j: number) => (
                      <span key={j} className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-black ${
                        result === 'W' ? 'bg-green-500 text-black' : result === 'D' ? 'bg-white/20' : 'bg-red-500 text-white'
                      }`}>
                        {result}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-6 py-4 border-t border-white/5 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
          <span className="text-xs font-bold text-white/40 uppercase">Qualification</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <span className="text-xs font-bold text-white/40 uppercase">Relegation</span>
        </div>
      </div>
    </div>
  );
}

function FixturesList({ matches, teams }: { matches: any[], teams: any[] }) {
  return (
    <div className="glass rounded-[2rem] p-8 border border-white/10">
      <div className="flex items-center gap-4 mb-6">
        <Calendar size={24} className="text-brand-green" />
        <div>
          <h3 className="text-xl font-black uppercase">All Fixtures</h3>
          <p className="text-[10px] text-white/40">{matches.length} matches</p>
        </div>
      </div>
      {matches.length > 0 ? (
        <div className="space-y-4">
          {matches.map((match: any) => (
            <div key={match.id} className="glass rounded-xl p-4 border border-white/5">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-black uppercase text-white/40">
                  {match.round ? match.round : match.group ? `Group ${match.group}` : `Matchday ${match.matchday || 1}`}
                </span>
                <span className={`px-2 py-1 rounded text-[10px] font-black uppercase ${
                  match.status === 'live' || match.status === 'first_half' || match.status === 'second_half' ? 'bg-brand-red text-white' : match.status === 'finished' || match.status === 'full_time' ? 'bg-white/10 text-white/40' : 'bg-brand-blue/10 text-brand-blue'
                }`}>
                  {match.status === 'live' || match.status === 'first_half' || match.status === 'second_half' ? 'LIVE' : match.status === 'finished' || match.status === 'full_time' ? 'FT' : match.status}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <p className="text-sm font-bold">{teams.find(t => t.id === match.home_team_id)?.short_name || 'HOME'}</p>
                </div>
                <div className="px-4 text-center">
                  {match.status === 'finished' || match.status === 'full_time' || match.status === 'live' ? (
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-black ${match.home_score > match.away_score ? 'text-green-500' : ''}`}>
                        {match.home_score ?? '-'}
                      </span>
                      <span className="text-white/20">-</span>
                      <span className={`text-lg font-black ${match.away_score > match.home_score ? 'text-green-500' : ''}`}>
                        {match.away_score ?? '-'}
                      </span>
                    </div>
                  ) : (
                    <span className="text-white/40">vs</span>
                  )}
                </div>
                <div className="flex-1 text-right">
                  <p className="text-sm font-bold">{teams.find(t => t.id === match.away_team_id)?.short_name || 'AWAY'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <Calendar size={64} className="mx-auto text-white/10 mb-4" />
          <p className="text-white/30 font-bold uppercase tracking-widest">No fixtures generated yet</p>
        </div>
      )}
    </div>
  );
}

function CompetitionStats({ matches }: { matches: any[] }) {
  const compStats = {
    totalMatches: matches.length,
    playedMatches: matches.filter((m: any) => m.status === 'finished' || m.status === 'full_time').length,
    totalGoals: matches.reduce((acc: number, m: any) => acc + (m.home_score || 0) + (m.away_score || 0), 0),
    avgGoals: matches.filter((m: any) => m.status === 'finished' || m.status === 'full_time').length > 0 
      ? (matches.reduce((acc: number, m: any) => acc + (m.home_score || 0) + (m.away_score || 0), 0) / matches.filter((m: any) => m.status === 'finished' || m.status === 'full_time').length).toFixed(2)
      : '0.00'
  };

  return (
    <div className="glass rounded-[2rem] p-8 border border-white/10">
      <div className="flex items-center gap-4 mb-6">
        <BarChart3 size={24} className="text-brand-green" />
        <div>
          <h3 className="text-xl font-black uppercase">Competition Statistics</h3>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
        <div className="glass rounded-2xl p-6 text-center">
          <p className="text-[10px] text-white/40 uppercase mb-2">Total Matches</p>
          <p className="text-3xl font-black text-brand-green">{compStats.totalMatches}</p>
        </div>
        <div className="glass rounded-2xl p-6 text-center">
          <p className="text-[10px] text-white/40 uppercase mb-2">Played</p>
          <p className="text-3xl font-black text-brand-blue">{compStats.playedMatches}</p>
        </div>
        <div className="glass rounded-2xl p-6 text-center">
          <p className="text-[10px] text-white/40 uppercase mb-2">Total Goals</p>
          <p className="text-3xl font-black text-yellow-500">{compStats.totalGoals}</p>
        </div>
        <div className="glass rounded-2xl p-6 text-center">
          <p className="text-[10px] text-white/40 uppercase mb-2">Avg Goals/Match</p>
          <p className="text-3xl font-black text-purple-500">{compStats.avgGoals}</p>
        </div>
      </div>
    </div>
  );
}
