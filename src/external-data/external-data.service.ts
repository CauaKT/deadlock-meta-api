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
  PlayerbaseOverviewResponse,
  RankDistributionResponse,
  RankDistributionTier,
} from './external-data.types';

const DEADLOCK_API_BASE = 'https://api.deadlock-api.com';
const STEAM64_BASE = 76561197960265728n;

const REGIONAL_LIST = ['Europe', 'NAmerica', 'SAmerica', 'Asia', 'Oceania'] as const;
const ALLOWED_REGIONS = new Set<string>(['Global', ...REGIONAL_LIST]);

@Injectable()
export class ExternalDataService {
  private readonly logger = new Logger(ExternalDataService.name);
  private readonly refreshingKeys = new Set<string>();

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

  private async fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} em ${url}`);
      }
      return (await res.json()) as T;
    }
    throw new Error(`HTTP 429 em ${url}`);
  }

  private async withDbCache<T>(
    key: string,
    source: string,
    ttlSeconds: number,
    producer: () => Promise<T>,
    staleWhileRevalidate = false,
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

    const refresh = async () => {
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
    };

    if (cached && staleWhileRevalidate) {
      if (!this.refreshingKeys.has(key)) {
        this.refreshingKeys.add(key);
        void refresh()
          .catch((err) => {
            this.logger.warn(
              `Falha ao revalidar cache em segundo plano (${key}): ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            this.refreshingKeys.delete(key);
          });
      }
      return {
        data: cached.payload as T,
        fetchedAt: cached.fetchedAt.toISOString(),
      };
    }

    try {
      return await refresh();
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
        const [heroRes, historyRes, mmrRes, rankRes, steamRes] = await Promise.allSettled([
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/hero-stats`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/match-history`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/mmr`,
          ),
          this.fetchJson<{ badge?: number | null; rank?: number | null; subrank?: number | null }>(
            `${DEADLOCK_API_BASE}/v1/players/${accountId}/rank`,
          ),
          this.fetchJson<Array<Record<string, unknown>>>(
            `${DEADLOCK_API_BASE}/v1/players/steam?account_ids=${accountId}`,
          ),
        ]);

        const rawHeroes = heroRes.status === 'fulfilled' && Array.isArray(heroRes.value) ? heroRes.value : [];
        const rawHistory = historyRes.status === 'fulfilled' && Array.isArray(historyRes.value) ? historyRes.value : [];
        const rawMmr = mmrRes.status === 'fulfilled' && Array.isArray(mmrRes.value) ? mmrRes.value : [];
        const rawRank = rankRes.status === 'fulfilled' ? rankRes.value : null;
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
          typeof rawRank?.badge === 'number' && rawRank.badge > 0
            ? rawRank.badge
            : typeof rawRank?.rank === 'number' && rawRank.rank > 0
              ? rawRank.rank * 10 + (typeof rawRank.subrank === 'number' && rawRank.subrank > 0 ? rawRank.subrank : 1)
              : typeof latestMmr?.division === 'number' && typeof latestMmr?.division_tier === 'number'
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

  private async getActiveMatchesMap(): Promise<
    Record<string, { matchId: number; heroId: number; startTime: number }>
  > {
    try {
      const { data } = await this.withDbCache<
        Record<string, { matchId: number; heroId: number; startTime: number }>
      >('active_matches_map', 'deadlock-api', 60, async () => {
        const list = await this.fetchJson<
          Array<{
            match_id?: number;
            start_time?: number;
            players?: Array<{ account_id?: number; hero_id?: number }>;
          }>
        >(`${DEADLOCK_API_BASE}/v1/matches/active`);

        const map: Record<string, { matchId: number; heroId: number; startTime: number }> = {};
        if (!Array.isArray(list)) return map;

        for (const match of list) {
          const matchId = Number(match.match_id ?? 0);
          const startTime = Number(match.start_time ?? 0);
          if (!matchId || !Array.isArray(match.players)) continue;
          for (const p of match.players) {
            const aid = Number(p.account_id ?? 0);
            const hid = Number(p.hero_id ?? 0);
            if (aid > 0 && hid > 0) {
              map[String(aid)] = { matchId, heroId: hid, startTime };
            }
          }
        }
        return map;
      });
      return data;
    } catch {
      return {};
    }
  }

  private async loadSnapshotPage(
    requestedPage: number,
    limit: number,
    tier: number | null,
    region: string,
    heroIds: number[] = [],
  ): Promise<{
    total: number;
    page: number;
    rows: Array<{ rank: number; accountId: number; points: number; topHeroes: number[] }>;
  } | null> {
    try {
      if (heroIds.length > 0) {
        const synced = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM leaderboard_snapshot WHERE cardinality(top_heroes) > 0) AS ok`;
        if (!synced[0]?.ok) return null;
      } else {
        const hasAny = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM leaderboard_snapshot) AS ok`;
        if (!hasAny[0]?.ok) return null;
      }

      const lo = tier ? 6500 * (tier - 1) : -1000000;
      const hi = tier && tier < 11 ? 6500 * tier : 1000000000;
      const regionSql =
        region === 'Global' ? Prisma.empty : Prisma.sql`AND region = ${region}`;
      const heroSql =
        heroIds.length === 1
          ? Prisma.sql`AND top_heroes[1] = ${heroIds[0]}`
          : heroIds.length === 2
            ? Prisma.sql`AND top_heroes[1:4] @> ${heroIds}::int[]`
            : heroIds.length >= 3
              ? Prisma.sql`AND top_heroes @> ${heroIds}::int[]`
              : Prisma.empty;

      const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COUNT(*)::bigint AS total
        FROM leaderboard_snapshot
        WHERE points >= ${lo} AND points < ${hi} ${regionSql} ${heroSql}`;
      const total = Number(countRows[0]?.total ?? 0);

      const above = tier
        ? Number(
            (
              await this.prisma.$queryRaw<Array<{ above: bigint }>>`
                SELECT COUNT(*)::bigint AS above
                FROM leaderboard_snapshot
                WHERE points >= ${hi} ${regionSql} ${heroSql}`
            )[0]?.above ?? 0,
          )
        : 0;

      const totalPages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * limit;

      const rows = await this.prisma.$queryRaw<
        Array<{ account_id: bigint; points: number; top_heroes: number[] }>
      >`
        SELECT account_id, points, top_heroes
        FROM leaderboard_snapshot
        WHERE points >= ${lo} AND points < ${hi} ${regionSql} ${heroSql}
        ORDER BY points DESC, account_id ASC
        LIMIT ${limit} OFFSET ${offset}`;

      return {
        total,
        page,
        rows: rows.map((r, idx) => ({
          rank: above + offset + idx + 1,
          accountId: Number(r.account_id),
          points: Number(r.points),
          topHeroes: Array.isArray(r.top_heroes) ? r.top_heroes : [],
        })),
      };
    } catch (err) {
      this.logger.warn(
        `Snapshot do leaderboard indisponível: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async searchSnapshotByNick(
    query: string,
    requestedPage: number,
    limit: number,
    tier: number | null,
    region: string,
    heroIds: number[] = [],
  ): Promise<{
    total: number;
    page: number;
    rows: Array<{ rank: number; accountId: number; points: number; topHeroes: number[] }>;
  } | null> {
    try {
      if (heroIds.length > 0) {
        const synced = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM leaderboard_snapshot WHERE cardinality(top_heroes) > 0) AS ok`;
        if (!synced[0]?.ok) return null;
      } else {
        const hasAny = await this.prisma.$queryRaw<Array<{ ok: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM leaderboard_snapshot) AS ok`;
        if (!hasAny[0]?.ok) return null;
      }

      const STEAM64_BASE = 76561197960265728n;
      const toAccountId = (raw?: string | null): number | null => {
        if (!raw) return null;
        const clean = raw.trim();
        if (!/^\d+$/.test(clean)) return null;
        if (clean.length === 17 && clean.startsWith('7656119')) {
          const aid = Number(BigInt(clean) - STEAM64_BASE);
          return Number.isInteger(aid) && aid > 0 ? aid : null;
        }
        if (clean.length >= 3 && clean.length <= 12) {
          const aid = Number(clean);
          return Number.isInteger(aid) && aid > 0 ? aid : null;
        }
        return null;
      };

      const resolveVanityAccountId = async (vanity: string): Promise<number | null> => {
        try {
          const res = await fetch(
            `https://steamcommunity.com/id/${encodeURIComponent(vanity)}/?xml=1`,
            { signal: AbortSignal.timeout(4000) },
          );
          if (!res.ok) return null;
          const xml = await res.text();
          const m = xml.match(/<steamID64>(\d{17})<\/steamID64>/);
          return m ? toAccountId(m[1]) : null;
        } catch {
          return null;
        }
      };

      const directIds: number[] = [];
      let steamRows: Array<{ account_id?: number }> = [];

      const q = query.trim();
      const profileMatch = q.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
      const idUrlMatch = q.match(/steamcommunity\.com\/id\/([a-zA-Z0-9_-]+)/i);
      const shortSteamMatch = q.match(/s\.team\/p\/[a-z0-9-]+/i);

      if (q.startsWith('@')) {
        const handleClean = q.slice(1).trim();
        if (handleClean.length >= 2) {
          const prof = await this.prisma.profile.findFirst({
            where: { handle: { equals: handleClean, mode: 'insensitive' } },
            select: { steamId: true, user: { select: { steamId: true } } },
          });
          const aid = toAccountId(prof?.steamId ?? prof?.user?.steamId ?? null);
          if (aid) directIds.push(aid);
        }
      } else if (profileMatch) {
        const aid = toAccountId(profileMatch[1]);
        if (aid) directIds.push(aid);
      } else if (idUrlMatch) {
        const aid = await resolveVanityAccountId(idUrlMatch[1]);
        if (aid) directIds.push(aid);
      } else if (shortSteamMatch) {
        try {
          const fullUrl = q.startsWith('http') ? q : `https://${q}`;
          const res = await fetch(fullUrl, { redirect: 'follow', signal: AbortSignal.timeout(4000) });
          const m = res.url.match(/\/profiles\/(\d{17})/);
          const v = res.url.match(/\/id\/([a-zA-Z0-9_-]+)/);
          const aid = m ? toAccountId(m[1]) : v ? await resolveVanityAccountId(v[1]) : null;
          if (aid) directIds.push(aid);
        } catch {
          // Ignora falha na resolução de link curto
        }
      } else {
        const numId = toAccountId(q);
        if (numId) {
          directIds.push(numId);
        } else {
          const [searchRes, vanityRes] = await Promise.allSettled([
            this.fetchJson<Array<{ account_id?: number }>>(
              `${DEADLOCK_API_BASE}/v1/players/steam-search?search_query=${encodeURIComponent(q)}&limit=50`,
              10_000,
            ),
            /^[a-zA-Z0-9_-]{2,64}$/.test(q) ? resolveVanityAccountId(q) : Promise.resolve(null),
          ]);
          if (searchRes.status === 'fulfilled' && Array.isArray(searchRes.value)) {
            steamRows = searchRes.value;
          }
          if (vanityRes.status === 'fulfilled' && vanityRes.value) {
            directIds.push(vanityRes.value);
          }
        }
      }

      const candidateIds = Array.from(
        new Set([
          ...directIds,
          ...steamRows
            .map((r) => Number(r.account_id ?? 0))
            .filter((id) => Number.isInteger(id) && id > 0),
        ]),
      );
      if (candidateIds.length === 0) {
        return { total: 0, page: 1, rows: [] };
      }

      const lo = tier ? 6500 * (tier - 1) : -1000000;
      const hi = tier && tier < 11 ? 6500 * tier : 1000000000;
      const regionSql =
        region === 'Global' ? Prisma.empty : Prisma.sql`AND region = ${region}`;
      const heroSql =
        heroIds.length === 1
          ? Prisma.sql`AND top_heroes[1] = ${heroIds[0]}`
          : heroIds.length === 2
            ? Prisma.sql`AND top_heroes[1:4] @> ${heroIds}::int[]`
            : heroIds.length >= 3
              ? Prisma.sql`AND top_heroes @> ${heroIds}::int[]`
              : Prisma.empty;

      const matched = await this.prisma.$queryRaw<
        Array<{ account_id: bigint; points: number; top_heroes: number[] }>
      >`
        SELECT account_id, points, top_heroes
        FROM leaderboard_snapshot
        WHERE account_id = ANY(${candidateIds.map((id) => BigInt(id))}::bigint[])
          AND points >= ${lo} AND points < ${hi} ${regionSql} ${heroSql}
        ORDER BY points DESC, account_id ASC`;

      const total = matched.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(requestedPage, totalPages);
      const offset = (page - 1) * limit;
      const slice = matched.slice(offset, offset + limit);

      const ranked = await Promise.all(
        slice.map(async (r) => {
          const rkRows = await this.prisma.$queryRaw<Array<{ rk: bigint }>>`
            SELECT COUNT(*)::bigint + 1 AS rk
            FROM leaderboard_snapshot
            WHERE (points > ${r.points} OR (points = ${r.points} AND account_id < ${r.account_id}))
              ${regionSql} ${heroSql}`;
          return {
            rank: Number(rkRows[0]?.rk ?? 1),
            accountId: Number(r.account_id),
            points: Number(r.points),
            topHeroes: Array.isArray(r.top_heroes) ? r.top_heroes : [],
          };
        }),
      );

      return { total, page, rows: ranked };
    } catch (err) {
      this.logger.warn(
        `Busca global por nick indisponível: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async getLeaderboard(
    rawRegion: string,
    heroIds?: number[] | number,
    rawPage = 1,
    rawLimit = 25,
    rawTier?: number,
    rawSearch?: string,
  ): Promise<NormalizedLeaderboardResponse> {
    const region = ALLOWED_REGIONS.has(rawRegion) ? rawRegion : 'SAmerica';
    const rawHeroList = Array.isArray(heroIds)
      ? heroIds
      : typeof heroIds === 'number'
        ? [heroIds]
        : [];
    const validHeroIds = Array.from(
      new Set(rawHeroList.filter((id) => Number.isInteger(id) && id > 0)),
    ).slice(0, 3);
    const validHeroId = validHeroIds[0] ?? null;
    const heroKey =
      validHeroIds.length > 0 ? [...validHeroIds].sort((a, b) => a - b).join(',') : '0';
    const limit = Number.isFinite(rawLimit) ? Math.max(10, Math.min(50, Math.floor(rawLimit))) : 25;
    const requestedPage = Number.isFinite(rawPage) ? Math.max(1, Math.min(20000, Math.floor(rawPage))) : 1;
    const validTier =
      typeof rawTier === 'number' && Number.isInteger(rawTier) && rawTier >= 1 && rawTier <= 11
        ? rawTier
        : null;
    const searchQuery = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 64) : '';

    const rawCacheKey =
      validHeroIds.length > 0
        ? `leaderboard_raw:v6:${region}:heroes:${heroKey}`
        : `leaderboard_raw:v5:${region}`;

    type BatchRankRow = {
      account_id?: number;
      badge?: number | null;
      rank?: number | null;
      subrank?: number | null;
      last_match?: {
        player_rank_final_flat_progress?: number | null;
      } | null;
    };

    type ResolvedRawEntry = {
      rank: number;
      accountId: number | null;
      accountName: string;
      badgeLevel: number | null;
      rankedRank: number | null;
      rankedSubrank: number | null;
      points: number | null;
      topHeroIds: number[];
    };

    const tierOfValues = (badgeLevel: number | null, rankedRank: number | null) => {
      if (typeof rankedRank === 'number' && rankedRank >= 1) return rankedRank;
      if (typeof badgeLevel === 'number' && badgeLevel >= 11) return Math.floor(badgeLevel / 10);
      return 0;
    };

    const fetchRanksBatch = async (ids: number[]): Promise<Map<number, BatchRankRow>> => {
      const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)));
      const map = new Map<number, BatchRankRow>();
      const chunks: number[][] = [];
      for (let i = 0; i < unique.length; i += 100) {
        chunks.push(unique.slice(i, i + 100));
      }

      for (let w = 0; w < chunks.length; w += 3) {
        if (w > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const wave = chunks.slice(w, w + 3);
        await Promise.allSettled(
          wave.map(async (chunk) => {
            const url = `${DEADLOCK_API_BASE}/v1/players/rank?account_ids=${chunk.join(',')}`;
            try {
              const rows = await this.fetchJson<BatchRankRow[]>(url, 15_000);
              if (Array.isArray(rows)) {
                for (const row of rows) {
                  if (typeof row.account_id === 'number' && row.account_id > 0) {
                    map.set(row.account_id, row);
                  }
                }
              }
            } catch {
              // Ignora falha pontual de lote de patente
            }
          }),
        );
      }
      return map;
    };

    const snapshot =
      searchQuery.length >= 2
        ? await this.searchSnapshotByNick(
            searchQuery,
            requestedPage,
            limit,
            validTier,
            region,
            validHeroIds,
          )
        : await this.loadSnapshotPage(
            requestedPage,
            limit,
            validTier,
            region,
            validHeroIds,
          );

    const { data: rawEntries } = snapshot
      ? { data: [] as ResolvedRawEntry[] }
      : await this.withDbCache<ResolvedRawEntry[]>(
      validHeroIds.length > 0
        ? `leaderboard_raw:v10:${region}:t${validTier ?? 0}:heroes:${heroKey}`
        : rawCacheKey,
      'deadlock-api',
      1800,
      async () => {
        if (validHeroIds.length > 0) {
          const lo = validTier ? 6500 * (validTier - 1) : -1000000;
          const hi = validTier && validTier < 11 ? 6500 * validTier : 1000000000;
          const isGlobal = region === 'Global';

          let candidates: Array<{ account_id: bigint; points: number }> = [];
          try {
            const tierHaving = validTier
              ? ` AND pts >= ${lo} AND pts < ${hi}`
              : '';
            const sql =
              'SELECT account_id, argMax(player_rank_final_flat_progress, start_time) AS pts ' +
              'FROM match_player_latest ' +
              `WHERE start_time > now() - INTERVAL 14 DAY AND rank_interval = 2 AND hero_id IN (${validHeroIds.join(',')}) ` +
              'AND player_rank_final_flat_progress IS NOT NULL ' +
              'GROUP BY account_id ' +
              `HAVING COUNT(DISTINCT hero_id) = ${validHeroIds.length}${tierHaving} ` +
              'ORDER BY pts DESC LIMIT 3000';
            const sqlRes = await fetch(
              `${DEADLOCK_API_BASE}/v1/sql?format=json&query=${encodeURIComponent(sql)}`,
              { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25_000) },
            );
            if (!sqlRes.ok) {
              this.logger.warn(`/v1/sql retornou HTTP ${sqlRes.status} para heroes=${heroKey}`);
            } else {
              const sqlRows = (await sqlRes.json()) as Array<{ account_id?: number; pts?: number }>;
              if (Array.isArray(sqlRows) && sqlRows.length > 0) {
                const sqlMapped = sqlRows
                  .map((r) => ({
                    account_id: BigInt(Math.floor(Number(r.account_id ?? 0))),
                    points: Math.round(Number(r.pts ?? 0)),
                  }))
                  .filter((r) => r.account_id > 0n);

                if (isGlobal) {
                  candidates = sqlMapped;
                } else if (sqlMapped.length > 0) {
                  const sqlIds = sqlMapped.map((r) => r.account_id);
                  const regRows = await this.prisma.$queryRaw<Array<{ account_id: bigint }>>`
                    SELECT account_id FROM leaderboard_snapshot
                    WHERE region = ${region} AND account_id = ANY(${sqlIds}::bigint[])`;
                  const allowed = new Set(regRows.map((r) => r.account_id.toString()));
                  candidates = sqlMapped.filter((r) => allowed.has(r.account_id.toString()));
                }
              }
            }
          } catch (err) {
            this.logger.warn(
              `Busca global por heróis via /v1/sql indisponível: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (candidates.length === 0) {
            candidates = isGlobal
              ? await this.prisma.$queryRaw<Array<{ account_id: bigint; points: number }>>`
                  SELECT account_id, points FROM leaderboard_snapshot
                  WHERE points >= ${lo} AND points < ${hi}
                  ORDER BY points DESC, account_id ASC
                  LIMIT 100`
              : await this.prisma.$queryRaw<Array<{ account_id: bigint; points: number }>>`
                  SELECT account_id, points FROM leaderboard_snapshot
                  WHERE region = ${region} AND points >= ${lo} AND points < ${hi}
                  ORDER BY points DESC, account_id ASC
                  LIMIT 100`;
          }

          candidates = candidates.slice(0, 100);

          if (candidates.length > 0) {
            const aboveRow = validTier
              ? isGlobal
                ? await this.prisma.$queryRaw<Array<{ above: bigint }>>`
                    SELECT COUNT(*)::bigint AS above FROM leaderboard_snapshot WHERE points >= ${hi}`
                : await this.prisma.$queryRaw<Array<{ above: bigint }>>`
                    SELECT COUNT(*)::bigint AS above FROM leaderboard_snapshot WHERE region = ${region} AND points >= ${hi}`
              : [{ above: BigInt(0) }];
            const above = Number(aboveRow[0]?.above ?? 0);

            const ids = candidates.map((c) => Number(c.account_id)).filter((id) => id > 0);
            const byAccount = new Map<number, Array<{ heroId: number; matches: number }>>();
            for (let i = 0; i < ids.length; i += 100) {
              if (i > 0) await new Promise((resolve) => setTimeout(resolve, 100));
              const chunk = ids.slice(i, i + 100);
              try {
                const stats = await this.fetchJson<Array<Record<string, unknown>>>(
                  `${DEADLOCK_API_BASE}/v1/players/hero-stats?account_ids=${chunk.join(',')}`,
                  25_000,
                );
                if (Array.isArray(stats)) {
                  for (const h of stats) {
                    const aid = Number(h.account_id ?? 0);
                    const hid = Number(h.hero_id ?? 0);
                    const m = Number(h.matches_played ?? h.matches ?? 0);
                    if (aid > 0 && hid > 0 && m > 0) {
                      const arr = byAccount.get(aid) ?? [];
                      arr.push({ heroId: hid, matches: m });
                      byAccount.set(aid, arr);
                    }
                  }
                }
              } catch (err) {
                this.logger.warn(
                  `Falha em hero-stats top5 batch: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }

            const matched: ResolvedRawEntry[] = [];
            for (let idx = 0; idx < candidates.length; idx += 1) {
              const aid = Number(candidates[idx].account_id);
              const played = byAccount.get(aid);
              if (!played || played.length === 0) continue;
              played.sort((a, b) => b.matches - a.matches);
              const topN =
                validHeroIds.length === 1 ? 1 : validHeroIds.length === 2 ? 4 : 5;
              const topAllowed = played.slice(0, topN).map((x) => x.heroId);
              if (!validHeroIds.every((hid) => topAllowed.includes(hid))) continue;
              matched.push({
                rank: above + idx + 1,
                accountId: aid,
                accountName: `Jogador #${above + idx + 1}`,
                badgeLevel: null,
                rankedRank: null,
                rankedSubrank: null,
                points: Number(candidates[idx].points),
                topHeroIds: played.slice(0, 3).map((x) => x.heroId),
              });
            }

            if (matched.length > 0) {
              const rankMap = await fetchRanksBatch(matched.map((m) => m.accountId!));
              for (const entry of matched) {
                const row = entry.accountId ? rankMap.get(entry.accountId) : undefined;
                if (!row) continue;
                entry.badgeLevel = typeof row.badge === 'number' && row.badge > 0 ? row.badge : null;
                entry.rankedRank = typeof row.rank === 'number' && row.rank > 0 ? row.rank : null;
                entry.rankedSubrank =
                  typeof row.subrank === 'number' && row.subrank > 0 ? row.subrank : null;
              }
            }

            return matched;
          }
        }
        let baseList: Array<Record<string, unknown>> = [];

        if (region === 'Global') {
          const endpoints =
            validHeroIds.length > 0
              ? REGIONAL_LIST.flatMap((reg) =>
                  validHeroIds.map((hid) => `${DEADLOCK_API_BASE}/v1/leaderboard/${reg}/${hid}`),
                )
              : REGIONAL_LIST.map((reg) => `${DEADLOCK_API_BASE}/v1/leaderboard/${reg}`);
          const regionalResults = await Promise.allSettled(
            endpoints.map((ep) =>
              this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(ep),
            ),
          );
          const buckets = regionalResults
            .filter(
              (r): r is PromiseFulfilledResult<{ entries?: Array<Record<string, unknown>> }> =>
                r.status === 'fulfilled' && Array.isArray(r.value?.entries),
            )
            .map((r) => r.value.entries!.slice(0, 220));

          const seenNames = new Set<string>();
          for (let i = 0; i < 220; i += 1) {
            for (const bucket of buckets) {
              const item = bucket[i];
              if (!item) continue;
              const nameKey =
                typeof item.account_name === 'string' ? item.account_name.trim().toLowerCase() : '';
              if (nameKey && seenNames.has(nameKey)) continue;
              if (nameKey) seenNames.add(nameKey);
              baseList.push(item);
            }
          }
        } else if (validHeroIds.length > 1) {
          const heroResults = await Promise.allSettled(
            validHeroIds.map((hid) =>
              this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(
                `${DEADLOCK_API_BASE}/v1/leaderboard/${region}/${hid}`,
              ),
            ),
          );
          const buckets = heroResults
            .filter(
              (r): r is PromiseFulfilledResult<{ entries?: Array<Record<string, unknown>> }> =>
                r.status === 'fulfilled' && Array.isArray(r.value?.entries),
            )
            .map((r) => r.value.entries!.slice(0, 400));

          const seenNames = new Set<string>();
          for (let i = 0; i < 400; i += 1) {
            for (const bucket of buckets) {
              const item = bucket[i];
              if (!item) continue;
              const nameKey =
                typeof item.account_name === 'string' ? item.account_name.trim().toLowerCase() : '';
              if (nameKey && seenNames.has(nameKey)) continue;
              if (nameKey) seenNames.add(nameKey);
              baseList.push(item);
            }
          }
          baseList = baseList.slice(0, 1000);
        } else {
          const endpoint = validHeroId
            ? `${DEADLOCK_API_BASE}/v1/leaderboard/${region}/${validHeroId}`
            : `${DEADLOCK_API_BASE}/v1/leaderboard/${region}`;
          const raw = await this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(endpoint);
          const list = Array.isArray(raw?.entries) ? raw.entries : [];
          baseList = list.slice(0, 1000);
        }

        const allCandidateIds: number[] = [];
        const candidatesPerEntry = baseList.map((item) => {
          const ids = Array.isArray(item.possible_account_ids)
            ? item.possible_account_ids
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && id > 0)
                .slice(0, 20)
            : typeof item.account_id === 'number' && item.account_id > 0
              ? [item.account_id]
              : [];
          for (const id of ids) allCandidateIds.push(id);
          return ids;
        });

        const rankMap = await fetchRanksBatch(allCandidateIds);

        const resolved: ResolvedRawEntry[] = baseList.map((item, idx) => {
          const candidates = candidatesPerEntry[idx] ?? [];
          let bestId: number | null = candidates.length === 1 ? candidates[0] : null;
          let bestRow: BatchRankRow | null = bestId ? (rankMap.get(bestId) ?? null) : null;
          let bestTier = bestRow
            ? tierOfValues(bestRow.badge ?? null, bestRow.rank ?? null)
            : -1;
          let bestPts =
            typeof bestRow?.last_match?.player_rank_final_flat_progress === 'number'
              ? bestRow.last_match.player_rank_final_flat_progress
              : -1;

          for (const cid of candidates) {
            const row = rankMap.get(cid);
            if (!row) continue;
            const tier = tierOfValues(row.badge ?? null, row.rank ?? null);
            const pts =
              typeof row.last_match?.player_rank_final_flat_progress === 'number'
                ? row.last_match.player_rank_final_flat_progress
                : -1;
            if (tier > bestTier || (tier === bestTier && pts > bestPts)) {
              bestId = cid;
              bestRow = row;
              bestTier = tier;
              bestPts = pts;
            }
          }

          if (!bestId && candidates.length > 0) {
            bestId = candidates[0];
          }

          return {
            rank: Number(item.rank ?? idx + 1),
            accountId: bestId,
            accountName:
              typeof item.account_name === 'string' && item.account_name.trim()
                ? item.account_name.trim()
                : `Jogador #${idx + 1}`,
            badgeLevel: typeof bestRow?.badge === 'number' && bestRow.badge > 0 ? bestRow.badge : null,
            rankedRank: typeof bestRow?.rank === 'number' && bestRow.rank > 0 ? bestRow.rank : null,
            rankedSubrank:
              typeof bestRow?.subrank === 'number' && bestRow.subrank > 0 ? bestRow.subrank : null,
            points: bestPts >= 0 ? bestPts : null,
            topHeroIds: Array.isArray(item.top_hero_ids)
              ? item.top_hero_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
              : [],
          };
        });

        resolved.sort((a, b) => {
          const tierDiff =
            tierOfValues(b.badgeLevel, b.rankedRank) - tierOfValues(a.badgeLevel, a.rankedRank);
          if (tierDiff !== 0) return tierDiff;
          const ptsDiff = (b.points ?? -1) - (a.points ?? -1);
          return ptsDiff !== 0 ? ptsDiff : a.rank - b.rank;
        });

        return resolved.slice(0, 1000);
      },
      true,
    );

    const filteredRaw =
      !snapshot && searchQuery.length >= 2
        ? rawEntries.filter((e) =>
            e.accountName.toLowerCase().includes(searchQuery.toLowerCase()),
          )
        : rawEntries;

    const totalEntries = snapshot ? snapshot.total : filteredRaw.length;
    const totalPages = Math.max(1, Math.ceil(totalEntries / limit));
    const page = snapshot ? snapshot.page : Math.min(requestedPage, totalPages);
    const startIdx = (page - 1) * limit;
    const pageSlice: ResolvedRawEntry[] = snapshot
      ? snapshot.rows.map((row) => ({
          rank: row.rank,
          accountId: row.accountId,
          accountName: `Jogador #${row.rank}`,
          badgeLevel: null,
          rankedRank: null,
          rankedSubrank: null,
          points: row.points,
          topHeroIds: row.topHeroes.slice(0, 3),
        }))
      : filteredRaw.slice(startIdx, startIdx + limit);

    const searchKey = searchQuery ? encodeURIComponent(searchQuery.toLowerCase()) : '';
    const pageCacheKey = `leaderboard_page:v33:${snapshot ? 'snap' : 'raw'}:${region}:h${heroKey}:t${validTier ?? 0}:s${searchKey}:p${page}:l${limit}`;

    const [{ data: pageEntries, fetchedAt }, activeMap] = await Promise.all([
      this.withDbCache<NormalizedLeaderboardEntry[]>(
        pageCacheKey,
        'deadlock-api',
        1800,
        async () => {
          const entries: NormalizedLeaderboardEntry[] = pageSlice.map((item) => ({
            rank: item.rank,
            accountId: item.accountId,
            accountName: item.accountName,
            avatarUrl: null,
            badgeLevel: item.badgeLevel,
            rankedRank: item.rankedRank,
            rankedSubrank: item.rankedSubrank,
            points: item.points,
            matches: null,
            wins: null,
            losses: null,
            winRate: null,
            topHeroIds: [...item.topHeroIds],
          }));

          const allIds = Array.from(
            new Set(entries.map((e) => e.accountId).filter((id): id is number => id !== null && id > 0)),
          );

          if (allIds.length > 0) {
            const [statsRes, steamRes, rankRes] = await Promise.allSettled([
              this.fetchJson<Array<Record<string, unknown>>>(
                `${DEADLOCK_API_BASE}/v1/players/hero-stats?account_ids=${allIds.join(',')}`,
                25_000,
              ),
              this.fetchJson<Array<Record<string, unknown>>>(
                `${DEADLOCK_API_BASE}/v1/players/steam?account_ids=${allIds.join(',')}`,
              ),
              snapshot ? fetchRanksBatch(allIds) : Promise.resolve(null),
            ]);

            if (rankRes.status === 'fulfilled' && rankRes.value) {
              const rankMap = rankRes.value;
              for (const entry of entries) {
                const row = entry.accountId ? rankMap.get(entry.accountId) : undefined;
                if (!row) continue;
                entry.badgeLevel = typeof row.badge === 'number' && row.badge > 0 ? row.badge : null;
                entry.rankedRank = typeof row.rank === 'number' && row.rank > 0 ? row.rank : null;
                entry.rankedSubrank =
                  typeof row.subrank === 'number' && row.subrank > 0 ? row.subrank : null;
              }
            }

            if (statsRes.status === 'rejected') {
              this.logger.warn(
                `Falha em hero-stats batch: ${statsRes.reason instanceof Error ? statsRes.reason.message : String(statsRes.reason)}`,
              );
            }
            if (steamRes.status === 'rejected') {
              this.logger.warn(
                `Falha em steam batch: ${steamRes.reason instanceof Error ? steamRes.reason.message : String(steamRes.reason)}`,
              );
            }

            if (statsRes.status === 'fulfilled' && Array.isArray(statsRes.value)) {
              const byAccount = new Map<
                number,
                { matches: number; wins: number; heroes: Array<{ heroId: number; matches: number }> }
              >();
              for (const h of statsRes.value) {
                const aid = Number(h.account_id ?? 0);
                const hid = Number(h.hero_id ?? 0);
                const m = Number(h.matches_played ?? h.matches ?? 0);
                const w = Number(h.wins ?? 0);
                if (aid <= 0 || m <= 0) continue;
                const bucket = byAccount.get(aid) ?? { matches: 0, wins: 0, heroes: [] };
                bucket.matches += m;
                bucket.wins += w;
                if (hid > 0) bucket.heroes.push({ heroId: hid, matches: m });
                byAccount.set(aid, bucket);
              }

              for (const entry of entries) {
                if (!entry.accountId) continue;
                const agg = byAccount.get(entry.accountId);
                if (!agg || agg.matches <= 0) continue;
                entry.matches = agg.matches;
                entry.wins = agg.wins;
                entry.losses = Math.max(0, agg.matches - agg.wins);
                entry.winRate = Number(((agg.wins / agg.matches) * 100).toFixed(1));
                if (entry.topHeroIds.length < 3 && agg.heroes.length > 0) {
                  agg.heroes.sort((a, b) => b.matches - a.matches);
                  for (const ph of agg.heroes) {
                    if (!entry.topHeroIds.includes(ph.heroId)) {
                      entry.topHeroIds.push(ph.heroId);
                    }
                    if (entry.topHeroIds.length >= 3) break;
                  }
                }
              }
            }

            if (steamRes.status === 'fulfilled' && Array.isArray(steamRes.value)) {
              const avatarById = new Map<number, string>();
              const nameById = new Map<number, string>();
              for (const row of steamRes.value) {
                const aid = Number(row.account_id ?? 0);
                const av =
                  typeof row.avatarmedium === 'string'
                    ? row.avatarmedium
                    : typeof row.avatar === 'string'
                      ? row.avatar
                      : null;
                if (aid > 0 && av) avatarById.set(aid, av);
                if (aid > 0 && typeof row.personaname === 'string' && row.personaname.trim()) {
                  nameById.set(aid, row.personaname.trim());
                }
              }
              for (const entry of entries) {
                if (entry.accountId !== null) {
                  entry.avatarUrl = avatarById.get(entry.accountId) ?? null;
                  if (snapshot || validHeroIds.length > 0) {
                    entry.accountName = nameById.get(entry.accountId) ?? entry.accountName;
                  }
                }
              }
            }
          }

          return entries;
        },
        true,
      ),
      this.getActiveMatchesMap(),
    ]);

    const nowSec = Math.floor(Date.now() / 1000);
    const enriched = pageEntries.map((entry) => {
      const active = entry.accountId ? activeMap[String(entry.accountId)] : undefined;
      if (!active) return entry;
      const elapsedMin = active.startTime > 0 ? Math.max(1, Math.floor((nowSec - active.startTime) / 60)) : 1;
      return {
        ...entry,
        liveMatchId: active.matchId,
        liveHeroId: active.heroId,
        liveMinutes: elapsedMin,
      };
    });

    return {
      region,
      heroId: validHeroId,
      page,
      totalPages,
      totalEntries,
      entries: enriched,
      fetchedAt,
    };
  }

  async getPlayerbaseOverview(): Promise<PlayerbaseOverviewResponse> {
    const [{ data: daily, fetchedAt }, rankedDistribution, regionRows] = await Promise.all([
      this.withDbCache<Array<{ date: string; players: number; matches: number }>>(
        'playerbase_daily:v1',
        'deadlock-api',
        3600,
        async () => {
          const sql =
            "SELECT dateTrunc('day', start_time) AS dia, " +
            'count(DISTINCT account_id) AS jogadores, ' +
            'count(DISTINCT match_id) AS partidas ' +
            'FROM match_player_latest ' +
            'WHERE start_time > now() - INTERVAL 14 DAY ' +
            'GROUP BY dia ORDER BY dia ASC';
          const rows = await this.fetchJson<
            Array<{ dia?: string; jogadores?: number | string; partidas?: number | string }>
          >(
            `${DEADLOCK_API_BASE}/v1/sql?format=json&query=${encodeURIComponent(sql)}`,
            25_000,
          );
          if (!Array.isArray(rows)) return [];
          return rows
            .map((r) => ({
              date: typeof r.dia === 'string' ? r.dia.slice(0, 10) : '',
              players: Math.max(0, Number(r.jogadores ?? 0)),
              matches: Math.max(0, Number(r.partidas ?? 0)),
            }))
            .filter((r) => r.date.length === 10);
        },
        true,
      ),
      this.getRankDistribution('Global'),
      this.prisma.$queryRaw<Array<{ region: string | null; cnt: bigint }>>`
        SELECT COALESCE(region, 'Desconhecida') AS region, COUNT(*)::bigint AS cnt
        FROM leaderboard_snapshot
        GROUP BY COALESCE(region, 'Desconhecida')
        ORDER BY cnt DESC`.catch(() => []),
    ]);

    return {
      daily,
      rankedDistribution,
      regions: regionRows.map((r) => ({
        region: r.region || 'Desconhecida',
        players: Number(r.cnt ?? 0),
      })),
      fetchedAt,
    };
  }

  async getRankDistribution(rawRegion?: string): Promise<RankDistributionResponse> {
    const region =
      rawRegion && rawRegion !== 'Global' && ALLOWED_REGIONS.has(rawRegion)
        ? rawRegion
        : 'Global';

    if (region !== 'Global') {
      try {
        const snapRows = await this.prisma.$queryRaw<Array<{ tier: number; cnt: bigint }>>`
          SELECT
            LEAST(11, GREATEST(1, CASE WHEN points >= 65000 THEN 11 ELSE (points / 6500)::int + 1 END))::int AS tier,
            COUNT(*)::bigint AS cnt
          FROM leaderboard_snapshot
          WHERE region = ${region}
          GROUP BY 1`;

        if (snapRows.length > 0) {
          const byTier = new Map<number, number>();
          let totalPlayers = 0;
          for (const r of snapRows) {
            const count = Number(r.cnt ?? 0);
            if (r.tier >= 1 && r.tier <= 11 && count > 0) {
              byTier.set(r.tier, count);
              totalPlayers += count;
            }
          }
          const tiers: RankDistributionTier[] = [];
          for (let t = 11; t >= 1; t -= 1) {
            tiers.push({ tier: t, uniquePlayers: byTier.get(t) ?? 0 });
          }
          return { totalPlayers, tiers, fetchedAt: new Date().toISOString() };
        }
      } catch (err) {
        this.logger.warn(
          `Distribuição regional indisponível (${region}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const { data, fetchedAt } = await this.withDbCache<{
      totalPlayers: number;
      tiers: RankDistributionTier[];
    }>('rank_distribution:v2:14d', 'deadlock-api', 3600, async () => {
      const minTs = Math.floor(Date.now() / 1000) - 14 * 86400;
      const rows = await this.fetchJson<
        Array<{ badge_level?: number; unique_players?: number }>
      >(`${DEADLOCK_API_BASE}/v1/analytics/badge-distribution?min_unix_timestamp=${minTs}`);

      const byTier = new Map<number, number>();
      let totalPlayers = 0;

      if (Array.isArray(rows)) {
        for (const r of rows) {
          const level = Number(r.badge_level ?? 0);
          const count = Number(r.unique_players ?? 0);
          const tier = Math.floor(level / 10);
          if (tier >= 1 && tier <= 11 && count > 0) {
            byTier.set(tier, (byTier.get(tier) ?? 0) + count);
            totalPlayers += count;
          }
        }
      }

      const tiers: RankDistributionTier[] = [];
      for (let t = 11; t >= 1; t -= 1) {
        tiers.push({ tier: t, uniquePlayers: byTier.get(t) ?? 0 });
      }

      return { totalPlayers, tiers };
    });

    return { ...data, fetchedAt };
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