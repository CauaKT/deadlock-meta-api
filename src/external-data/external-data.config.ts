export const DEADLOCK_API_BASE = 'https://api.deadlock-api.com';
export const STEAM64_BASE = 76561197960265728n;

export const REGIONAL_LIST = [
  'Europe',
  'NAmerica',
  'SAmerica',
  'Asia',
  'Oceania',
] as const;

export const ALLOWED_REGIONS = new Set<string>(['Global', ...REGIONAL_LIST]);
export const DEFAULT_LEADERBOARD_REGION = 'SAmerica';

export const LEADERBOARD_LIMIT_CONFIG = {
  defaultLimit: 25,
  minLimit: 10,
  maxLimit: 50,
  maxHeroFilterCount: 3,
  maxPageLimit: 20000,
  maxSearchChars: 64,
} as const;

export const RANK_POINTS_PER_TIER = 6500;
export const MAX_RANK_TIER = 11;

export const EXTERNAL_CACHE_TTL_SECONDS = {
  activeMatches: 60,
  playerSummary: 900,
  leaderboardRaw: 1800,
  leaderboardPage: 1800,
  playerbaseDaily: 3600,
  rankDistribution: 3600,
  matchDetail: 86400,
} as const;