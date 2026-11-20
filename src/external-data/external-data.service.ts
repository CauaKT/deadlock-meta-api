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

  async getLeaderboard(
    rawRegion: string,
    heroId?: number,
    rawPage = 1,
    rawLimit = 50,
  ): Promise<NormalizedLeaderboardResponse> {
    const region = ALLOWED_REGIONS.has(rawRegion) ? rawRegion : 'SAmerica';
    const validHeroId = heroId && Number.isInteger(heroId) && heroId > 0 ? heroId : null;
    const limit = Number.isFinite(rawLimit) ? Math.max(10, Math.min(50, Math.floor(rawLimit))) : 50;
    const requestedPage = Number.isFinite(rawPage) ? Math.max(1, Math.min(20, Math.floor(rawPage))) : 1;

    const rawCacheKey = validHeroId
      ? `leaderboard_raw:v2:${region}:hero:${validHeroId}`
      : `leaderboard_raw:v2:${region}`;

    const fetchRankForId = async (accountId: number) => {
      const res = await fetch(`${DEADLOCK_API_BASE}/v1/players/${accountId}/rank`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return null;
      return (await res.json()) as {
        badge?: number | null;
        rank?: number | null;
        subrank?: number | null;
        last_match?: {
          player_rank_final_flat_progress?: number | null;
        } | null;
      };
    };

    const { data: rawEntries } = await this.withDbCache<Array<Record<string, unknown>>>(
      rawCacheKey,
      'deadlock-api',
      1800,
      async () => {
        if (region === 'Global') {
          const regionalResults = await Promise.allSettled(
            REGIONAL_LIST.map((reg) => {
              const ep = validHeroId
                ? `${DEADLOCK_API_BASE}/v1/leaderboard/${reg}/${validHeroId}`
                : `${DEADLOCK_API_BASE}/v1/leaderboard/${reg}`;
              return this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(ep);
            }),
          );
          const buckets = regionalResults
            .filter(
              (r): r is PromiseFulfilledResult<{ entries?: Array<Record<string, unknown>> }> =>
                r.status === 'fulfilled' && Array.isArray(r.value?.entries),
            )
            .map((r) => r.value.entries!.slice(0, 120));

          const merged: Array<Record<string, unknown>> = [];
          const seenNames = new Set<string>();
          for (let i = 0; i < 120; i += 1) {
            for (const bucket of buckets) {
              const item = bucket[i];
              if (!item) continue;
              const nameKey =
                typeof item.account_name === 'string' ? item.account_name.trim().toLowerCase() : '';
              if (nameKey && seenNames.has(nameKey)) continue;
              if (nameKey) seenNames.add(nameKey);
              merged.push(item);
            }
          }
          return merged.slice(0, 500);
        }

        const endpoint = validHeroId
          ? `${DEADLOCK_API_BASE}/v1/leaderboard/${region}/${validHeroId}`
          : `${DEADLOCK_API_BASE}/v1/leaderboard/${region}`;
        const raw = await this.fetchJson<{ entries?: Array<Record<string, unknown>> }>(endpoint);
        const list = Array.isArray(raw?.entries) ? raw.entries : [];
        return list.slice(0, 1000);
      },
    );

    const totalEntries = rawEntries.length;
    const totalPages = Math.max(1, Math.ceil(totalEntries / limit));
    const page = Math.min(requestedPage, totalPages);
    const startIdx = (page - 1) * limit;
    const pageSlice = rawEntries.slice(startIdx, startIdx + limit);

    const pageCacheKey = `leaderboard_page:v13:${region}:h${validHeroId ?? 0}:p${page}:l${limit}`;

    const tierOf = (e: NormalizedLeaderboardEntry) => {
      if (typeof e.rankedRank === 'number' && e.rankedRank >= 1) return e.rankedRank;
      if (typeof e.badgeLevel === 'number' && e.badgeLevel >= 11) return Math.floor(e.badgeLevel / 10);
      return 0;
    };

    const [{ data: pageEntries, fetchedAt }, activeMap] = await Promise.all([
      this.withDbCache<NormalizedLeaderboardEntry[]>(
        pageCacheKey,
        'deadlock-api',
        1800,
        async () => {
          const candidatesByIndex: number[][] = [];
          const entries: NormalizedLeaderboardEntry[] = pageSlice.map((item, idx) => {
            const candidates = Array.isArray(item.possible_account_ids)
              ? item.possible_account_ids
                  .map((id) => Number(id))
                  .filter((id) => Number.isFinite(id) && id > 0)
                  .slice(0, 4)
              : typeof item.account_id === 'number' && item.account_id > 0
                ? [item.account_id]
                : [];
            candidatesByIndex.push(candidates);

            return {
              rank: Number(item.rank ?? startIdx + idx + 1),
              accountId: null,
              accountName:
                typeof item.account_name === 'string' && item.account_name.trim()
                  ? item.account_name.trim()
                  : `Jogador #${startIdx + idx + 1}`,
              avatarUrl: null,
              badgeLevel: typeof item.badge_level === 'number' ? item.badge_level : null,
              rankedRank: typeof item.ranked_rank === 'number' ? item.ranked_rank : null,
              rankedSubrank: typeof item.ranked_subrank === 'number' ? item.ranked_subrank : null,
              points: null,
              matches: null,
              wins: null,
              losses: null,
              winRate: null,
              topHeroIds: Array.isArray(item.top_hero_ids)
                ? item.top_hero_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
                : [],
            };
          });

          const targets = entries
            .map((entry, idx) => ({ entry, candidates: candidatesByIndex[idx] ?? [] }))
            .filter((t) => t.candidates.length > 0);

          for (let i = 0; i < targets.length; i += 5) {
            if (i > 0) {
              await new Promise((resolve) => setTimeout(resolve, 180));
            }
            const chunk = targets.slice(i, i + 5);
            await Promise.allSettled(
              chunk.map(async ({ entry, candidates }) => {
                let chosenId: number | null = null;
                let chosenRank: Awaited<ReturnType<typeof fetchRankForId>> = null;
                let chosenPoints = -1;

                if (candidates.length === 1) {
                  chosenId = candidates[0];
                  chosenRank = await fetchRankForId(chosenId).catch(() => null);
                  chosenPoints =
                    typeof chosenRank?.last_match?.player_rank_final_flat_progress === 'number'
                      ? chosenRank.last_match.player_rank_final_flat_progress
                      : -1;
                } else {
                  const firstId = candidates[0];
                  const firstRk = await fetchRankForId(firstId).catch(() => null);
                  const firstPts =
                    typeof firstRk?.last_match?.player_rank_final_flat_progress === 'number'
                      ? firstRk.last_match.player_rank_final_flat_progress
                      : -1;
                  const firstTier = typeof firstRk?.rank === 'number' ? firstRk.rank : 0;

                  if (firstTier >= 10 || firstPts >= 55000) {
                    chosenId = firstId;
                    chosenRank = firstRk;
                    chosenPoints = firstPts;
                  } else {
                    const others = await Promise.allSettled(
                      candidates.slice(1).map(async (cid) => ({
                        cid,
                        rk: await fetchRankForId(cid),
                      })),
                    );
                    let bestId = firstId;
                    let bestRk = firstRk;
                    let bestPts = firstPts;
                    let bestTier = firstTier;

                    for (const o of others) {
                      if (o.status !== 'fulfilled' || !o.value.rk) continue;
                      const pts =
                        typeof o.value.rk.last_match?.player_rank_final_flat_progress === 'number'
                          ? o.value.rk.last_match.player_rank_final_flat_progress
                          : -1;
                      const tier = typeof o.value.rk.rank === 'number' ? o.value.rk.rank : 0;
                      if (pts > bestPts || (pts === bestPts && tier > bestTier)) {
                        bestId = o.value.cid;
                        bestRk = o.value.rk;
                        bestPts = pts;
                        bestTier = tier;
                      }
                    }

                    const minTier = startIdx < 50 ? 10 : 7;
                    const minPts = startIdx < 50 ? 55000 : 38000;
                    if (bestTier >= minTier || bestPts >= minPts) {
                      chosenId = bestId;
                      chosenRank = bestRk;
                      chosenPoints = bestPts;
                    }
                  }
                }

                if (!chosenId) return;

                entry.accountId = chosenId;
                if (chosenRank) {
                  if (typeof chosenRank.badge === 'number') entry.badgeLevel = chosenRank.badge;
                  if (typeof chosenRank.rank === 'number') entry.rankedRank = chosenRank.rank;
                  if (typeof chosenRank.subrank === 'number') entry.rankedSubrank = chosenRank.subrank;
                  if (chosenPoints >= 0) entry.points = chosenPoints;
                }

                let statsRes = await fetch(
                  `${DEADLOCK_API_BASE}/v1/players/${chosenId}/hero-stats`,
                  { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500) },
                ).catch(() => null);
                if (statsRes && statsRes.status === 429) {
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  statsRes = await fetch(
                    `${DEADLOCK_API_BASE}/v1/players/${chosenId}/hero-stats`,
                    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4500) },
                  ).catch(() => null);
                }

                if (statsRes && statsRes.ok) {
                  const heroRows = (await statsRes.json()) as Array<Record<string, unknown>>;
                  if (Array.isArray(heroRows)) {
                    let totalMatches = 0;
                    let totalWins = 0;
                    const playedHeroes: Array<{ heroId: number; matches: number }> = [];

                    for (const h of heroRows) {
                      const hid = Number(h.hero_id ?? 0);
                      const m = Number(h.matches_played ?? h.matches ?? 0);
                      const w = Number(h.wins ?? 0);
                      if (m > 0) {
                        totalMatches += m;
                        totalWins += w;
                        if (hid > 0) playedHeroes.push({ heroId: hid, matches: m });
                      }
                    }
                    if (totalMatches > 0) {
                      entry.matches = totalMatches;
                      entry.wins = totalWins;
                      entry.losses = Math.max(0, totalMatches - totalWins);
                      entry.winRate = Number(((totalWins / totalMatches) * 100).toFixed(1));
                    }

                    if (entry.topHeroIds.length < 3 && playedHeroes.length > 0) {
                      playedHeroes.sort((a, b) => b.matches - a.matches);
                      for (const ph of playedHeroes) {
                        if (!entry.topHeroIds.includes(ph.heroId)) {
                          entry.topHeroIds.push(ph.heroId);
                        }
                        if (entry.topHeroIds.length >= 3) break;
                      }
                    }
                  }
                }
              }),
            );
          }

          const allIds = Array.from(
            new Set(entries.map((e) => e.accountId).filter((id): id is number => id !== null && id > 0)),
          );
          if (allIds.length > 0) {
            try {
              await new Promise((resolve) => setTimeout(resolve, 250));
              const steamRows = await this.fetchJson<Array<Record<string, unknown>>>(
                `${DEADLOCK_API_BASE}/v1/players/steam?account_ids=${allIds.join(',')}`,
              );
              if (Array.isArray(steamRows)) {
                const avatarById = new Map<number, string>();
                for (const row of steamRows) {
                  const aid = Number(row.account_id ?? 0);
                  const av =
                    typeof row.avatarmedium === 'string'
                      ? row.avatarmedium
                      : typeof row.avatar === 'string'
                        ? row.avatar
                        : null;
                  if (aid > 0 && av) avatarById.set(aid, av);
                }
                for (const entry of entries) {
                  if (entry.accountId !== null) {
                    entry.avatarUrl = avatarById.get(entry.accountId) ?? null;
                  }
                }
              }
            } catch {
              // Ignora falha pontual de avatar Steam
            }
          }

          entries.sort((a, b) => {
            const tierDiff = tierOf(b) - tierOf(a);
            if (tierDiff !== 0) return tierDiff;
            const ptsDiff = (b.points ?? -1) - (a.points ?? -1);
            return ptsDiff !== 0 ? ptsDiff : a.rank - b.rank;
          });

          return entries;
        },
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

  async getRankDistribution(): Promise<RankDistributionResponse> {
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