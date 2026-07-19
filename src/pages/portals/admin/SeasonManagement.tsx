import { useState, useEffect } from 'react';
import { supabase } from '../../../lib/supabase';
import { Trophy, Archive, Trash2, RotateCcw, Eye, Lock, Unlock } from 'lucide-react';

interface Season {
  id: number;
  name: string;
  year: string;
  status: 'active' | 'completed' | 'archived';
  created_at: string;
  competitions_count: number;
  teams_count: number;
}

export default function SeasonManagement() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateSeason, setShowCreateSeason] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetPassword, setResetPassword] = useState('');
  const [resetOption, setResetOption] = useState<'keep' | 'delete'>('keep');

  useEffect(() => {
    loadSeasons();
  }, []);

  async function loadSeasons() {
    try {
      const { data, error } = await supabase
        .from('seasons')
        .select('*')
        .order('year', { ascending: false });
      
      if (error) throw error;
      setSeasons(data || []);
    } catch (err) {
      console.error('Error loading seasons:', err);
    } finally {
      setLoading(false);
    }
  }

  const handleMasterReset = async () => {
    if (resetPassword !== 'jojOjojO') {
      alert('Incorrect password!');
      return;
    }

    if (!confirm('Are you sure? This will reset the app for a new season!')) {
      return;
    }

    try {
      setLoading(true);

      // Archive current season
      const { data: currentSeason } = await supabase
        .from('seasons')
        .select('id')
        .eq('status', 'active')
        .single();

      if (currentSeason) {
        await supabase
          .from('seasons')
          .update({ status: 'archived' })
          .eq('id', currentSeason.id);
      }

      // Reset based on option
      if (resetOption === 'delete') {
        // Delete all fan-facing data
        await supabase.from('matches').delete().neq('season_id', currentSeason?.id);
        await supabase.from('competitions').delete().neq('season_id', currentSeason?.id);
      }

      // Create new season
      const newYear = new Date().getFullYear() + 1;
      await supabase.from('seasons').insert([{
        name: `Season ${newYear}`,
        year: newYear.toString(),
        status: 'active'
      }]);

      alert('Master reset complete! New season created.');
      setShowResetConfirm(false);
      setResetPassword('');
      loadSeasons();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleArchiveSeason = async (seasonId: number) => {
    try {
      await supabase
        .from('seasons')
        .update({ status: 'archived' })
        .eq('id', seasonId);
      
      alert('Season archived!');
      loadSeasons();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  const handleDeleteSeason = async (seasonId: number) => {
    if (!confirm('Delete this season permanently? This cannot be undone!')) {
      return;
    }

    try {
      await supabase
        .from('seasons')
        .delete()
        .eq('id', seasonId);
      
      alert('Season deleted!');
      loadSeasons();
    } catch (err: any) {
      alert('Error: ' + err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-black uppercase">Season Management</h2>
        <button
          onClick={() => setShowResetConfirm(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-red/10 text-brand-red font-bold text-sm hover:bg-brand-red/20 transition-colors"
        >
          <RotateCcw size={16} />
          Master Reset
        </button>
      </div>

      {/* Seasons List */}
      <div className="glass rounded-2xl border border-white/10 overflow-hidden">
        <div className="p-6 border-b border-white/10">
          <h3 className="text-lg font-black uppercase">All Seasons</h3>
        </div>
        
        {loading ? (
          <div className="p-8 text-center">
            <div className="w-8 h-8 border-2 border-brand-green border-t-transparent rounded-full animate-spin mx-auto"></div>
          </div>
        ) : seasons.length > 0 ? (
          <div className="divide-y divide-white/5">
            {seasons.map((season) => (
              <div key={season.id} className="p-4 flex items-center justify-between hover:bg-white/5">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                    season.status === 'active' ? 'bg-brand-green/20 text-brand-green' :
                    season.status === 'completed' ? 'bg-blue-500/20 text-blue-500' :
                    'bg-white/10 text-white/40'
                  }`}>
                    <Trophy size={20} />
                  </div>
                  <div>
                    <p className="font-bold">{season.name}</p>
                    <p className="text-xs text-white/40">{season.year} • {season.status.toUpperCase()}</p>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {season.status === 'active' && (
                    <button
                      onClick={() => handleArchiveSeason(season.id)}
                      className="p-2 hover:bg-white/10 rounded-lg text-white/40 hover:text-white"
                      title="Archive Season"
                    >
                      <Archive size={16} />
                    </button>
                  )}
                  {season.status !== 'active' && (
                    <button
                      className="p-2 hover:bg-white/10 rounded-lg text-white/40 hover:text-white"
                      title="View Details"
                    >
                      <Eye size={16} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteSeason(season.id)}
                    className="p-2 hover:bg-brand-red/10 rounded-lg text-white/40 hover:text-brand-red"
                    title="Delete Season"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-white/40">
            <p>No seasons found</p>
          </div>
        )}
      </div>

      {/* Master Reset Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowResetConfirm(false)}></div>
          <div className="relative w-full max-w-md glass rounded-[2rem] border border-white/10 p-6">
            <div className="text-center mb-6">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-brand-red/20 flex items-center justify-center">
                <RotateCcw size={32} className="text-brand-red" />
              </div>
              <h3 className="text-xl font-black uppercase mb-2">Master Reset</h3>
              <p className="text-white/60 text-sm">
                Reset the app for a new season. This will archive the current season.
              </p>
            </div>

            <div className="space-y-4 mb-6">
              <div>
                <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">
                  Admin Password
                </label>
                <input
                  type="password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-brand-red/50"
                />
              </div>

              <div>
                <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">
                  Fan Data
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setResetOption('keep')}
                    className={`p-3 rounded-xl font-bold text-sm ${
                      resetOption === 'keep'
                        ? 'bg-brand-green text-black'
                        : 'bg-white/5 text-white/40'
                    }`}
                  >
                    Keep Records
                  </button>
                  <button
                    onClick={() => setResetOption('delete')}
                    className={`p-3 rounded-xl font-bold text-sm ${
                      resetOption === 'delete'
                        ? 'bg-brand-red text-white'
                        : 'bg-white/5 text-white/40'
                    }`}
                  >
                    Delete Records
                  </button>
                </div>
                <p className="text-[10px] text-white/40 mt-2">
                  {resetOption === 'keep' 
                    ? 'Old seasons will be archived and viewable'
                    : 'Old seasons will be permanently deleted'}
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="flex-1 py-3 rounded-xl bg-white/5 text-white font-black uppercase hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={handleMasterReset}
                className="flex-1 py-3 rounded-xl bg-brand-red text-white font-black uppercase hover:bg-brand-red/80"
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
