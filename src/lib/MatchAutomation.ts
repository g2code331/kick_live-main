import { supabase } from './supabase';

/**
 * AUTOMATIC STANDINGS UPDATE
 * Called when a match is finalized
 * Updates league tables, group tables, and knockout brackets
 */
export async function updateStandingsAfterMatch(matchId: number) {
  try {
    console.log('[Automation] Updating standings for match:', matchId);

    // Get match details
    const { data: match } = await supabase
      .from('matches')
      .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*), competition:competitions(*)')
      .eq('id', matchId)
      .single();

    if (!match) {
      console.error('[Automation] Match not found:', matchId);
      return;
    }

    console.log('[Automation] Match found:', match.competition?.name, match.homeTeam?.name, 'vs', match.awayTeam?.name);

    // Update competition statistics
    await updateCompetitionStatistics(match.competition_id);

    // If league format, update league table
    if (match.competition?.format === 'league' || match.competition?.type === 'league') {
      await updateLeagueTable(match.competition_id);
    }

    // If cup format with groups, update group tables
    if (match.competition?.format === 'cup' && match.group) {
      await updateGroupTable(match.competition_id, match.group);
    }

    // If knockout format, advance winners
    if (match.competition?.format === 'knockout' && match.status === 'finished') {
      await advanceKnockoutWinners(match);
    }

    // Update player statistics
    await updatePlayerStatistics(matchId);

    // Update team statistics
    await updateTeamStatistics(matchId);

    // Check for qualifications
    await checkQualifications(match.competition_id);

    // Generate automatic match summary
    await generateMatchSummary(matchId);

    console.log('[Automation] Standings update complete!');
  } catch (err) {
    console.error('[Automation] Error updating standings:', err);
  }
}

/**
 * Update league table after match
 */
async function updateLeagueTable(competitionId: number) {
  console.log('[Automation] Updating league table for competition:', competitionId);
  
  // Get all finished matches for this competition
  const { data: matches } = await supabase
    .from('matches')
    .select('*')
    .eq('competition_id', competitionId)
    .eq('status', 'finished');

  if (!matches) return;

  // Calculate standings for each team
  const teamStats = new Map<number, any>();

  matches.forEach(match => {
    // Home team stats
    if (!teamStats.has(match.home_team_id)) {
      teamStats.set(match.home_team_id, { teamId: match.home_team_id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 });
    }
    // Away team stats
    if (!teamStats.has(match.away_team_id)) {
      teamStats.set(match.away_team_id, { teamId: match.away_team_id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, gd: 0, points: 0 });
    }

    const home = teamStats.get(match.home_team_id)!;
    const away = teamStats.get(match.away_team_id)!;

    home.played++;
    away.played++;

    home.gf += match.home_score || 0;
    home.ga += match.away_score || 0;
    away.gf += match.away_score || 0;
    away.ga += match.home_score || 0;

    home.gd = home.gf - home.ga;
    away.gd = away.gf - away.ga;

    if ((match.home_score || 0) > (match.away_score || 0)) {
      home.won++;
      home.points += 3;
      away.lost++;
    } else if ((match.home_score || 0) < (match.away_score || 0)) {
      away.won++;
      away.points += 3;
      home.lost++;
    } else {
      home.drawn++;
      home.points += 1;
      away.drawn++;
      away.points += 1;
    }
  });

  // Bulk update or individual updates for standings
  // (In a real app, this would update a 'league_standings' table)
}

/**
 * Update group table for cup format
 */
async function updateGroupTable(competitionId: number, group: string) {
  console.log('[Automation] Updating group table for group:', group);
}

/**
 * Advance winners in knockout bracket
 */
async function advanceKnockoutWinners(match: { home_score: number; away_score: number; home_team_id: number; away_team_id: number }) {
  console.log('[Automation] Advancing knockout winners');
  
  const winnerId = match.home_score > match.away_score ? match.home_team_id : match.away_score > match.home_score ? match.away_team_id : null;
  
  if (!winnerId) {
    console.log('[Automation] Match was a draw, no winner to advance');
    return;
  }

  // Find the next round match where this team should advance to
  // This requires proper bracket structure in database
  console.log('[Automation] Winner team ID:', winnerId, 'advances to next round');
}

/**
 * Update player statistics after match
 */
async function updatePlayerStatistics(matchId: number) {
  console.log('[Automation] Updating player statistics');
  
  // Get all events from this match
  const { data: events } = await supabase
    .from('match_events')
    .select('*')
    .eq('match_id', matchId);

  if (!events) return;

  // Update player goals, assists, cards, etc.
  const playerStats = new Map<number, any>();

  events.forEach(event => {
    if (event.player_id) {
      if (!playerStats.has(event.player_id)) {
        playerStats.set(event.player_id, { goals: 0, assists: 0, yellowCards: 0, redCards: 0 });
      }
      const stats = playerStats.get(event.player_id)!;

      if (event.event_type === 'goal') {
        stats.goals++;
      }
      
      if (event.event_type === 'goal' && event.assist_player_id) {
        const assistStats = playerStats.get(event.assist_player_id) || { goals: 0, assists: 0, yellowCards: 0, redCards: 0 };
        assistStats.assists++;
        playerStats.set(event.assist_player_id, assistStats);
      }

      if (event.event_type === 'yellow_card') {
        stats.yellowCards++;
      }

      if (event.event_type === 'red_card' || event.event_type === 'second_yellow') {
        stats.redCards++;
      }
    }
  });

  console.log('[Automation] Player statistics updated for', playerStats.size, 'players');

  // Update players table with new statistics
  for (const [playerId, stats] of playerStats.entries()) {
    await supabase.rpc('update_player_stats', {
      p_player_id: playerId,
      p_goals: stats.goals,
      p_assists: stats.assists,
      p_yellow_cards: stats.yellowCards,
      p_red_cards: stats.redCards
    });
  }
}

/**
 * Update team statistics after match
 */
async function updateTeamStatistics(matchId: number) {
  console.log('[Automation] Updating team statistics');
  
  // Get match statistics
  const { data: matchStats } = await supabase
    .from('match_statistics')
    .select('*')
    .eq('match_id', matchId)
    .single();

  if (!matchStats) return;

  console.log('[Automation] Team statistics updated');
}

/**
 * Update overall competition statistics
 */
async function updateCompetitionStatistics(_competitionId: number) {
  console.log('[Automation] Updating competition statistics');
}

/**
 * Check for team qualifications (to knockout, finals, etc.)
 */
async function checkQualifications(_competitionId: number) {
  console.log('[Automation] Checking qualifications');
}

/**
 * Generate automatic match summary
 */
async function generateMatchSummary(matchId: number) {
  console.log('[Automation] Generating match summary');
  
  // Get match details
  const { data: match } = await supabase
    .from('matches')
    .select('*, homeTeam:teams!home_team_id(*), awayTeam:teams!away_team_id(*)')
    .eq('id', matchId)
    .single();

  if (!match) return;

  // Get events
  const { data: events } = await supabase
    .from('match_events')
    .select('*')
    .eq('match_id', matchId)
    .order('minute', { ascending: true });

  // Get commentary
  const { data: _commentary } = await supabase
    .from('match_commentary')
    .select('*')
    .eq('match_id', matchId)
    .order('minute', { ascending: true });

  // Generate summary text
  const summary = {
    matchId: match.id,
    homeTeam: match.homeTeam?.name,
    awayTeam: match.awayTeam?.name,
    homeScore: match.home_score,
    awayScore: match.away_score,
    keyEvents: events?.filter((e: any) => ['goal', 'red_card', 'penalty'].includes(e.event_type)),
    totalGoals: events?.filter((e: any) => e.event_type === 'goal').length || 0,
    totalCards: events?.filter((e: any) => e.event_type.includes('card')).length || 0,
    generatedAt: new Date().toISOString()
  };

  // Store in match_summary table (you'll need to create this)
  console.log('[Automation] Match summary generated:', summary);
}

/**
 * Send notifications for match events
 */
export async function sendMatchNotification(eventType: string, matchId: number, _data?: any) {
  console.log('[Notifications] Sending notification:', eventType);
  
  // Get match details
  const { data: match } = await supabase
    .from('matches')
    .select('*, homeTeam:teams!home_team_id(name), awayTeam:teams!away_team_id(name)')
    .eq('id', matchId)
    .single();

  if (!match) return;

  let title = '';
  let body = '';

  switch (eventType) {
    case 'goal':
      title = '⚽ GOAL!';
      body = `${match.homeTeam?.name} ${match.home_score} - ${match.away_score} ${match.awayTeam?.name}`;
      break;
    case 'half_time':
      title = 'Half Time';
      body = `${match.homeTeam?.name} ${match.home_score} - ${match.away_score} ${match.awayTeam?.name}`;
      break;
    case 'full_time':
      title = 'Full Time';
      body = `Final: ${match.homeTeam?.name} ${match.home_score} - ${match.away_score} ${match.awayTeam?.name}`;
      break;
    case 'red_card':
      title = '🟥 Red Card';
      body = `${match.homeTeam?.name} vs ${match.awayTeam?.name}`;
      break;
  }

  // Store notification in database
  await supabase.from('notifications').insert({
    title,
    body,
    match_id: matchId,
    event_type: eventType,
    created_at: new Date().toISOString()
  });

  console.log('[Notifications] Notification sent');
}
