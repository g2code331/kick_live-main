import { useState, useEffect } from 'react';
import { X, Save, Trophy, Calendar, Clock, Settings, Loader2, Hash, Users, AlertTriangle, CheckCircle } from 'lucide-react';
import { supabase } from '../../../lib/supabase';

interface CompetitionEditorProps {
  competition: any;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

const defaultCompetitionSettings = {
  num_groups: 4, teams_per_group: 4, qualifying_teams_per_group: 2,
  has_third_place_playoff: false, knockout_rounds: ['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'],
  match_duration: 90, half_time_duration: 15, extra_time_duration: 30, penalty_shootout: false,
  kickoff_times: ['15:00', '18:00', '20:00'], match_days: ['Saturday', 'Sunday'], rest_days_between: 3,
  points_win: 3, points_draw: 1, points_loss: 0, allow_draws: true, away_goals_rule: false,
  var_enabled: false, substitutions: 5, yellow_card_suspension: 2, red_card_suspension: 1,
  tiebreakers: ['points', 'goal_difference', 'goals_scored', 'head_to_head']
};

export default function CompetitionEditor({ competition, isOpen, onClose, onUpdate }: CompetitionEditorProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'format' | 'schedule' | 'rules'>('general');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    ...defaultCompetitionSettings,
    name: competition?.name || '',
    season: competition?.season || '2025',
    format: competition?.format || competition?.type || 'league',
    status: competition?.status || 'upcoming',
    start_date: competition?.start_date ? competition.start_date.split('T')[0] : '',
    end_date: competition?.end_date ? competition.end_date.split('T')[0] : '',
    // Format & Rules
    num_groups: 4,
    teams_per_group: 4,
    qualifying_teams_per_group: 2,
    has_third_place_playoff: false,
    knockout_rounds: ['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final'],
    // Schedule
    match_duration: 90,
    half_time_duration: 15,
    extra_time_duration: 30,
    penalty_shootout: false,
    kickoff_times: ['15:00', '18:00', '20:00'],
    match_days: ['Saturday', 'Sunday'],
    rest_days_between: 3,
    // Match Rules
    points_win: 3,
    points_draw: 1,
    points_loss: 0,
    allow_draws: true,
    away_goals_rule: false,
    var_enabled: false,
    substitutions: 5,
    yellow_card_suspension: 2,
    red_card_suspension: 1,
    tiebreakers: ['points', 'goal_difference', 'goals_scored', 'head_to_head']
  });

  useEffect(() => {
    if (competition) {
      setFormData(prev => ({
        ...prev,
        name: competition.name || '',
        season: competition.season || '2025',
        format: competition.format || competition.type || 'league',
        status: competition.status || 'upcoming',
        start_date: competition.start_date || '',
        end_date: competition.end_date || '',
        ...(competition.settings || {}),
      }));
    }
  }, [competition]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const settings = {
        num_groups: formData.num_groups, teams_per_group: formData.teams_per_group,
        qualifying_teams_per_group: formData.qualifying_teams_per_group,
        has_third_place_playoff: formData.has_third_place_playoff,
        knockout_rounds: formData.knockout_rounds, match_duration: formData.match_duration,
        half_time_duration: formData.half_time_duration, extra_time_duration: formData.extra_time_duration,
        penalty_shootout: formData.penalty_shootout, kickoff_times: formData.kickoff_times,
        match_days: formData.match_days, rest_days_between: formData.rest_days_between,
        points_win: formData.points_win, points_draw: formData.points_draw, points_loss: formData.points_loss,
        allow_draws: formData.allow_draws, away_goals_rule: formData.away_goals_rule,
        var_enabled: formData.var_enabled, substitutions: formData.substitutions,
        yellow_card_suspension: formData.yellow_card_suspension, red_card_suspension: formData.red_card_suspension,
        tiebreakers: formData.tiebreakers
      };
      const { error } = await supabase.from('competitions').update({
        name: formData.name, season: formData.season, type: formData.format, format: formData.format,
        status: formData.status, start_date: formData.start_date || null, end_date: formData.end_date || null, settings
      }).eq('id', competition.id);
      if (error) throw error;

      // Apply schedule changes only to matches that have not started.
      const { data: scheduledMatches } = await supabase.from('matches').select('id, start_time, status')
        .eq('competition_id', competition.id).in('status', ['scheduled', 'waiting']).order('start_time');
      if (scheduledMatches?.length && formData.kickoff_times.length) {
        const baseDate = new Date(formData.start_date || new Date().toISOString());
        const updated = scheduledMatches.map((m: any, index: number) => {
          const date = new Date(baseDate);
          date.setDate(baseDate.getDate() + index * Math.max(1, Number(formData.rest_days_between) + 1));
          const time = formData.kickoff_times[index % formData.kickoff_times.length].split(':');
          date.setHours(Number(time[0]), Number(time[1]), 0, 0);
          return supabase.from('matches').update({ start_time: date.toISOString() }).eq('id', m.id);
        });
        await Promise.all(updated);
      }
      if (formData.status === 'cancelled') {
        await supabase.from('matches').update({ status: 'cancelled' })
          .eq('competition_id', competition.id).in('status', ['scheduled', 'waiting']);
      }

      alert('Competition, schedule, rules, and match status saved successfully!');
      onUpdate();
      onClose();
    } catch (err: any) {
      alert('Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const hasMatches = competition?.matches_count > 0;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0E13]/95 backdrop-blur-xl" onClick={onClose}></div>
      
      <div className="relative w-full max-w-6xl glass rounded-[3rem] border border-white/10 shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-500">
        
        {/* Header */}
        <div className="px-10 py-8 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-green-500/10 to-blue-500/10">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 gradient-green rounded-2xl flex items-center justify-center shadow-lg shadow-green-500/30">
              <Trophy className="text-black" size={32} />
            </div>
            <div>
              <h2 className="text-3xl font-black italic uppercase tracking-tighter">Edit Competition</h2>
              <p className="text-xs text-white/40 uppercase tracking-widest">{formData.season} Season</p>
            </div>
          </div>
          <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-full transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Tabs */}
        <div className="px-10 py-6 border-b border-white/10 flex gap-4 overflow-x-auto">
          <button
            onClick={() => setActiveTab('general')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap flex items-center gap-2 ${
              activeTab === 'general' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Settings size={16} /> General
          </button>
          <button
            onClick={() => setActiveTab('format')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap flex items-center gap-2 ${
              activeTab === 'format' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Trophy size={16} /> Format & Rules
          </button>
          <button
            onClick={() => setActiveTab('schedule')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap flex items-center gap-2 ${
              activeTab === 'schedule' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Calendar size={16} /> Schedule
          </button>
          <button
            onClick={() => setActiveTab('rules')}
            className={`px-6 py-3 rounded-xl font-black uppercase tracking-widest text-sm whitespace-nowrap flex items-center gap-2 ${
              activeTab === 'rules' ? 'bg-brand-green text-black' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Hash size={16} /> Match Rules
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-10 no-scrollbar">
          {/* GENERAL TAB */}
          {activeTab === 'general' && (
            <div className="space-y-8 max-w-3xl">
              <div>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter mb-2">Basic Information</h3>
                <p className="text-white/40 text-sm">Competition details and identification</p>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Competition Name</label>
                  <input 
                    type="text" 
                    value={formData.name}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                    placeholder="e.g. Premier League 2025" 
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Season</label>
                  <input 
                    type="text" 
                    value={formData.season}
                    onChange={e => setFormData({...formData, season: e.target.value})}
                    placeholder="2025" 
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Start Date</label>
                  <input 
                    type="date" 
                    value={formData.start_date}
                    onChange={e => setFormData({...formData, start_date: e.target.value})}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">End Date</label>
                  <input 
                    type="date" 
                    value={formData.end_date}
                    onChange={e => setFormData({...formData, end_date: e.target.value})}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Competition Type</label>
                <select
                  value={formData.format}
                  onChange={e => setFormData({...formData, format: e.target.value})}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all"
                >
                  <option value="league">League (Round Robin)</option>
                  <option value="cup">Cup (Groups + Knockout)</option>
                  <option value="knockout">Pure Knockout</option>
                </select>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Status</label>
                <select
                  value={formData.status}
                  onChange={e => setFormData({...formData, status: e.target.value})}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all"
                >
                  <option value="upcoming">Upcoming</option>
                  <option value="live">Live</option>
                  <option value="completed">Completed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            </div>
          )}

          {/* FORMAT & RULES TAB */}
          {activeTab === 'format' && (
            <div className="space-y-8 max-w-4xl">
              <div>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter mb-2">Tournament Format</h3>
                <p className="text-white/40 text-sm">Structure and progression rules</p>
              </div>

              {hasMatches ? (
                <div className="p-6 rounded-2xl bg-brand-blue/10 border border-brand-blue/30 flex items-start gap-4">
                  <AlertTriangle className="text-brand-blue shrink-0" size={24} />
                  <div>
                    <p className="font-bold text-brand-blue">Format Locked</p>
                    <p className="text-sm text-white/60 mt-1">Format settings for this tournament are currently locked as matches have already been generated. To change the format, you must delete all fixtures first.</p>
                  </div>
                </div>
              ) : (
                <>
                  {formData.format === 'cup' && (
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-3">
                        <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Number of Groups</label>
                        <input 
                          type="number" 
                          value={formData.num_groups}
                          onChange={e => setFormData({...formData, num_groups: parseInt(e.target.value) || 4})}
                          min={2}
                          max={8}
                          className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                        />
                      </div>
                      <div className="space-y-3">
                        <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Teams per Group</label>
                        <input 
                          type="number" 
                          value={formData.teams_per_group}
                          onChange={e => setFormData({...formData, teams_per_group: parseInt(e.target.value) || 4})}
                          min={3}
                          max={8}
                          className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                        />
                      </div>
                      <div className="space-y-3">
                        <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Qualifying Teams per Group</label>
                        <input 
                          type="number" 
                          value={formData.qualifying_teams_per_group}
                          onChange={e => setFormData({...formData, qualifying_teams_per_group: parseInt(e.target.value) || 2})}
                          min={1}
                          max={4}
                          className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                        />
                      </div>
                      <div className="space-y-3">
                        <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Third Place Playoff</label>
                        <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5">
                          <input
                            type="checkbox"
                            checked={formData.has_third_place_playoff}
                            onChange={e => setFormData({...formData, has_third_place_playoff: e.target.checked})}
                            className="w-5 h-5 rounded"
                          />
                          <span className="text-sm font-bold">Enable third place playoff match</span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Knockout Rounds</label>
                    <div className="space-y-2">
                      {formData.knockout_rounds.map((round, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <span className="text-[10px] font-black text-white/40 w-8">{i + 1}.</span>
                          <input 
                            type="text" 
                            value={round}
                            onChange={e => {
                              const newRounds = [...formData.knockout_rounds];
                              newRounds[i] = e.target.value;
                              setFormData({...formData, knockout_rounds: newRounds});
                            }}
                            className="flex-1 bg-white/5 border border-white/10 rounded-xl p-3 text-white focus:border-brand-green transition-all" 
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              <div className="p-6 rounded-2xl bg-white/5 border border-white/10">
                <h4 className="text-lg font-black uppercase mb-4 flex items-center gap-2">
                  <CheckCircle size={20} className="text-brand-green" />
                  Format Summary
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-white/5">
                    <p className="text-[10px] text-white/40 uppercase mb-1">Format Type</p>
                    <p className="text-lg font-black text-brand-green uppercase">{formData.format}</p>
                  </div>
                  {formData.format === 'cup' && (
                    <>
                      <div className="p-4 rounded-xl bg-white/5">
                        <p className="text-[10px] text-white/40 uppercase mb-1">Total Groups</p>
                        <p className="text-lg font-black text-brand-blue">{formData.num_groups}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-white/5">
                        <p className="text-[10px] text-white/40 uppercase mb-1">Teams Qualifying</p>
                        <p className="text-lg font-black text-brand-blue">{formData.qualifying_teams_per_group} per group</p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* SCHEDULE TAB */}
          {activeTab === 'schedule' && (
            <div className="space-y-8 max-w-4xl">
              <div>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter mb-2">Match Schedule</h3>
                <p className="text-white/40 text-sm">Timing and scheduling configuration</p>
              </div>

              <div className="grid grid-cols-3 gap-6">
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Match Duration (min)</label>
                  <input 
                    type="number" 
                    value={formData.match_duration}
                    onChange={e => setFormData({...formData, match_duration: parseInt(e.target.value) || 90})}
                    min={45}
                    max={120}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Half-Time Break (min)</label>
                  <input 
                    type="number" 
                    value={formData.half_time_duration}
                    onChange={e => setFormData({...formData, half_time_duration: parseInt(e.target.value) || 15})}
                    min={10}
                    max={30}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Extra Time (min)</label>
                  <input 
                    type="number" 
                    value={formData.extra_time_duration}
                    onChange={e => setFormData({...formData, extra_time_duration: parseInt(e.target.value) || 30})}
                    min={0}
                    max={60}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5">
                <input
                  type="checkbox"
                  checked={formData.penalty_shootout}
                  onChange={e => setFormData({...formData, penalty_shootout: e.target.checked})}
                  className="w-5 h-5 rounded"
                />
                <div>
                  <p className="text-sm font-bold">Enable Penalty Shootout</p>
                  <p className="text-[10px] text-white/40">For knockout matches that end in a draw</p>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Rest Days Between Matches</label>
                <input 
                  type="number" 
                  value={formData.rest_days_between}
                  onChange={e => setFormData({...formData, rest_days_between: parseInt(e.target.value) || 3})}
                  min={1}
                  max={14}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                />
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Kickoff Times</label>
                <div className="flex flex-wrap gap-2">
                  {formData.kickoff_times.map((time, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white/5 rounded-xl px-4 py-2">
                      <span className="text-sm font-bold">{time}</span>
                      <button 
                        onClick={() => {
                          const newTimes = formData.kickoff_times.filter((_, idx) => idx !== i);
                          setFormData({...formData, kickoff_times: newTimes});
                        }}
                        className="text-white/40 hover:text-brand-red"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  <button 
                    onClick={() => {
                      const time = prompt('Enter kickoff time (HH:MM format):');
                      if (time) {
                        setFormData({...formData, kickoff_times: [...formData.kickoff_times, time]});
                      }
                    }}
                    className="px-4 py-2 rounded-xl bg-brand-green/10 text-brand-green hover:bg-brand-green/20 text-sm font-bold"
                  >
                    + Add Time
                  </button>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Match Days</label>
                <div className="flex flex-wrap gap-2">
                  {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => (
                    <button
                      key={day}
                      onClick={() => {
                        const isSelected = formData.match_days.includes(day);
                        setFormData({
                          ...formData,
                          match_days: isSelected 
                            ? formData.match_days.filter(d => d !== day)
                            : [...formData.match_days, day]
                        });
                      }}
                      className={`px-4 py-2 rounded-xl text-sm font-bold ${
                        formData.match_days.includes(day)
                          ? 'bg-brand-green text-black'
                          : 'bg-white/5 text-white/40 hover:bg-white/10'
                      }`}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* MATCH RULES TAB */}
          {activeTab === 'rules' && (
            <div className="space-y-8 max-w-4xl">
              <div>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter mb-2">Match Rules</h3>
                <p className="text-white/40 text-sm">Gameplay regulations and scoring system</p>
              </div>

              <div className="p-6 rounded-2xl bg-white/5 border border-white/10">
                <h4 className="text-lg font-black uppercase mb-6 flex items-center gap-2">
                  <Trophy size={20} className="text-brand-green" />
                  Points System
                </h4>
                <div className="grid grid-cols-3 gap-6">
                  <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Win</label>
                    <input 
                      type="number" 
                      value={formData.points_win}
                      onChange={e => setFormData({...formData, points_win: parseInt(e.target.value) || 3})}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Draw</label>
                    <input 
                      type="number" 
                      value={formData.points_draw}
                      onChange={e => setFormData({...formData, points_draw: parseInt(e.target.value) || 1})}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                    />
                  </div>
                  <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Loss</label>
                    <input 
                      type="number" 
                      value={formData.points_loss}
                      onChange={e => setFormData({...formData, points_loss: parseInt(e.target.value) || 0})}
                      className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                    />
                  </div>
                </div>
              </div>

              <div className="p-6 rounded-2xl bg-white/5 border border-white/10">
                <h4 className="text-lg font-black uppercase mb-6 flex items-center gap-2">
                  <Users size={20} className="text-brand-blue" />
                  Match Regulations
                </h4>
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5">
                    <input
                      type="checkbox"
                      checked={formData.allow_draws}
                      onChange={e => setFormData({...formData, allow_draws: e.target.checked})}
                      className="w-5 h-5 rounded"
                    />
                    <div>
                      <p className="text-sm font-bold">Allow Draws</p>
                      <p className="text-[10px] text-white/40">Matches can end in a tie (league format)</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5">
                    <input
                      type="checkbox"
                      checked={formData.away_goals_rule}
                      onChange={e => setFormData({...formData, away_goals_rule: e.target.checked})}
                      className="w-5 h-5 rounded"
                    />
                    <div>
                      <p className="text-sm font-bold">Away Goals Rule</p>
                      <p className="text-[10px] text-white/40">Away goals count double in knockout ties</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-4 rounded-xl bg-white/5">
                    <input
                      type="checkbox"
                      checked={formData.var_enabled}
                      onChange={e => setFormData({...formData, var_enabled: e.target.checked})}
                      className="w-5 h-5 rounded"
                    />
                    <div>
                      <p className="text-sm font-bold">VAR Enabled</p>
                      <p className="text-[10px] text-white/40">Video Assistant Referee for key decisions</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Substitutions Allowed</label>
                  <input 
                    type="number" 
                    value={formData.substitutions}
                    onChange={e => setFormData({...formData, substitutions: parseInt(e.target.value) || 5})}
                    min={0}
                    max={12}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Yellow Card Suspension</label>
                  <input 
                    type="number" 
                    value={formData.yellow_card_suspension}
                    onChange={e => setFormData({...formData, yellow_card_suspension: parseInt(e.target.value) || 2})}
                    min={1}
                    max={10}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Red Card Suspension</label>
                  <input 
                    type="number" 
                    value={formData.red_card_suspension}
                    onChange={e => setFormData({...formData, red_card_suspension: parseInt(e.target.value) || 1})}
                    min={1}
                    max={10}
                    className="w-full bg-white/5 border border-white/10 rounded-2xl p-4 text-white focus:border-brand-green transition-all" 
                  />
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black uppercase text-white/40 tracking-widest">Tiebreakers (in order)</label>
                <div className="space-y-2">
                  {formData.tiebreakers.map((tiebreaker, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-white/5">
                      <span className="text-[10px] font-black text-white/40 w-8">{i + 1}.</span>
                      <span className="text-sm font-bold capitalize">{tiebreaker.replace('_', ' ')}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-10 py-6 border-t border-white/10 flex justify-end gap-4 bg-[#0B0E13]/90 backdrop-blur-xl">
          <button 
            onClick={onClose}
            className="px-8 py-3 rounded-xl font-bold uppercase text-sm text-white/60 hover:text-white transition-colors"
          >
            Discard
          </button>
          <button 
            onClick={handleSave}
            disabled={loading}
            className="gradient-green text-black px-10 py-3 rounded-xl font-black uppercase text-sm tracking-widest flex items-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
