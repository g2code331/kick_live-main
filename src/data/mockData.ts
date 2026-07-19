export interface Team {
  id: number;
  name: string;
  shortName: string;
  city: string;
  coach: string;
  primaryColor: string;
  secondaryColor: string;
  logo?: string;
}

export interface Player {
  id: number;
  name: string;
  position: string;
  number: number;
  teamId: number;
  goals: number;
  assists: number;
  nationality: string;
}

export interface Match {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
  status: 'live' | 'scheduled' | 'finished';
  startTime: string;
  venue: string;
  competition: string;
  minute?: number;
  homeTeam: Team;
  awayTeam: Team;
}

export interface StandingRow {
  name: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
  gd: number;
  points: number;
}

export interface MediaItem {
  id: number;
  title: string;
  category: string;
  image: string;
  date: string;
  excerpt: string;
}

export const teams: Team[] = [
  { id: 1, name: "Black Stars FC", shortName: "BSF", city: "Accra", coach: "Otto Addo", primaryColor: "#FFD700", secondaryColor: "#000000" },
  { id: 2, name: "Kumasi United", shortName: "KMU", city: "Kumasi", coach: "Michael Osei", primaryColor: "#FF4500", secondaryColor: "#FFFFFF" },
  { id: 3, name: "Cape Coast Lions", shortName: "CCL", city: "Cape Coast", coach: "Samuel Boadu", primaryColor: "#1E90FF", secondaryColor: "#FFFFFF" },
  { id: 4, name: "Tamale Warriors", shortName: "TMW", city: "Tamale", coach: "Karim Abdul", primaryColor: "#32CD32", secondaryColor: "#000000" },
  { id: 5, name: "Tema Harbour FC", shortName: "THF", city: "Tema", coach: "Richard Kingson", primaryColor: "#9400D3", secondaryColor: "#FFD700" },
  { id: 6, name: "Sekondi Eagles", shortName: "SKE", city: "Sekondi", coach: "Abdul Razak", primaryColor: "#DC143C", secondaryColor: "#FFFFFF" },
  { id: 7, name: "Volta Rangers", shortName: "VLR", city: "Ho", coach: "Sellas Tetteh", primaryColor: "#FF8C00", secondaryColor: "#000000" },
  { id: 8, name: "Sunyani Phoenix", shortName: "SNP", city: "Sunyani", coach: "Paa Kwesi Fabin", primaryColor: "#00CED1", secondaryColor: "#FFD700" },
];

export const players: Player[] = [
  { id: 1, name: "Iñaki Williams", position: "Forward", number: 9, teamId: 1, goals: 12, assists: 5, nationality: "Ghana" },
  { id: 2, name: "Mohammed Kudus", position: "Midfielder", number: 10, teamId: 1, goals: 9, assists: 8, nationality: "Ghana" },
  { id: 3, name: "Jordan Ayew", position: "Forward", number: 11, teamId: 2, goals: 7, assists: 4, nationality: "Ghana" },
  { id: 4, name: "Thomas Partey", position: "Midfielder", number: 5, teamId: 3, goals: 5, assists: 10, nationality: "Ghana" },
  { id: 5, name: "Alexander Djiku", position: "Defender", number: 4, teamId: 4, goals: 2, assists: 1, nationality: "Ghana" },
  { id: 6, name: "Joseph Aidoo", position: "Defender", number: 3, teamId: 5, goals: 1, assists: 2, nationality: "Ghana" },
  { id: 7, name: "Abdul Fatawu Issahaku", position: "Forward", number: 7, teamId: 6, goals: 8, assists: 6, nationality: "Ghana" },
  { id: 8, name: "Ernest Nuamah", position: "Forward", number: 14, teamId: 7, goals: 6, assists: 3, nationality: "Ghana" },
  { id: 9, name: "Kamaldeen Sulemana", position: "Forward", number: 17, teamId: 8, goals: 5, assists: 7, nationality: "Ghana" },
  { id: 10, name: "Antoine Semenyo", position: "Forward", number: 12, teamId: 1, goals: 4, assists: 5, nationality: "Ghana" },
  { id: 11, name: "Ibrahim Osman", position: "Midfielder", number: 8, teamId: 2, goals: 3, assists: 4, nationality: "Ghana" },
  { id: 12, name: "Denis Odoi", position: "Defender", number: 2, teamId: 3, goals: 0, assists: 3, nationality: "Ghana" },
  { id: 13, name: "Daniel Amartey", position: "Defender", number: 6, teamId: 4, goals: 1, assists: 0, nationality: "Ghana" },
  { id: 14, name: "Tariq Lamptey", position: "Defender", number: 22, teamId: 5, goals: 1, assists: 6, nationality: "Ghana" },
  { id: 15, name: "Elisha Owusu", position: "Midfielder", number: 16, teamId: 6, goals: 2, assists: 5, nationality: "Ghana" },
  { id: 16, name: "Osman Bukari", position: "Forward", number: 19, teamId: 7, goals: 4, assists: 2, nationality: "Ghana" },
];

const now = new Date();
const today = now.toISOString().split('T')[0];
const tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
const twoDaysAgo = new Date(now.getTime() - 172800000).toISOString().split('T')[0];

export const matches: Match[] = [
  {
    id: 1, homeTeamId: 1, awayTeamId: 2, homeScore: 2, awayScore: 1,
    status: "live", startTime: `${today}T15:00:00`, venue: "Accra Sports Stadium",
    competition: "Rx Premier League", minute: 76, homeTeam: teams[0], awayTeam: teams[1]
  },
  {
    id: 2, homeTeamId: 3, awayTeamId: 4, homeScore: 1, awayScore: 1,
    status: "live", startTime: `${today}T15:00:00`, venue: "Cape Coast Stadium",
    competition: "Rx Premier League", minute: 63, homeTeam: teams[2], awayTeam: teams[3]
  },
  {
    id: 3, homeTeamId: 5, awayTeamId: 6, homeScore: 0, awayScore: 0,
    status: "scheduled", startTime: `${today}T18:00:00`, venue: "Tema Stadium",
    competition: "Rx Premier League", homeTeam: teams[4], awayTeam: teams[5]
  },
  {
    id: 4, homeTeamId: 7, awayTeamId: 8, homeScore: 0, awayScore: 0,
    status: "scheduled", startTime: `${tomorrow}T15:00:00`, venue: "Ho Stadium",
    competition: "Rx Cup", homeTeam: teams[6], awayTeam: teams[7]
  },
  {
    id: 5, homeTeamId: 1, awayTeamId: 4, homeScore: 3, awayScore: 0,
    status: "finished", startTime: `${yesterday}T15:00:00`, venue: "Accra Sports Stadium",
    competition: "Rx Premier League", homeTeam: teams[0], awayTeam: teams[3]
  },
  {
    id: 6, homeTeamId: 6, awayTeamId: 3, homeScore: 1, awayScore: 2,
    status: "finished", startTime: `${yesterday}T18:00:00`, venue: "Sekondi Stadium",
    competition: "Rx Premier League", homeTeam: teams[5], awayTeam: teams[2]
  },
  {
    id: 7, homeTeamId: 2, awayTeamId: 5, homeScore: 2, awayScore: 2,
    status: "finished", startTime: `${twoDaysAgo}T15:00:00`, venue: "Kumasi Stadium",
    competition: "Rx Cup", homeTeam: teams[1], awayTeam: teams[4]
  },
  {
    id: 8, homeTeamId: 8, awayTeamId: 7, homeScore: 4, awayScore: 1,
    status: "finished", startTime: `${twoDaysAgo}T18:00:00`, venue: "Sunyani Stadium",
    competition: "Rx Premier League", homeTeam: teams[7], awayTeam: teams[6]
  },
];

export const standings: StandingRow[] = [
  { name: "Black Stars FC", played: 10, won: 8, drawn: 1, lost: 1, gf: 24, ga: 8, gd: 16, points: 25 },
  { name: "Cape Coast Lions", played: 10, won: 7, drawn: 2, lost: 1, gf: 20, ga: 10, gd: 10, points: 23 },
  { name: "Sunyani Phoenix", played: 10, won: 6, drawn: 2, lost: 2, gf: 18, ga: 12, gd: 6, points: 20 },
  { name: "Kumasi United", played: 10, won: 5, drawn: 3, lost: 2, gf: 16, ga: 11, gd: 5, points: 18 },
  { name: "Sekondi Eagles", played: 10, won: 4, drawn: 2, lost: 4, gf: 14, ga: 14, gd: 0, points: 14 },
  { name: "Tema Harbour FC", played: 10, won: 3, drawn: 2, lost: 5, gf: 12, ga: 16, gd: -4, points: 11 },
  { name: "Volta Rangers", played: 10, won: 2, drawn: 1, lost: 7, gf: 9, ga: 20, gd: -11, points: 7 },
  { name: "Tamale Warriors", played: 10, won: 1, drawn: 1, lost: 8, gf: 7, ga: 29, gd: -22, points: 4 },
];

export const mediaItems: MediaItem[] = [
  {
    id: 1,
    title: "Black Stars FC Continue Their Dominance with 3-0 Victory",
    category: "Match Report",
    image: "https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&q=80&w=800",
    date: yesterday,
    excerpt: "An emphatic performance from the league leaders as they dispatch Tamale Warriors at home."
  },
  {
    id: 2,
    title: "Mohammed Kudus Named Player of the Month",
    category: "News",
    image: "https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&q=80&w=800",
    date: twoDaysAgo,
    excerpt: "The young midfielder has been exceptional for Kumasi United this month, scoring 4 goals."
  },
];
