import { useState, useEffect } from 'react';
import { 
  Trophy, Users, Settings, Calendar, 
  Check, Globe, Zap, Hash, Plus, ArrowLeft, ArrowRight, Loader2, X, Edit, Trash2
} from 'lucide-react';
import { supabase } from '../../../lib/supabase';
import { CompetitionEngine } from '../../../lib/CompetitionEngine';

interface CompetitionWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

  type Step = 'basic' | 'teams' | 'format' | 'rules' | 'preview';
  type TournamentFormat = 'league' | 'cup' | 'knockout';
  
  export default function CompetitionWizard({ isOpen, onClose }: CompetitionWizardProps) {
    const [currentStep, setCurrentStep] = useState<Step>('basic');
    const [loading, setLoading] = useState(false);
    const [wizardMsg, setWizardMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [availableTeams, setAvailableTeams] = useState<any[]>([]);
    
    const [config, setCompetitionConfig] = useState({
      name: '',
      season: '2025',
      type: 'league' as TournamentFormat,
      startDate: new Date().toISOString().split('T')[0],
      endDate: '',
      selectedTeams: [] as number[],
      matchDuration: 90,
      allowDraw: true,
      varEnabled: false,
      extraTime: false,
      homeAway: false,
      venues: [] as string[],
      cupFormat: 'group_knockout' as string,
      qualifyingTeamsPerGroup: 2,
    });

  useEffect(() => {
    if (isOpen) fetchTeams();
  }, [isOpen]);

  async function fetchTeams() {
    // Only fetch necessary columns, limit to 50 teams
    const { data } = await supabase.from('teams').select('id, name, short_name').order('name').limit(50);
    setAvailableTeams(data || []);
  }

  const toggleTeam = (id: number) => {
    setCompetitionConfig(prev => ({
      ...prev,
      selectedTeams: prev.selectedTeams.includes(id) 
        ? prev.selectedTeams.filter(t => t !== id)
        : [...prev.selectedTeams, id]
    }));
  };

  const handleGenerate = async () => {
    setLoading(true);
    try {
      // Validate
      if (!config.name) {
        setWizardMsg({ type: 'error', text: 'Please enter a competition name' });
        setLoading(false);
        return;
      }
      
      if (config.selectedTeams.length < 2) {
        setWizardMsg({ type: 'error', text: 'Please select at least 2 teams' });
        setLoading(false);
        return;
      }

      const { data: compData, error: compError } = await supabase
        .from('competitions')
        .insert([{
          name: config.name,
          type: config.type,
          season: config.season,
          start_date: config.startDate,
          status: 'upcoming',
          format: config.type
        }])
        .select()
        .single();

      if (compError) throw compError;

      const selectedTeamsList = availableTeams.filter((t: any) => config.selectedTeams.includes(t.id));
      
      try {
        const fixtures = CompetitionEngine.create(
          config.type,
          selectedTeamsList.map((t: any) => ({ id: t.id, name: t.name, short_name: t.short_name })),
          {
            rounds: config.homeAway ? 'double' : 'single',
            pointsWin: 3, pointsDraw: 1, pointsLoss: 0,
            startDate: config.startDate,
            endDate: config.endDate || config.startDate,
            matchDays: ['Saturday', 'Sunday'],
            kickoffTimes: ['15:00', '18:00'],
            restDays: 3
          } as any,
          compData.id
        );

        if (fixtures && fixtures.length > 0) {
          const { error: matchError } = await supabase.from('matches').insert(fixtures);
          if (matchError) throw matchError;
        }
      } catch (engineError: any) {
        console.error('CompetitionEngine error:', engineError);
      }

      setWizardMsg({ type: 'success', text: 'Competition created successfully!' });
      setTimeout(() => { onClose(); window.location.reload(); }, 1200);
    } catch (err: any) {
      setWizardMsg({ type: 'error', text: 'Error: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      {wizardMsg && (
        <div className={`fixed bottom-6 right-6 z-[9999] flex items-center gap-3 px-5 py-4 rounded-2xl shadow-2xl border backdrop-blur-xl font-bold text-sm max-w-sm animate-in slide-in-from-right-4 duration-300 ${
          wizardMsg.type === 'success' ? 'bg-brand-green/20 border-brand-green/40' : 'bg-red-500/20 border-red-500/40'
        }`}>
          {wizardMsg.type === 'success' ? '✅' : '❌'} {wizardMsg.text}
        </div>
      )}
      <div className="relative w-full max-w-4xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[85vh] animate-in zoom-in-95 duration-500">
        
        <div className="p-10 border-b border-white/10 flex items-center justify-between">
           <div className="flex items-center gap-4">
              <div className="w-12 h-12 gradient-green rounded-2xl flex items-center justify-center">
                <Trophy className="text-black" />
              </div>
              <div>
                <h2 className="text-2xl font-black italic uppercase tracking-tighter">Tournament <span className="text-brand-green">Wizard</span></h2>
                <p className="text-[10px] text-white/40 uppercase tracking-widest font-black">Step: {currentStep}</p>
              </div>
           </div>
           <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full"><X /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-10 space-y-8 no-scrollbar">
          {currentStep === 'basic' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Competition Name</label>
                  <input type="text" value={config.name} onChange={e => setCompetitionConfig({...config, name: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 focus:border-brand-green" placeholder="e.g. Rx Premier League" />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Start Date</label>
                  <input type="date" value={config.startDate} onChange={e => setCompetitionConfig({...config, startDate: e.target.value})} className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 focus:border-brand-green" />
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                {['league', 'cup', 'knockout'].map(t => (
                  <button key={t} onClick={() => setCompetitionConfig({...config, type: t as any})} className={`p-6 rounded-2xl border-2 transition-all ${config.type === t ? 'border-brand-green bg-brand-green/10' : 'border-white/5 bg-white/5'}`}>
                    <p className="font-black uppercase italic text-xs">{t}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {currentStep === 'teams' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {availableTeams.map(team => (
                <button key={team.id} onClick={() => toggleTeam(team.id)} className={`p-4 rounded-xl border transition-all text-left flex items-center gap-3 ${config.selectedTeams.includes(team.id) ? 'border-brand-green bg-brand-green/10' : 'border-white/5 bg-white/5'}`}>
                  <div className="w-8 h-8 rounded bg-white/10 flex items-center justify-center font-black text-xs">{team.short_name[0]}</div>
                  <span className="text-xs font-bold truncate">{team.name}</span>
                </button>
              ))}
            </div>
          )}

          {currentStep === 'format' && (
            <div className="space-y-10 animate-in fade-in slide-in-from-right-4">
              <div>
                <h3 className="text-4xl font-black italic uppercase tracking-tighter mb-2">Tournament Format</h3>
                <p className="text-white/40 uppercase tracking-[0.3em] text-[10px]">Define the competition structure</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                {[
                  { id: 'league', label: 'League Format', desc: 'Teams play in a league table. Winner has most points.', icon: <Hash /> },
                  { id: 'cup', label: 'Cup Format', desc: 'Group stage followed by knockout rounds.', icon: <Trophy /> },
                  { id: 'knockout', label: 'Knockout Only', desc: 'Direct elimination. Lose and you\'re out.', icon: <Zap /> },
                ].map(format => (
                  <button
                    key={format.id}
                    onClick={() => setCompetitionConfig(prev => ({ ...prev, type: format.id as TournamentFormat }))}
                    className={`p-8 rounded-[2.5rem] border-2 transition-all text-left flex gap-6 ${
                      config.type === format.id
                        ? 'border-brand-green bg-brand-green/10 scale-[1.02]'
                        : 'border-white/5 bg-white/5 hover:border-white/10'
                    }`}
                  >
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 ${config.type === format.id ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40'}`}>
                      {format.icon}
                    </div>
                    <div>
                      <h4 className="font-black italic uppercase text-lg mb-1">{format.label}</h4>
                      <p className="text-xs text-white/30 leading-relaxed">{format.desc}</p>
                    </div>
                  </button>
                ))}
              </div>

              {config.type === 'cup' && (
                <div className="glass rounded-2xl p-6 border border-brand-blue/20">
                  <h4 className="text-lg font-black uppercase mb-4 flex items-center gap-2">
                    <Users size={20} className="text-brand-blue" />
                    Cup Configuration
                  </h4>
                  <div className="space-y-4">
                    <div>
                      <label className="text-[10px] font-black uppercase text-white/40 mb-2 block">Teams Qualifying Per Group</label>
                      <select
                        value={config.qualifyingTeamsPerGroup}
                        onChange={(e) => setCompetitionConfig(prev => ({ ...prev, qualifyingTeamsPerGroup: parseInt(e.target.value) }))}
                        className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-sm"
                      >
                        <option value={1}>1 Team</option>
                        <option value={2}>2 Teams</option>
                        <option value={3}>3 Teams</option>
                      </select>
                    </div>
                    <div className="p-4 bg-brand-blue/10 rounded-xl border border-brand-blue/20">
                      <p className="text-xs text-white/40 leading-relaxed">
                        <strong className="text-brand-blue">Top {config.qualifyingTeamsPerGroup} teams</strong> from each group will advance to the knockout stage.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {currentStep === 'rules' && (
            <div className="space-y-12 animate-in fade-in slide-in-from-right-4">
              <div>
                <h3 className="text-4xl font-black italic uppercase tracking-tighter mb-2">Match Rules</h3>
                <p className="text-white/40 uppercase tracking-[0.3em] text-[10px]">Configure officiating & gameplay</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl">
                {[
                  { id: 'varEnabled', label: 'VAR Integration', desc: 'Enable video assistant reviews in Match Center' },
                  { id: 'allowDraw', label: 'Allow Draws', desc: 'Enable 1 point for tie results' },
                  { id: 'extraTime', label: 'Extra Time', desc: 'Enable 30m overtime for knockout fixtures' },
                  { id: 'homeAway', label: 'Home & Away', desc: 'Reverse every fixture automatically' },
                ].map(rule => (
                  <div key={rule.id} className="p-8 glass-light rounded-[2.5rem] border border-white/5 flex items-center justify-between group">
                    <div>
                      <p className="font-black uppercase italic text-sm tracking-tight">{rule.label}</p>
                      <p className="text-[10px] text-white/20">{rule.desc}</p>
                    </div>
                    <input 
                      type="checkbox" 
                      className="custom-toggle" 
                      checked={(config as any)[rule.id]}
                      onChange={() => setCompetitionConfig(prev => ({ ...prev, [rule.id]: !(prev as any)[rule.id] }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {currentStep === 'preview' && (
            <div className="space-y-6">
              {/* Tournament Overview */}
              <div className="glass rounded-2xl p-6 border border-brand-green/30">
                <div className="flex items-center gap-3 mb-4">
                  <Trophy className="text-brand-green" size={24} />
                  <h3 className="text-lg font-black uppercase">Tournament Preview</h3>
                </div>
                
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-[10px] text-white/40 uppercase mb-1">Name</p>
                    <p className="font-bold">{config.name || 'Not set'}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-[10px] text-white/40 uppercase mb-1">Format</p>
                    <p className="font-bold uppercase">{config.type}</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-[10px] text-white/40 uppercase mb-1">Teams</p>
                    <p className="font-bold">{config.selectedTeams.length} selected</p>
                  </div>
                  <div className="bg-white/5 rounded-xl p-4">
                    <p className="text-[10px] text-white/40 uppercase mb-1">Start Date</p>
                    <p className="font-bold">{config.startDate}</p>
                  </div>
                </div>
              </div>

              {/* Match Rules */}
              <div className="glass rounded-2xl p-6 border border-white/10">
                <div className="flex items-center gap-3 mb-4">
                  <Settings className="text-brand-blue" size={24} />
                  <h3 className="text-lg font-black uppercase">Match Rules</h3>
                </div>
                
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div className="bg-white/5 rounded-lg p-3 flex items-center gap-2">
                    <Check size={16} className="text-brand-green" />
                    <span className="text-xs">3 pts for Win</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 flex items-center gap-2">
                    <Check size={16} className="text-brand-green" />
                    <span className="text-xs">1 pt for Draw</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 flex items-center gap-2">
                    <Check size={16} className="text-brand-green" />
                    <span className="text-xs">0 pts for Loss</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 flex items-center gap-2">
                    <Calendar size={16} className="text-brand-blue" />
                    <span className="text-xs">{config.matchDuration} min matches</span>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3 flex items-center gap-2">
                    <Calendar size={16} className="text-brand-blue" />
                    <span className="text-xs">{config.homeAway ? 'Home & Away' : 'Single Round'}</span>
                  </div>
                </div>
              </div>

              {/* Groups Preview (for Cup format) */}
              {config.type === 'cup' && (
                <div className="glass rounded-2xl p-6 border border-white/10">
                  <div className="flex items-center gap-3 mb-4">
                    <Globe className="text-purple-500" size={24} />
                    <h3 className="text-lg font-black uppercase">Group Stage Preview</h3>
                  </div>
                  
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {['A', 'B', 'C', 'D'].map((group, i) => {
                      const teamsInGroup = Math.ceil(config.selectedTeams.length / 4);
                      const groupTeams = config.selectedTeams.slice(i * teamsInGroup, (i + 1) * teamsInGroup);
                      return (
                        <div key={group} className="bg-white/5 rounded-lg p-3">
                          <p className="text-xs font-black text-brand-green mb-2">Group {group}</p>
                          <div className="space-y-1">
                            {groupTeams.map((teamId, j) => {
                              const team = availableTeams.find(t => t.id === teamId);
                              return team ? (
                                <p key={j} className="text-[10px] truncate">{team.short_name}</p>
                              ) : null;
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-white/40 mt-4">
                    Top <strong className="text-brand-green">{config.qualifyingTeamsPerGroup}</strong> teams from each group advance to knockout stage
                  </p>
                </div>
              )}

              {/* Fixtures Preview */}
              <div className="glass rounded-2xl p-6 border border-white/10">
                <div className="flex items-center gap-3 mb-4">
                  <Calendar className="text-yellow-500" size={24} />
                  <h3 className="text-lg font-black uppercase">Fixtures Overview</h3>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white/5 rounded-lg p-4 text-center">
                    <p className="text-2xl font-black text-brand-green">
                      {config.type === 'league' 
                        ? Math.floor(config.selectedTeams.length * (config.selectedTeams.length - 1) / (config.homeAway ? 1 : 2))
                        : config.type === 'cup'
                          ? Math.floor(config.selectedTeams.length / 2) + Math.ceil(Math.log2(config.selectedTeams.length)) * 2
                          : Math.ceil(Math.log2(config.selectedTeams.length)) * 2
                      }
                    </p>
                    <p className="text-[10px] text-white/40 uppercase">Total Matches</p>
                  </div>
                  <div className="bg-white/5 rounded-lg p-4 text-center">
                    <p className="text-2xl font-black text-brand-blue">
                      {config.type === 'league' 
                        ? (config.homeAway ? 2 : 1) * (config.selectedTeams.length - 1)
                        : Math.ceil(Math.log2(config.selectedTeams.length)) + 1
                      }
                    </p>
                    <p className="text-[10px] text-white/40 uppercase">
                      {config.type === 'league' ? 'Matchdays' : 'Rounds'}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-8 border-t border-white/10 flex justify-between bg-white/[0.02]">
          <button 
            onClick={() => {
              if (currentStep === 'basic') onClose();
              else if (currentStep === 'teams') setCurrentStep('basic');
              else if (currentStep === 'format') setCurrentStep('teams');
              else if (currentStep === 'rules') setCurrentStep('format');
              else if (currentStep === 'preview') setCurrentStep('rules');
            }}
            className="flex items-center gap-2 px-6 py-3 rounded-xl font-bold uppercase text-xs text-white/40 hover:text-white"
          >
            <ArrowLeft size={16} /> Back
          </button>
          
          <button 
            onClick={() => {
              if (currentStep === 'basic') setCurrentStep('teams');
              else if (currentStep === 'teams') setCurrentStep('format');
              else if (currentStep === 'format') setCurrentStep('rules');
              else if (currentStep === 'rules') setCurrentStep('preview');
              else handleGenerate();
            }}
            className="gradient-green text-black px-10 py-3 rounded-xl font-black uppercase text-xs tracking-widest flex items-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" /> : currentStep === 'preview' ? 'Initialize Tournament' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
