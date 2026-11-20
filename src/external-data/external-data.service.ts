import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  ExternalDataStatus,
  NormalizedLeaderboardEntry,
  NormalizedLeaderboardResponse,
  NormalizedMatchDetail,
  NormalizedMatchPlayer,
  NormalizedPlayerHeroStat,
  NormalizedPlayerMatch,
  NormalizedPlayerSummary,
} from './external-data.types';

const DEADLOCK_API_BASE = 'https://api.deadlock-api.com';
const STEAM64_BASE = 76561197960265728n;

const ALLOWED_REGIONS = new Set([
  'Europe',
  'NAmerica',
  'SAmerica',
  'Asia',
  'Oceania',
]);

@Injectable()
export class ExternalDataService {
  private readonly logger = new Logger(ExternalDataService.name);

  constructor(private readonly prisma: PrismaService) {}

  private normalizeAccountId(raw: string): string {
    const clean = raw.trim();
    if (!/^\d+$/.test(clean)) {
      throw new BadRequestException('Steam ID / Account ID inválido.');
    }
    const val = BigInt(clean);
    if (val > STEAM64_BASE) {
      return (val - STEAM64_BASE).toString();
    }
    return val.toString();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} em ${url}`);
    }
    return (await res.json()) as T;
  }

  private async withDbCache<T>(
    key: string,
    source: string,
    ttlSeconds: number,
    producer: () => Promise<T>,
  ): Promise<{ data: T; fetchedAt: string }> {
    const now = new Date();
    const cached = await this.prisma.externalCache.findUnique({
      where: { key },
    });

    if (cached && cached.expiresAt > now) {
      return {
        data: cached.payload as T,
        fetchedAt: cached.fetchedAt.toISOString(),
      };
    }

    try {
      const fresh = await producer();
      const fetchedAt = new Date();
      const expiresAt = new Date(fetchedAt.getTime() + ttlSeconds * 1000);

      await this.prisma.externalCache.upsert({
        where: { key },
        create: {
          key,
          source,
          payload: fresh as unknown as Prisma.InputJsonValue,
          fetchedAt,
          expiresAt,
        },
        update: {
          source,
          payload: fresh as unknown as Prisma.InputJsonValue,
          fetchedAt,
          expiresAt,
        },
      });

      return { data: fresh, fetchedAt: fetchedAt.toISOString() };
    } catch (err) {
      this.logger.warn(
        `Falha ao consultar fonte externa (${key}): ${err instanceof Error ? err.message : String(err)}`,
      );
      if (cached) {
        return {
          data: cached.payload as T,
          fetchedAt: cached.fetchedAt.toISOString(),
        };
      }
      throw new ServiceUnavailableException(
        'Fonte externa temporariamente indisponível.',
      );
    }
  }

  async getPlayerSummary(rawAccountId: string): Promise<NormalizedPlayerSummary> {
    const accountId = this.normalizeAccountId(rawAccountId);
    const cacheKey = `player_summary:${accountId}`;

    const { data, fetchedAt } = await this.withDbCache<Omit<NormalizedPlayerSummary, 'fetchedAt'>>(
      cacheKey,
      'deadlock-api',
      900,
      async () => {
        const [heroRes, historyRes, mmrRes, steamRes] = await Promise.allSettled([
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/hero-stats`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/match-history`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/mmr`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/steam?account_ids=${accountId}`,
          ),
        ]);

        const rawHeroes = heroRes.status === 'fulfilled' && Array.isArray(heroRes.value) ? heroRes.value : [];
        const rawHistory = historyRes.status === 'fulfilled' && Array.isArray(historyRes.value) ? historyRes.value : [];
        const rawMmr = mmrRes.status === 'fulfilled' && Array.isArray(mmrRes.value) ? mmrRes.value : [];
        const rawSteam = steamRes.status === 'fulfilled' && Array.isArray(steamRes.value) ? steamRes.value[0] : null;

        const topHeroes: NormalizedPlayerHeroStat[] = rawHeroes
          .map((h) => {
            const matches = Number(h.matches_played ?? h.matches ?? 0);
            const wins = Number(h.wins ?? 0);
            const kills = Number(h.kills ?? 0);
            const deaths = Number(h.deaths ?? 0);
            const assists = Number(h.assists ?? 0);
            return {
              heroId: Number(h.hero_id ?? 0),
              matches,
              wins,
              winRate: matches > 0 ? Number(((wins / matches) * 100).toFixed(2)) : 0,
              kills,
              deaths,
              assists,
              kda: Number(((kills + assists) / Math.max(1, deaths)).toFixed(2)),
              soulsPerMin: Number(Number(h.networth_per_min ?? 0).toFixed(1)),
              damagePerMin: Number(Number(h.damage_per_min ?? 0).toFixed(1)),
              accuracy: Number((Number(h.accuracy ?? 0) * 100).toFixed(1)),
              timePlayedSec: Number(h.time_played ?? 0),
            };
          })
          .filter((h) => h.heroId > 0 && h.matches > 0)
          .sort((a, b) => b.matches - a.matches);

        const totalMatches = topHeroes.reduce((acc, h) => acc + h.matches, 0);
        const totalWins = topHeroes.reduce((acc, h) => acc + h.wins, 0);
        const totalKills = topHeroes.reduce((acc, h) => acc + h.kills, 0);
        const totalDeaths = topHeroes.reduce((acc, h) => acc + h.deaths, 0);
        const totalAssists = topHeroes.reduce((acc, h) => acc + h.assists, 0);

        const weightedSpm =
          totalMatches > 0
            ? topHeroes.reduce((acc, h) => acc + h.soulsPerMin * h.matches, 0) / totalMatches
            : 0;
        const weightedDpm =
          totalMatches > 0
            ? topHeroes.reduce((acc, h) => acc + h.damagePerMin * h.matches, 0) / totalMatches
            : 0;

        const recentMatches: NormalizedPlayerMatch[] = rawHistory
          .slice(0, 20)
          .map((m) => {
            const team = Number(m.player_team ?? 0);
            const result = Number(m.match_result ?? -1);
            return {
              matchId: Number(m.match_id ?? 0),
              heroId: Number(m.hero_id ?? 0),
              durationSec: Number(m.match_duration_s ?? 0),
              won: result === team,
              kills: Number(m.player_kills ?? 0),
              deaths: Number(m.player_deaths ?? 0),
              assists: Number(m.player_assists ?? 0),
              netWorth: Number(m.net_worth ?? 0),
              startTime: Number(m.start_time ?? 0),
            };
          })
          .filter((m) => m.matchId > 0);

        const latestMmr = rawMmr[0];
        const rankBadge =
          typeof latestMmr?.division === 'number' && typeof latestMmr?.division_tier === 'number'
            ? latestMmr.division * 10 + latestMmr.division_tier
            : null;

        return {
          accountId,
          personaName: typeof rawSteam?.personaname === 'string' ? rawSteam.personaname : null,
          avatarUrl: typeof rawSteam?.avatarfull === 'string'
            ? rawSteam.avatarfull
            : typeof rawSteam?.avatar === 'string'
              ? rawSteam.avatar
              : null,
          rankBadge,
          matches: totalMatches,
          wins: totalWins,
          winRate: totalMatches > 0 ? Number(((totalWins / totalMatches) * 100).toFixed(2)) : 0,
          kda: Number(((totalKills + totalAssists) / Math.max(1, totalDeaths)).toFixed(2)),
          soulsPerMin: Number(weightedSpm.toFixed(1)),
          damagePerMin: Number(weightedDpm.toFixed(1)),
          topHeroes: topHeroes.slice(0, 12),
          recentMatches,
        };
      },
    );

    return { ...data, fetchedAt };
  }

  async getLeaderboard(
    rawRegion: string,
    heroId?: number,
  ): Promise<NormalizedLeaderboardResponse> {
    const region = ALLOWED_REGIONS.has(rawRegion) ? rawRegion : 'SAmerica';
    const validHeroId = heroId && Number.isInteger(heroId) && heroId > 0 ? heroId : null;
    const cacheKey = validHeroId
      ? `leaderboard:${region}:hero:${validHeroId}`
      : `leaderboard:${region}`;

    const { data, fetchedAt } = await this.withDbCache<NormalizedLeaderboardEntry[]>(
      cacheKey,
      'deadlock-api',
      1800,
      async () => {
        const endpoint = validHeroId
          ? `${DEADLOCK_API_BASE}/v1/leaderboard/${region}/${validHeroId}`
          : `${DEADLOCK_API_BASE}/v1/leaderboard/${region}`;
        const raw = await this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(endpoint);
        const list = Array.isArray(raw?.entries) ? raw.entries : [];

        return list.slice(0, 100).map((item, idx) => ({
          rank: Number(item.rank ?? idx + 1),
          accountId: typeof item.possible_account_ids === 'object' && Array.isArray(item.possible_account_ids) && item.possible_account_ids.length > 0
            ? Number(item.possible_account_ids[0])
            : typeof item.account_id === 'number'
              ? item.account_id
              : null,
          accountName: typeof item.account_name === 'string' && item.account_name.trim()
            ? item.account_name.trim()
            : `Jogador #${idx + 1}`,
          badgeLevel: typeof item.badge_level === 'number' ? item.badge_level : null,
          rankedRank: typeof item.ranked_rank === 'number' ? item.ranked_rank : null,
          rankedSubrank: typeof item.ranked_subrank === 'number' ? item.ranked_subrank : null,
          topHeroIds: Array.isArray(item.top_hero_ids)
            ? item.top_hero_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
            : [],
        }));
      },
    );

    return {
      region,
      heroId: validHeroId,
      entries: data,
      fetchedAt,
    };
  }

  async getMatchDetail(rawMatchId: string): Promise<NormalizedMatchDetail> {
    if (!/^\d+$/.test(rawMatchId.trim())) {
      throw new BadRequestException('Match ID inválido.');
    }
    const matchId = Number(rawMatchId.trim());
    const cacheKey = `match:${matchId}`;

    const { data, fetchedAt } = await this.withDbCache<Omit<NormalizedMatchDetail, 'fetchedAt'>>(
      cacheKey,
      'deadlock-api',
      86400,
      async () => {
        const raw = await this.fetchJson<{
          match_info?: Record<string, unknown>;
        }>(`${DEADLOCK_API_BASE}/v1/matches/${matchId}/metadata`);
        const info = raw?.match_info ?? {};
        const rawPlayers = Array.isArray(info.players) ? (info.players as Array<Record<string, unknown>>) : [];

        const players: NormalizedMatchPlayer[] = rawPlayers.map((p) => {
          const statsArr = Array.isArray(p.stats) ? (p.stats as Array<Record<string, unknown>>) : [];
          const lastStat = statsArr.length > 0 ? statsArr[statsArr.length - 1] : {};
          const rawItems = Array.isArray(p.items) ? (p.items as Array<Record<string, unknown>>) : [];

          return {
            accountId: Number(p.account_id ?? 0),
            heroId: Number(p.hero_id ?? 0),
            team: Number(p.team ?? 0),
            kills: Number(p.kills ?? 0),
            deaths: Number(p.deaths ?? 0),
            assists: Number(p.assists ?? 0),
            netWorth: Number(lastStat.net_worth ?? p.net_worth ?? 0),
            lastHits: Number(p.last_hits ?? 0),
            denies: Number(p.denies ?? 0),
            heroDamage: Number(lastStat.player_damage ?? 0),
            objDamage: Number(lastStat.boss_damage ?? 0),
            healing: Number(lastStat.player_healing ?? 0),
            items: rawItems
              .map((it) => Number(it.item_id ?? 0))
              .filter((id) => Number.isFinite(id) && id > 0),
          };
        });

        return {
          matchId,
          durationSec: Number(info.duration_s ?? 0),
          startTime: Number(info.start_time ?? 0),
          winningTeam: Number(info.winning_team ?? 0),
          gameMode: (info.game_mode as string | number | null) ?? null,
          players,
        };
      },
    );

    return { ...data, fetchedAt };
  }

  async getStatus(): Promise<ExternalDataStatus> {
    const [cachedEntries, latest] = await Promise.all([
      this.prisma.externalCache.count(),
      this.prisma.externalCache.findFirst({
        orderBy: { fetchedAt: 'desc' },
        select: { fetchedAt: true },
      }),
    ]);

    return {
      cacheBackend: 'postgresql',
      cachedEntries,
      lastUpdatedAt: latest?.fetchedAt.toISOString() ?? null,
      sources: [
        {
          id: 'deadlock-api',
          name: 'Deadlock API (Comunitária)',
          baseUrl: DEADLOCK_API_BASE,
          ttlSeconds: 900,
        },
      ],
    };
  }
}