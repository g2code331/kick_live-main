import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Trophy, Activity, Calendar, MapPin, Shirt } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function PlayerProfile() {
  const { playerId } = useParams<{ playerId: string }>();
  const navigate = useNavigate();
  const [player, setPlayer] = useState<any>(null);
  const [team, setTeam] = useState<any>(null);
  const [matches, setMatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (playerId) {
      loadPlayerData();
    }
  }, [playerId]);

  async function loadPlayerData() {
    try {
      // Fetch player details
      const { data: playerData } = await supabase
        .from('players')
        .select('*, teams(id, name, short_name, primary_color, secondary_color, city, coach)')
        .eq('id', playerId)
        .single();
      
      if (playerData) {
        setPlayer(playerData);
        setTeam(playerData.teams);
      }

      // Fetch recent matches involving player's team
      if (playerData?.team_id) {
        const { data: matchesData } = await supabase
          .from('matches')
          .select(`
            id,
            home_score,
            away_score,
            status,
            minute,
            start_time,
            homeTeam:teams!home_team_id(id, name, short_name),
            awayTeam:teams!away_team_id(id, name, short_name)
          `)
          .or(`home_team_id.eq.${playerData.team_id},away_team_id.eq.${playerData.team_id}`)
          .order('start_time', { ascending: false })
          .limit(10);
        setMatches(matchesData || []);
      }
    } catch (err) {
      console.error('Error loading player data:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-brand-green border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-green font-bold uppercase">Loading Player Profile...</p>
        </div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/40 text-xl">Player not found</p>
          <button onClick={() => navigate('/teams')} className="mt-4 text-brand-green hover:underline">Back to Teams</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-20">
      {/* Header */}
      <div className="relative h-64 overflow-hidden">
        <div className="absolute inset-0" style={{
          background: `linear-gradient(135deg, ${team?.primary_color}44, ${team?.secondary_color}22)`
        }}></div>
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#0B0E13]"></div>
        <button 
          onClick={() => navigate(-1)}
          className="absolute top-6 left-6 p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors z-10"
        >
          <ArrowLeft size={24} />
        </button>
      </div>

      <div className="container mx-auto px-4 -mt-32 relative z-10">
        {/* Player Info Card */}
        <div className="glass rounded-[2rem] p-8 border border-white/10 mb-8">
          <div className="flex flex-col md:flex-row items-center gap-8">
            <div className="w-32 h-32 rounded-full bg-gradient-to-br from-brand-green/20 to-brand-blue/20 flex items-center justify-center text-6xl font-black shadow-2xl">
              {player.name[0]}
            </div>
            <div className="text-center md:text-left flex-1">
              <h1 className="text-4xl md:text-5xl font-black italic uppercase tracking-tighter mb-2">{player.name}</h1>
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-4 text-white/40">
                {player.position && (
                  <span className="flex items-center gap-2">
                    <Shirt size={16} /> {player.position}
                  </span>
                )}
                {player.number && (
                  <span className="flex items-center gap-2">
                    <Activity size={16} /> #{player.number}
                  </span>
                )}
                {player.nationality && (
                  <span className="flex items-center gap-2">
                    <MapPin size={16} /> {player.nationality}
                  </span>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="glass-light p-4 rounded-2xl text-center min-w-[120px]">
                <p className="text-3xl font-black text-brand-green">{player.goals || 0}</p>
                <p className="text-xs text-white/40 uppercase">Goals</p>
              </div>
              <div className="glass-light p-4 rounded-2xl text-center min-w-[120px]">
                <p className="text-3xl font-black text-brand-blue">{player.assists || 0}</p>
                <p className="text-xs text-white/40 uppercase">Assists</p>
              </div>
            </div>
          </div>
        </div>

        {/* Team Info */}
        {team && (
          <div className="glass rounded-[2rem] p-6 border border-white/10 mb-8">
            <div className="flex items-center gap-3 mb-4">
              <Trophy size={24} className="text-yellow-500" />
              <h2 className="text-2xl font-black uppercase">Current Team</h2>
            </div>
            <div 
              className="p-6 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer"
              onClick={() => navigate(`/team/${team.id}`)}
            >
              <div className="flex items-center gap-6">
                <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl font-black italic" style={{
                  background: `linear-gradient(135deg, ${team.primary_color}, ${team.secondary_color})`,
                  color: team.secondary_color === '#000000' ? '#fff' : '#000'
                }}>
                  {team.short_name[0]}
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-bold">{team.name}</h3>
                  <p className="text-sm text-white/40">{team.city} • Coach: {team.coach}</p>
                </div>
                <button className="text-brand-green font-bold text-sm">View Team →</button>
              </div>
            </div>
          </div>
        )}

        {/* Recent Matches */}
        <div className="glass rounded-[2rem] p-6 border border-white/10">
          <div className="flex items-center gap-3 mb-6">
            <Calendar size={24} className="text-brand-blue" />
            <h2 className="text-2xl font-black uppercase">Recent Matches</h2>
          </div>
          {matches.length > 0 ? (
            <div className="space-y-3">
              {matches.map(match => (
                <div key={match.id} className="p-4 rounded-xl bg-white/5 hover:bg-white/10 transition-all cursor-pointer"
                  onClick={() => navigate(`/match/${match.id}`)}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-bold">{match.homeTeam?.name}</p>
                      <p className="text-xs text-white/40">{match.awayTeam?.name}</p>
                    </div>
                    <div className="text-center px-4">
                      <p className="text-2xl font-black">{match.home_score} - {match.away_score}</p>
                      <p className="text-xs text-white/40">
                        {match.status === 'completed' || match.status === 'full_time' ? 'FT' : 
                         match.status === 'live' || match.status === 'first_half' || match.status === 'second_half' ? `${match.minute}'` :
                         new Date(match.start_time).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 text-white/40">
              <Calendar size={48} className="mx-auto mb-4 opacity-20" />
              <p>No recent matches</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
