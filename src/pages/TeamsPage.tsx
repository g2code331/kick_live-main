import { useState, useEffect } from "react";
import { MapPin, ChevronRight, ArrowUpRight, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import Loading from "../components/Loading";
import { supabase } from "../lib/supabase";

export default function TeamsPage() {
  const navigate = useNavigate();
  const [teams, setTeams] = useState<any[]>([]);
  const [playerCounts, setPlayerCounts] = useState<Map<number, number>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadTeams() {
      try {
        // Fetch all teams
        const { data: teamsData } = await supabase
          .from('teams')
          .select('id, name, short_name, city, coach, primary_color, secondary_color, status')
          .in('status', ['active', null as any])
          .order('name');
        
        setTeams(teamsData || []);

        // Fetch player counts per team
        const { data: playersData } = await supabase
          .from('players')
          .select('team_id');
        
        const counts = new Map<number, number>();
        playersData?.forEach(player => {
          counts.set(player.team_id, (counts.get(player.team_id) || 0) + 1);
        });
        
        setPlayerCounts(counts);
      } catch (err) {
        console.error('Error loading teams:', err);
      } finally {
        setLoading(false);
      }
    }
    
    loadTeams();
  }, []);

  if (loading) return <Loading text="Loading Teams..." size="md" />;

  return (
    <div className="relative min-h-screen">
      <Header />
      <div className="container mx-auto px-4 py-12 relative z-10">
      <div className="mb-16 space-y-4">
        <h1 className="text-6xl md:text-8xl font-black italic uppercase tracking-tighter leading-none">
          Clubs <span className="text-white/10">&</span> <span className="text-brand-green">Squads</span>
        </h1>
        <p className="text-white/40 font-bold uppercase tracking-[0.3em] text-xs">Professional teams in KickLive</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {teams.map((team) => (
          <div 
            key={team.id} 
            className="group relative cursor-pointer"
            onClick={() => navigate(`/team/${team.id}`)}
          >
            <div className="relative glass rounded-2xl overflow-hidden border border-white/5 transition-all group-hover:border-brand-green/30">
              <div className="h-24 relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-14 h-14 rounded-full flex items-center justify-center text-2xl font-black" style={{
                    background: `linear-gradient(135deg, ${team.primary_color}, ${team.secondary_color})`,
                    color: team.secondary_color === '#000000' ? '#fff' : '#000'
                  }}>
                    {team.short_name[0]}
                  </div>
                </div>
              </div>

              <div className="p-4 text-center">
                 <h3 className="text-base font-black italic uppercase mb-2 truncate">{team.name}</h3>
                 <div className="flex items-center justify-center gap-1 mb-4">
                    <MapPin size={10} className="text-white/40" />
                    <span className="text-[10px] text-white/40 truncate">{team.city || 'Unknown'}</span>
                 </div>

                 <div className="grid grid-cols-2 gap-2 mb-4">
                    <div className="bg-white/5 rounded-lg p-2">
                       <p className="text-sm font-black text-brand-green">{playerCounts.get(team.id) || 0}</p>
                       <p className="text-[8px] text-white/40 uppercase">Players</p>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2">
                       <p className="text-xs font-black text-brand-blue truncate">{team.coach || 'TBD'}</p>
                       <p className="text-[8px] text-white/40 uppercase">Coach</p>
                    </div>
                 </div>

                 <span className="text-[10px] font-black uppercase text-brand-green flex items-center justify-center gap-1">
                   View <ChevronRight size={10} className="inline" />
                 </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {teams.length === 0 && (
        <div className="text-center py-20">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-white/5 flex items-center justify-center">
            <Users size={40} className="text-white/20" />
          </div>
          <p className="text-white/40 text-xl font-bold uppercase">No teams yet</p>
          <p className="text-white/30 text-sm mt-2">Teams will appear here once added</p>
        </div>
      )}
      </div>
    </div>
  );
}