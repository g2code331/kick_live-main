/**
 * KICKLIVE PROFESSIONAL COMPETITION ENGINE
 * FIFA/EA FC 26 Style Tournament Management System
 * 
 * Senior Software Architect Implementation
 * Follows FIFA competition standards
 */

export type CompetitionFormat = 'league' | 'cup' | 'knockout' | 'friendly';

export interface Team {
  id: number;
  name: string;
  short_name: string;
}

export interface Match {
  competition_id: number;
  home_team_id: number;
  away_team_id: number;
  start_time: string;
  matchday?: number;
  group?: string;
  round?: string;
  venue?: string;
  status: 'scheduled' | 'live' | 'finished';
}

export interface Standing {
  teamId: number;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
  form: string[];
}

export interface LeagueConfig {
  rounds: 'single' | 'double';
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
  startDate: string;
  endDate: string;
  matchDays: string[];
  kickoffTimes: string[];
  restDays: number;
}

export interface CupConfig {
  numGroups: number;
  teamsPerGroup: number;
  qualifyingPerGroup: number;
  hasThirdPlace: boolean;
  drawMethod: 'random' | 'seeded' | 'manual';
}

export interface KnockoutConfig {
  hasThirdPlace: boolean;
  extraTime: boolean;
  penaltyShootout: boolean;
  awayGoalsRule: boolean;
  legs: 'single' | 'double';
}

/**
 * ROUND ROBIN ALGORITHM (Berger Tables)
 * Generates fair league fixtures with no duplicates
 */
export class LeagueEngine {
  private teams: Team[];
  private config: LeagueConfig;

  constructor(teams: Team[], config: LeagueConfig) {
    this.teams = teams;
    this.config = config;
  }

  generateFixtures(competitionId: number): Match[] {
    const fixtures: Match[] = [];
    const numTeams = this.teams.length;
    
    if (numTeams < 2) return [];

    const teamIds = this.teams.map(t => t.id);
    const rounds = this.config.rounds === 'double' ? (numTeams - 1) * 2 : numTeams - 1;
    const matchesPerRound = Math.floor(numTeams / 2);

    for (let round = 1; round <= rounds; round++) {
      const matchDate = this.calculateMatchDate(round);

      for (let i = 0; i < matchesPerRound; i++) {
        let homeTeamId = teamIds[i];
        let awayTeamId = teamIds[numTeams - 1 - i];

        // Alternating home/away for the fixed team (id 0) to ensure fairness
        if (round % 2 === 0 && i === 0) {
          [homeTeamId, awayTeamId] = [awayTeamId, homeTeamId];
        } else if (round > numTeams - 1) {
          [homeTeamId, awayTeamId] = [awayTeamId, homeTeamId];
        }

        fixtures.push({
          competition_id: competitionId,
          home_team_id: homeTeamId,
          away_team_id: awayTeamId,
          start_time: matchDate.toISOString(),
          matchday: round,
          venue: 'TBD',
          status: 'scheduled'
        });
      }

      // Rotate teams (keep first team fixed)
      teamIds.splice(1, 0, teamIds.pop()!);
    }

    return fixtures;
  }

  private calculateMatchDate(round: number): Date {
    const startDate = new Date(this.config.startDate);
    const daysBetween = (this.config.restDays + 1) * 7; // Weekly matches
    
    const matchDate = new Date(startDate);
    matchDate.setDate(matchDate.getDate() + ((round - 1) * daysBetween));
    
    // Set kickoff time
    const timeIndex = (round - 1) % this.config.kickoffTimes.length;
    const [hours, minutes] = this.config.kickoffTimes[timeIndex].split(':');
    matchDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    return matchDate;
  }

  generateStandings(matches: any[]): Standing[] {
    const standings = new Map<number, Standing>();

    // Initialize standings for all teams
    this.teams.forEach(team => {
      standings.set(team.id, {
        teamId: team.id,
        teamName: team.name,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        gf: 0,
        ga: 0,
        gd: 0,
        points: 0,
        form: []
      });
    });

    // Process matches
    matches.forEach(match => {
      if (match.status !== 'finished') return;

      const home = standings.get(match.home_team_id)!;
      const away = standings.get(match.away_team_id)!;

      home.played++;
      away.played++;

      home.gf += match.home_score;
      home.ga += match.away_score;
      away.gf += match.away_score;
      away.ga += match.home_score;

      home.gd = home.gf - home.ga;
      away.gd = away.gf - away.ga;

      // Determine result
      if (match.home_score > match.away_score) {
        home.won++;
        home.points += this.config.pointsWin;
        away.lost++;
        away.points += this.config.pointsLoss;
        home.form.push('W');
        away.form.push('L');
      } else if (match.home_score < match.away_score) {
        away.won++;
        away.points += this.config.pointsWin;
        home.lost++;
        home.points += this.config.pointsLoss;
        home.form.push('L');
        away.form.push('W');
      } else {
        home.drawn++;
        home.points += this.config.pointsDraw;
        away.drawn++;
        away.points += this.config.pointsDraw;
        home.form.push('D');
        away.form.push('D');
      }
    });

    return Array.from(standings.values()).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return b.teamName.localeCompare(a.teamName);
    });
  }
}

/**
 * CUP ENGINE (Group Stage + Knockout)
 * FIFA World Cup style tournament
 */
export class CupEngine {
  private teams: Team[];
  private config: CupConfig;

  constructor(teams: Team[], config: CupConfig) {
    this.teams = teams;
    this.config = config;
  }

  generateFixtures(competitionId: number): Match[] {
    const fixtures: Match[] = [];

    // Distribute teams into groups
    const groups = this.distributeTeams();

    // Generate group stage fixtures
    groups.forEach((groupTeams, groupName) => {
      const groupFixtures = this.generateGroupFixtures(
        competitionId,
        groupTeams,
        groupName
      );
      fixtures.push(...groupFixtures);
    });

    // Generate knockout stage (will be populated after group stage completes)
    const knockoutFixtures = this.generateKnockoutBracket(competitionId, groups);
    fixtures.push(...knockoutFixtures);

    return fixtures;
  }

  private distributeTeams(): Map<string, Team[]> {
    const groups = new Map<string, Team[]>();
    const groupNames = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

    // Initialize groups
    for (let i = 0; i < this.config.numGroups; i++) {
      groups.set(groupNames[i], []);
    }

    // Random shuffle and distribute
    const shuffledTeams = [...this.teams].sort(() => Math.random() - 0.5);
    
    shuffledTeams.forEach((team, index) => {
      const groupIndex = index % this.config.numGroups;
      const groupName = groupNames[groupIndex];
      groups.get(groupName)!.push(team);
    });

    return groups;
  }

  private generateGroupFixtures(
    competitionId: number,
    teams: Team[],
    groupName: string
  ): Match[] {
    const fixtures: Match[] = [];
    const numTeams = teams.length;
    const rounds = numTeams - 1;
    const matchesPerRound = Math.floor(numTeams / 2);

    // Create array of team objects (not just IDs) to rotate
    const rotatingTeams = [...teams];
    const startDate = new Date();

    for (let round = 1; round <= rounds; round++) {
      for (let i = 0; i < matchesPerRound; i++) {
        const home = rotatingTeams[i];
        const away = rotatingTeams[numTeams - 1 - i];
        
        const matchDate = new Date(startDate);
        matchDate.setDate(matchDate.getDate() + (round * 7));

        fixtures.push({
          competition_id: competitionId,
          home_team_id: home.id,
          away_team_id: away.id,
          start_time: matchDate.toISOString(),
          group: groupName,
          status: 'scheduled',
          venue: 'TBD'
        });
      }

      // Rotate
      if (numTeams > 1) {
        const lastTeam = rotatingTeams.pop();
        if (lastTeam) {
          rotatingTeams.splice(1, 0, lastTeam);
        }
      }
    }

    console.log(`Generated ${fixtures.length} fixtures for group ${groupName}`);
    return fixtures;
  }

  private generateKnockoutBracket(
    _competitionId: number,
    _groups: Map<string, Team[]>
  ): Match[] {
    // Don't generate knockout fixtures yet - they will be auto-created
    // when group stage matches are completed and teams qualify
    // This prevents foreign key errors with team_id = 0
    return [];
  }

  generateGroupStandings(matches: any[], groupName: string): any[] {
    const groupTeams = Array.from(
      new Set(
        matches
          .filter(m => m.group === groupName)
          .flatMap(m => [m.home_team_id, m.away_team_id])
      )
    );

    const standings = groupTeams.map(teamId => ({
      teamId,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      gf: 0,
      ga: 0,
      gd: 0,
      points: 0
    }));

    // Process matches for this group
    matches
      .filter(m => m.group === groupName && m.status === 'finished')
      .forEach(match => {
        const home = standings.find(s => s.teamId === match.home_team_id)!;
        const away = standings.find(s => s.teamId === match.away_team_id)!;

        home.played++;
        away.played++;
        home.gf += match.home_score;
        home.ga += match.away_score;
        away.gf += match.away_score;
        away.ga += match.home_score;
        home.gd = home.gf - home.ga;
        away.gd = away.gf - away.ga;

        if (match.home_score > match.away_score) {
          home.won++;
          home.points += 3;
          away.lost++;
        } else if (match.home_score < match.away_score) {
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

    return standings.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      return 0;
    });
  }
}

/**
 * KNOCKOUT ENGINE
 * Pure elimination tournament (FA Cup, Champions League KO style)
 */
export class KnockoutEngine {
  private teams: Team[];

  constructor(teams: Team[], _config: KnockoutConfig) {
    this.teams = teams;
  }

  generateFixtures(competitionId: number): Match[] {
    const fixtures: Match[] = [];
    const numTeams = this.teams.length;
    
    if (numTeams < 2) return [];

    // Calculate next power of 2
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(numTeams)));
    const roundName = this.getRoundName(bracketSize);

    // Shuffle teams for initial draw
    const shuffledTeams = [...this.teams].sort(() => Math.random() - 0.5);
    const seededBracket = this.seedTeams(numTeams, bracketSize);

    for (let i = 0; i < bracketSize; i += 2) {
      const home = seededBracket[i];
      const away = seededBracket[i + 1];

      // If one team is null, it's a 'bye' (handled differently in UI)
      if (home && away) {
        fixtures.push({
          competition_id: competitionId,
          home_team_id: home.id,
          away_team_id: away.id,
          start_time: new Date().toISOString(),
          round: roundName,
          status: 'scheduled',
          venue: 'TBD'
        });
      }
    }

    console.log('[KnockoutEngine] Generated', fixtures.length, 'knockout fixtures');
    return fixtures;
  }

  /**
   * Seed teams properly for knockout bracket
   * Uses simple 1vN, 2v(N-1) seeding
   */
  private seedTeams(numTeams: number, bracketSize: number): (Team | null)[] {
    const seeded: (Team | null)[] = new Array(bracketSize).fill(null);
    const availableTeams = [...this.teams].sort(() => Math.random() - 0.5);

    // Simple seeding: 1 vs N, 2 vs (N-1), etc.
    for (let i = 0; i < numTeams; i++) {
      // Logic for proper seeding could be complex, using simple distribution for now
      seeded[i] = availableTeams[i];
    }

    return seeded;
  }

  private getRoundName(size: number): string {
    if (size === 2) return 'Final';
    if (size === 4) return 'Semi-Final';
    if (size === 8) return 'Quarter-Final';
    if (size === 16) return 'Round of 16';
    if (size === 32) return 'Round of 32';
    return `Round of ${size}`;
  }
}

/** One-off or home-and-away friendly fixtures. Friendly tournaments require exactly two teams. */
export class FriendlyEngine {
  private teams: Team[];
  private config: any;
  constructor(teams: Team[], config: any) { this.teams = teams; this.config = config; }
  generateFixtures(competitionId: number): Match[] {
    if (this.teams.length !== 2) return [];
    const start = new Date(this.config.startDate);
    const makeMatch = (home: Team, away: Team, date: Date, matchday: number): Match => ({
      competition_id: competitionId, home_team_id: home.id, away_team_id: away.id,
      start_time: date.toISOString(), matchday, round: 'Friendly', venue: 'TBD', status: 'scheduled'
    });
    const fixtures = [makeMatch(this.teams[0], this.teams[1], start, 1)];
    if (this.config.homeAway) {
      const returnDate = new Date(start); returnDate.setDate(returnDate.getDate() + 7);
      fixtures.push(makeMatch(this.teams[1], this.teams[0], returnDate, 2));
    }
    return fixtures;
  }
}

/**
 * MAIN COMPETITION ENGINE FACTORY
 */
export class CompetitionEngine {
  static create(
    format: CompetitionFormat,
    teams: Team[],
    config: LeagueConfig | CupConfig | KnockoutConfig,
    competitionId: number
  ): Match[] {
    switch (format) {
      case 'league':
        return new LeagueEngine(teams, config as LeagueConfig).generateFixtures(competitionId);
      case 'cup':
        return new CupEngine(teams, config as CupConfig).generateFixtures(competitionId);
      case 'knockout':
        return new KnockoutEngine(teams, config as KnockoutConfig).generateFixtures(competitionId);
      case 'friendly':
        return new FriendlyEngine(teams, config as any).generateFixtures(competitionId);
      default:
        throw new Error(`Unknown competition format: ${format}`);
    }
  }

  static calculateStandings(
    format: CompetitionFormat,
    matches: any[],
    teams: Team[],
    config?: LeagueConfig | CupConfig
  ): any[] {
    switch (format) {
      case 'league':
        return new LeagueEngine(teams, config as LeagueConfig).generateStandings(matches);
      case 'cup':
        // Return group standings
        const groups = new Set(matches.map(m => m.group).filter(Boolean));
        const standings: any[] = [];
        
        groups.forEach(groupName => {
          const groupStandings = new CupEngine(teams, config as CupConfig).generateGroupStandings(
            matches,
            groupName as string
          );
          standings.push({ group: groupName, standings: groupStandings });
        });
        
        return standings;
      default:
        return [];
    }
  }
}
