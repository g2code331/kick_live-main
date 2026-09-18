import { useState, useEffect } from 'react';
import { Calendar, MapPin, Edit2, Search, Filter, Loader2, Play, RotateCcw } from 'lucide-react';
import AdminPageShell from './AdminPageShell';
import { invalidate, useQuery } from '../../../lib/data';
// Reads go through `src/lib/data`. The two writes below do not, on purpose: a fixture reshuffle is a
// privileged mutation, and moving writes behind the Worker is Phase 2's route-by-route migration, not
// something to fold into a caching change. The invalidation after each one is what keeps this honest.
import { supabase } from '../../../lib/supabase';
import { FRESHNESS } from '../../../lib/data/freshness.ts';
import { competitionFixtures, teamsIndex } from '../../../lib/data/queries.ts';
import { CompetitionEngine } from '../../../lib/CompetitionEngine';
import MatchControlCenter from './MatchControlCenter';

interface FixturesViewerProps {
  competition: any;
  onBack: () => void;
}

export default function FixturesViewer({ competition, onBack }: FixturesViewerProps) {
  const [fixtures, setFixtures] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [isMatchControlOpen, setIsMatchControlOpen] = useState(false);
  const [isReshuffling, setIsReshuffling] = useState(false);

  // Both reads are shared and cached: the club index is the same `slow` key `/teams` warms, and the fixture
  // read embeds the two club names, which replaces the third query this screen used to issue for them. The
  // board also refreshes on the `fast` class now, which it never did — left open, it showed the schedule as
  // of whenever it was opened.
  const clubs = useQuery(teamsIndex, {}, { enabled: true });
  const rows = useQuery(
    competitionFixtures,
    { competitionId: Number(competition?.id ?? 0), limit: 200 },
    { enabled: !!competition?.id, poll: FRESHNESS.fast },
  );
  const teams = (clubs.data ?? []) as any[];

  useEffect(() => {
    setFixtures((rows.data ?? []) as any[]);
    setLoading(rows.loading && (rows.data?.length ?? 0) === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.data]);

  const loadFixtures = () => rows.refetch();

  const handleReshuffle = async () => {
    if (!confirm('Are you sure you want to reshuffle fixtures? This will delete all existing fixtures and generate new ones.')) return;
    
    setIsReshuffling(true);
    try {
      // Delete existing fixtures
      await supabase.from('matches').delete().eq('competition_id', competition.id);
      
      // Get teams in this competition
      const teamIdsInComp = Array.from(new Set(fixtures.map(f => [f.home_team_id, f.away_team_id]).flat()));
      const selectedTeamsList = teams.filter(t => teamIdsInComp.includes(t.id));
      
      if (selectedTeamsList.length < 2) {
        alert('Not enough teams to generate fixtures');
        setIsReshuffling(false);
        return;
      }
      
      // Generate new fixtures
      const newFixtures = CompetitionEngine.create(
        competition.type || 'league',
        selectedTeamsList,
        {
          rounds: 'single',
          pointsWin: 3,
          pointsDraw: 1,
          pointsLoss: 0,
          startDate: competition.start_date || new Date().toISOString().split('T')[0],
          endDate: competition.end_date || new Date(Date.now() + 31536000000).toISOString().split('T')[0],
          matchDays: ['Saturday', 'Sunday'],
          kickoffTimes: ['15:00', '18:00'],
          restDays: 3
        } as any,
        competition.id
      );
      
      if (newFixtures && newFixtures.length > 0) {
        const { error } = await supabase.from('matches').insert(newFixtures);
        if (error) throw error;

        // Targeted invalidation (§4.2): this wrote rows behind the cache's back, so the tags it dirties are
        // named here — the fixture lists, every standings table, and this competition's key. The news and
        // squad caches are left alone, because nothing about them changed.
        invalidate('matches', 'standings', `competition:${competition.id}`);
        alert(`Fixtures reshuffled! Generated ${newFixtures.length} new fixtures.`);
        await loadFixtures();
      }
    } catch (err: any) {
      alert('Error reshuffling: ' + err.message);
    } finally {
      setIsReshuffling(false);
    }
  };

  const filteredFixtures = fixtures.filter(f => 
    f.homeTeam?.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    f.awayTeam?.name?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Opening a fixture's live console takes over the whole page (its own back button returns here),
  // instead of stacking a second overlay on top of this one.
  if (isMatchControlOpen) {
    return (
      <MatchControlCenter
        match={selectedMatch}
        onBack={() => setIsMatchControlOpen(false)}
        onUpdate={loadFixtures}
      />
    );
  }

  return (
    <AdminPageShell
      title={competition?.name || 'Fixtures'}
      subtitle="Tournament fixtures"
      icon={<Calendar size={22} />}
      onBack={onBack}
      backLabel="Tournaments"
      actions={
        <>
          <div className="relative hidden md:block">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
            <input 
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Search teams..."
              className="bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-[#39FF14]/50 w-48 lg:w-56"
            />
          </div>
          <button 
            onClick={handleReshuffle}
            disabled={isReshuffling || fixtures.length === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-50"
          >
            <RotateCcw size={14} className={isReshuffling ? 'animate-spin' : ''} /> <span className="hidden sm:inline">Reshuffle</span>
          </button>
        </>
      }
    >
      <div className="glass rounded-[2rem] lg:rounded-[3rem] border border-white/10 overflow-hidden flex flex-col">
        {/* Content */}
        <div className="flex-1 p-6 lg:p-10">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-4">
               <Loader2 className="animate-spin text-[#39FF14]" size={32} />
               <p className="text-xs font-black uppercase tracking-widest text-white/20">Loading Fixtures...</p>
            </div>
          ) : filteredFixtures.length > 0 ? (
            <div className="grid grid-cols-1 gap-4">
              {filteredFixtures.map((match) => (
                <div key={match.id} className="glass-light p-6 rounded-3xl border border-white/5 hover:border-white/10 transition-all flex items-center justify-between group">
                   <div className="flex items-center gap-8 flex-1">
                      <div className="text-right w-1/3">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">{match.homeTeam?.short_name}</p>
                        <p className="font-bold text-sm truncate">{match.homeTeam?.name}</p>
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <div className="bg-white/5 px-6 py-2 rounded-2xl border border-white/5 font-black italic text-lg">
                           {match.status === 'finished' ? `${match.home_score} - ${match.away_score}` : 'VS'}
                        </div>
                        <span className={`text-[8px] font-black uppercase tracking-widest ${match.status === 'live' ? 'text-[#39FF14]' : 'text-white/20'}`}>
                          {match.status}
                        </span>
                      </div>
                      <div className="text-left w-1/3">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">{match.awayTeam?.short_name}</p>
                        <p className="font-bold text-sm truncate">{match.awayTeam?.name}</p>
                      </div>
                   </div>

                   <div className="flex items-center gap-6 pl-8 border-l border-white/5">
                      <div className="hidden md:block">
                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest flex items-center gap-1"><MapPin size={10}/> {match.venue || 'TBD'}</p>
                        <p className="text-[10px] font-black text-white/40 uppercase tracking-widest mt-1">{new Date(match.start_time).toLocaleDateString()}</p>
                      </div>
                      <button 
                        onClick={() => {
                          setSelectedMatch(match);
                          setIsMatchControlOpen(true);
                        }}
                        className="w-10 h-10 rounded-xl bg-[#39FF14]/10 text-[#39FF14] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-[#39FF14] hover:text-black"
                      >
                         <Play size={18} />
                      </button>
                   </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-20">
               <p className="text-white/20 font-black uppercase tracking-[0.3em]">No fixtures found</p>
               {fixtures.length === 0 && (
                 <p className="text-white/40 text-sm mt-2">Fixtures will be auto-generated when competition is created</p>
               )}
            </div>
          )}
        </div>
      </div>
    </AdminPageShell>
  );
}
