export interface NormalizedPlayerHeroStat {
  heroId: number;
  matches: number;
  wins: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  soulsPerMin: number;
  damagePerMin: number;
  accuracy: number;
  timePlayedSec: number;
}

export interface NormalizedPlayerMatch {
  matchId: number;
  heroId: number;
  durationSec: number;
  won: boolean;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number;
  startTime: number;
}

export interface NormalizedPlayerSummary {
  accountId: string;
  personaName: string | null;
  avatarUrl: string | null;
  rankBadge: number | null;
  matches: number;
  wins: number;
  winRate: number;
  kda: number;
  soulsPerMin: number;
  damagePerMin: number;
  topHeroes: NormalizedPlayerHeroStat[];
  recentMatches: NormalizedPlayerMatch[];
  fetchedAt: string;
}

export interface NormalizedLeaderboardEntry {
  rank: number;
  accountId: number | null;
  accountName: string;
  badgeLevel: number | null;
  rankedRank: number | null;
  rankedSubrank: number | null;
  topHeroIds: number[];
}

export interface NormalizedLeaderboardResponse {
  region: string;
  heroId: number | null;
  entries: NormalizedLeaderboardEntry[];
  fetchedAt: string;
}

export interface NormalizedMatchPlayer {
  accountId: number;
  heroId: number;
  team: number;
  kills: number;
  deaths: number;
  assists: number;
  netWorth: number;
  lastHits: number;
  denies: number;
  heroDamage: number;
  objDamage: number;
  healing: number;
  items: number[];
}

export interface NormalizedMatchDetail {
  matchId: number;
  durationSec: number;
  startTime: number;
  winningTeam: number;
  gameMode: string | number | null;
  players: NormalizedMatchPlayer[];
  fetchedAt: string;
}

export interface ExternalDataStatus {
  cacheBackend: 'postgresql';
  cachedEntries: number;
  lastUpdatedAt: string | null;
  sources: Array<{
    id: string;
    name: string;
    baseUrl: string;
    ttlSeconds: number;
  }>;
}