import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TournamentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateTournamentDto,
  UpdateMatchResultDto,
} from './dto/tournaments.dto';

const STATUS_WEIGHT: Record<TournamentStatus, number> = {
  ONGOING: 0,
  UPCOMING: 1,
  FINISHED: 2,
};

const LIQUIPEDIA_CACHE_KEY = 'liquipedia:deadlock:tournaments:v3';
const LIQUIPEDIA_CACHE_TTL_MS = 60 * 60 * 1000;
const LIQUIPEDIA_DETAIL_TTL_MS = 30 * 60 * 1000;

interface ParsedLiquipediaTournament {
  title: string;
  slug: string | null;
  logoUrl: string | null;
  region: string;
  prizePool: string | null;
  status: TournamentStatus;
  relevance: number;
  startsAt: Date;
  teams: string[];
  winner: string | null;
  runnerUp: string | null;
}

@Injectable()
export class TournamentsService {
  private readonly logger = new Logger(TournamentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private decodeHtml(raw: string): string {
    return raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private parseLiquipediaDate(raw: string): Date {
    const clean = raw.replace(/\s+/g, ' ').trim();
    const yearMatch = clean.match(/\b(20\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : String(new Date().getUTCFullYear());
    const startMatch = clean.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/);
    if (startMatch) {
      const parsed = new Date(`${startMatch[1]} ${startMatch[2]}, ${year} 12:00:00 UTC`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const fallback = new Date(clean);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
  }

  private parseRelevance(tierText: string): number {
    if (/S-Tier/i.test(tierText)) return 100;
    if (/A-Tier/i.test(tierText)) return 80;
    if (/B-Tier/i.test(tierText)) return 60;
    if (/C-Tier/i.test(tierText)) return 40;
    if (/D-Tier/i.test(tierText)) return 20;
    return 10;
  }

  private parseLiquipediaHtml(html: string): ParsedLiquipediaTournament[] {
    const startIdx = html.indexOf('id="Upcoming_and_Most_Recent_Tournaments"');
    const slice = startIdx >= 0 ? html.slice(startIdx) : html;
    const rowRegex = /<tr class="table2(?:__|&#95;&#95;)row--body">([\s\S]*?)<\/tr>/gi;

    const results: ParsedLiquipediaTournament[] = [];
    const seenTitles = new Set<string>();
    const nowMs = Date.now();

    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(slice)) !== null) {
      const rowHtml = match[1];
      const cells: string[] = [];
      const tdRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
      let tdMatch: RegExpExecArray | null;
      while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
        cells.push(tdMatch[1]);
      }
      if (cells.length < 9) continue;

      const tierText = this.decodeHtml(cells[0]);
      const title = this.decodeHtml(cells[2]);
      if (!title) continue;

      const slugMatch = cells[2].match(/href="\/deadlock\/([^"#]+)"/i);
      const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;
      const imgMatch = cells[1].match(/src="(\/commons\/images\/[^"]+)"/i);
      const logoUrl = imgMatch ? `https://liquipedia.net${imgMatch[1]}` : null;

      const key = title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);

      const dateText = this.decodeHtml(cells[3]);
      const startsAt = this.parseLiquipediaDate(dateText);
      const rawPrize = this.decodeHtml(cells[4]);
      const prizePool = rawPrize && rawPrize !== '-' && rawPrize !== 'TBD' ? rawPrize : null;
      const region = this.decodeHtml(cells[5]) || 'Global';
      const rawWinner = this.decodeHtml(cells[7]);
      const rawRunnerUp = this.decodeHtml(cells[8]);

      const winner = rawWinner && rawWinner !== 'TBD' && rawWinner !== '-' ? rawWinner : null;
      const runnerUp = rawRunnerUp && rawRunnerUp !== 'TBD' && rawRunnerUp !== '-' ? rawRunnerUp : null;

      const status: TournamentStatus = winner
        ? TournamentStatus.FINISHED
        : startsAt.getTime() <= nowMs
          ? TournamentStatus.ONGOING
          : TournamentStatus.UPCOMING;

      const teams = [winner, runnerUp].filter((v): v is string => Boolean(v));

      results.push({
        title,
        slug,
        logoUrl,
        region,
        prizePool,
        status,
        relevance: this.parseRelevance(tierText),
        startsAt,
        teams,
        winner,
        runnerUp,
      });

      if (results.length >= 25) break;
    }

    return results;
  }

  private async syncFromLiquipediaIfStale(): Promise<void> {
    try {
      const cached = await this.prisma.externalCache.findUnique({
        where: { key: LIQUIPEDIA_CACHE_KEY },
        select: { expiresAt: true },
      });
      if (cached && cached.expiresAt.getTime() > Date.now()) {
        return;
      }

      const res = await fetch(
        'https://liquipedia.net/deadlock/api.php?action=parse&page=Portal:Tournaments&prop=text&format=json',
        {
          headers: { 'User-Agent': 'LockPro/1.0 (https://lockpro.vercel.app)' },
          signal: AbortSignal.timeout(4000),
        },
      );
      if (!res.ok) return;

      const json = (await res.json()) as { parse?: { text?: { '*'?: string } } };
      const html = json.parse?.text?.['*'];
      if (!html) return;

      const parsed = this.parseLiquipediaHtml(html);
      if (parsed.length === 0) return;

      const existing = await this.prisma.tournament.findMany({
        select: { id: true, title: true, teams: true },
      });
      const existingByTitle = new Map(existing.map((t) => [t.title.toLowerCase(), t]));

      for (const item of parsed) {
        const current = existingByTitle.get(item.title.toLowerCase());
        if (!current) {
          await this.prisma.tournament.create({
            data: {
              title: item.title,
              region: item.region,
              prizePool: item.prizePool,
              status: item.status,
              relevance: item.relevance,
              startsAt: item.startsAt,
              teams: item.teams as unknown as Prisma.InputJsonValue,
              matches:
                item.winner && item.runnerUp
                  ? {
                      create: [
                        {
                          round: 1,
                          slot: 1,
                          teamA: item.winner,
                          teamB: item.runnerUp,
                          winner: item.winner,
                        },
                      ],
                    }
                  : undefined,
            },
          });
        } else {
          await this.prisma.tournament.update({
            where: { id: current.id },
            data: {
              region: item.region,
              prizePool: item.prizePool,
              status: item.status,
              relevance: item.relevance,
              startsAt: item.startsAt,
              ...(item.teams.length > 0
                ? { teams: item.teams as unknown as Prisma.InputJsonValue }
                : {}),
            },
          });
        }
      }

      const slugs: Record<string, string> = {};
      const logos: Record<string, string> = {};
      for (const item of parsed) {
        const key = item.title.toLowerCase();
        if (item.slug) slugs[key] = item.slug;
        if (item.logoUrl) logos[key] = item.logoUrl;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + LIQUIPEDIA_CACHE_TTL_MS);
      await this.prisma.externalCache.upsert({
        where: { key: LIQUIPEDIA_CACHE_KEY },
        create: {
          key: LIQUIPEDIA_CACHE_KEY,
          source: 'liquipedia',
          payload: { count: parsed.length, slugs, logos } as Prisma.InputJsonValue,
          fetchedAt: now,
          expiresAt,
        },
        update: {
          payload: { count: parsed.length, slugs, logos } as Prisma.InputJsonValue,
          fetchedAt: now,
          expiresAt,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Falha ao sincronizar torneios da Liquipedia: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parseDetailMatches(
    html: string,
    isFinished: boolean,
  ): Array<{
    round: number;
    slot: number;
    teamA: string;
    teamB: string;
    scoreA: number;
    scoreB: number;
    winner: string | null;
  }> {
    const roundChunks = html.split(/<div class="brkts-round-body"[^>]*>/i).slice(1);
    const chunks = roundChunks.length > 0 ? roundChunks : [html];
    const matches: Array<{
      round: number;
      slot: number;
      teamA: string;
      teamB: string;
      scoreA: number;
      scoreB: number;
      winner: string | null;
    }> = [];

    for (let rIdx = 0; rIdx < chunks.length; rIdx += 1) {
      const round = rIdx + 1;
      const matchBlocks = chunks[rIdx].split(/<div class="brkts-match\b/i).slice(1);
      let slot = 1;

      for (const block of matchBlocks) {
        const entryBlocks = block.split(/<div class="brkts-opponent-entry\b/i).slice(1, 3);
        if (entryBlocks.length < 2) continue;

        const sides = entryBlocks.map((entryHtml) => {
          const ariaMatch = entryHtml.match(/aria-label="([^"]+)"/i);
          const teamNameMatch = entryHtml.match(/<div class="team-name">([\s\S]*?)<\/div>/i);
          const rawName = ariaMatch?.[1] ?? teamNameMatch?.[1] ?? '';
          const name = this.decodeHtml(rawName) || 'TBD';
          const scoreMatch = entryHtml.match(/<div class="brkts-opponent-score-inner">([\s\S]*?)<\/div>/i);
          const scoreText = scoreMatch ? this.decodeHtml(scoreMatch[1]) : '';
          const score = /^\d+$/.test(scoreText) ? Number(scoreText) : 0;
          const winClass = /brkts-opponent-win/i.test(entryHtml);
          return { name, score, winClass };
        });

        if (sides[0].name === 'TBD' && sides[1].name === 'TBD') continue;

        let winner: string | null = null;
        if (sides[0].winClass && sides[0].name !== 'TBD') winner = sides[0].name;
        else if (sides[1].winClass && sides[1].name !== 'TBD') winner = sides[1].name;
        else if (isFinished && sides[0].score !== sides[1].score) {
          winner = sides[0].score > sides[1].score ? sides[0].name : sides[1].name;
        }

        matches.push({
          round,
          slot: slot++,
          teamA: sides[0].name,
          teamB: sides[1].name,
          scoreA: sides[0].score,
          scoreB: sides[1].score,
          winner,
        });
        if (matches.length >= 32) break;
      }
      if (matches.length >= 32) break;
    }

    return matches;
  }

  private parseDetailTeams(
    html: string,
    matches: Array<{ teamA: string; teamB: string }>,
  ): string[] {
    const teams: string[] = [];
    const seen = new Set<string>();
    const addTeam = (raw: string) => {
      const name = this.decodeHtml(raw);
      if (!name || /^(TBD|BYE|-)$/i.test(name)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      teams.push(name);
    };

    const cardRegex = /<div class="teamcard[^"]*">[\s\S]*?<center><b>([\s\S]*?)<\/b><\/center>/gi;
    let m: RegExpExecArray | null;
    while ((m = cardRegex.exec(html)) !== null) {
      addTeam(m[1]);
    }

    const oppRegex = /<div class="brkts-opponent-entry\b[^>]*aria-label="([^"]+)"/gi;
    while ((m = oppRegex.exec(html)) !== null) {
      addTeam(m[1]);
    }

    for (const mt of matches) {
      addTeam(mt.teamA);
      addTeam(mt.teamB);
    }

    return teams;
  }

  async getDetail(id: string, viewerUserId?: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
      include: { matches: { orderBy: [{ round: 'asc' }, { slot: 'asc' }] } },
    });
    if (!tournament) {
      throw new NotFoundException('Torneio não encontrado.');
    }

    const detailKey = `liquipedia:deadlock:tournament:v2:${id}`;
    const detailCache = await this.prisma.externalCache.findUnique({
      where: { key: detailKey },
      select: { expiresAt: true },
    });

    if (!detailCache || detailCache.expiresAt.getTime() <= Date.now()) {
      try {
        let listCache = await this.prisma.externalCache.findUnique({
          where: { key: LIQUIPEDIA_CACHE_KEY },
          select: { payload: true },
        });
        if (!listCache) {
          await this.syncFromLiquipediaIfStale();
          listCache = await this.prisma.externalCache.findUnique({
            where: { key: LIQUIPEDIA_CACHE_KEY },
            select: { payload: true },
          });
        }
        const slugs = ((listCache?.payload as { slugs?: Record<string, string> } | null)?.slugs ??
          {}) as Record<string, string>;
        const slug = slugs[tournament.title.toLowerCase()];

        if (slug) {
          const res = await fetch(
            `https://liquipedia.net/deadlock/api.php?action=parse&page=${encodeURIComponent(slug)}&redirects=1&prop=text&format=json`,
            {
              headers: { 'User-Agent': 'LockPro/1.0 (https://lockpro.vercel.app)' },
              signal: AbortSignal.timeout(5000),
            },
          );
          if (res.ok) {
            const json = (await res.json()) as { parse?: { text?: { '*'?: string } } };
            const html = json.parse?.text?.['*'];
            if (html) {
              const parsedMatches = this.parseDetailMatches(
                html,
                tournament.status === TournamentStatus.FINISHED,
              );
              const parsedTeams = this.parseDetailTeams(html, parsedMatches);

              if (parsedTeams.length > 0) {
                await this.prisma.tournament.update({
                  where: { id },
                  data: { teams: parsedTeams as unknown as Prisma.InputJsonValue },
                });
              }

              if (parsedMatches.length > 0 && tournament.matches.length === 0) {
                await this.prisma.tournamentMatch.createMany({
                  data: parsedMatches.map((m) => ({
                    tournamentId: id,
                    round: m.round,
                    slot: m.slot,
                    teamA: m.teamA,
                    teamB: m.teamB,
                    scoreA: m.scoreA,
                    scoreB: m.scoreB,
                    winner: m.winner,
                  })),
                });
              }
            }
          }
        }

        const now = new Date();
        await this.prisma.externalCache.upsert({
          where: { key: detailKey },
          create: {
            key: detailKey,
            source: 'liquipedia',
            payload: { synced: true } as Prisma.InputJsonValue,
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + LIQUIPEDIA_DETAIL_TTL_MS),
          },
          update: {
            payload: { synced: true } as Prisma.InputJsonValue,
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + LIQUIPEDIA_DETAIL_TTL_MS),
          },
        });
      } catch (err) {
        this.logger.warn(
          `Falha ao sincronizar detalhes do torneio ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const updated = await this.prisma.tournament.findUnique({
      where: { id },
      include: { matches: { orderBy: [{ round: 'asc' }, { slot: 'asc' }] } },
    });
    if (!updated) throw new NotFoundException('Torneio não encontrado.');

    let viewerPicks = new Map<string, string>();
    if (viewerUserId) {
      const picks = await this.prisma.tournamentPick.findMany({
        where: { userId: viewerUserId, match: { tournamentId: id } },
        select: { matchId: true, pickedTeam: true },
      });
      viewerPicks = new Map(picks.map((p) => [p.matchId, p.pickedTeam]));
    }

    const metaCache = await this.prisma.externalCache.findUnique({
      where: { key: LIQUIPEDIA_CACHE_KEY },
      select: { payload: true },
    });
    const metaPayload = (metaCache?.payload ?? {}) as {
      slugs?: Record<string, string>;
      logos?: Record<string, string>;
    };
    const titleKey = updated.title.toLowerCase();
    const detailSlug = metaPayload.slugs?.[titleKey];

    return {
      id: updated.id,
      title: updated.title,
      region: updated.region,
      prizePool: updated.prizePool,
      status: updated.status,
      relevance: updated.relevance,
      startsAt: updated.startsAt.toISOString(),
      logoUrl: metaPayload.logos?.[titleKey] ?? null,
      liquipediaUrl: detailSlug ? `https://liquipedia.net/deadlock/${detailSlug}` : null,
      teams: Array.isArray(updated.teams) ? (updated.teams as string[]) : [],
      matches: updated.matches.map((m) => ({
        id: m.id,
        round: m.round,
        slot: m.slot,
        teamA: m.teamA,
        teamB: m.teamB,
        scoreA: m.scoreA,
        scoreB: m.scoreB,
        winner: m.winner,
        myPick: viewerPicks.get(m.id) ?? null,
      })),
    };
  }

  async listAll(viewerUserId?: string) {
    await this.syncFromLiquipediaIfStale();

    const [rows, metaCache] = await Promise.all([
      this.prisma.tournament.findMany({
        include: {
          matches: {
            orderBy: [{ round: 'asc' }, { slot: 'asc' }],
          },
        },
        orderBy: [{ relevance: 'desc' }, { startsAt: 'desc' }],
      }),
      this.prisma.externalCache.findUnique({
        where: { key: LIQUIPEDIA_CACHE_KEY },
        select: { payload: true },
      }),
    ]);

    const metaPayload = (metaCache?.payload ?? {}) as {
      slugs?: Record<string, string>;
      logos?: Record<string, string>;
    };

    let viewerPicks = new Map<string, string>();
    if (viewerUserId) {
      const picks = await this.prisma.tournamentPick.findMany({
        where: { userId: viewerUserId },
        select: { matchId: true, pickedTeam: true },
      });
      viewerPicks = new Map(picks.map((p) => [p.matchId, p.pickedTeam]));
    }

    return rows
      .sort((a, b) => {
        const diff = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status];
        if (diff !== 0) return diff;
        if (b.relevance !== a.relevance) return b.relevance - a.relevance;
        return b.startsAt.getTime() - a.startsAt.getTime();
      })
      .map((t) => {
        const titleKey = t.title.toLowerCase();
        const slug = metaPayload.slugs?.[titleKey];
        return {
          id: t.id,
          title: t.title,
          region: t.region,
          prizePool: t.prizePool,
          status: t.status,
          relevance: t.relevance,
          startsAt: t.startsAt.toISOString(),
          logoUrl: metaPayload.logos?.[titleKey] ?? null,
          liquipediaUrl: slug ? `https://liquipedia.net/deadlock/${slug}` : null,
          teams: Array.isArray(t.teams) ? (t.teams as string[]) : [],
          matches: t.matches.map((m) => ({
            id: m.id,
            round: m.round,
            slot: m.slot,
            teamA: m.teamA,
            teamB: m.teamB,
            scoreA: m.scoreA,
            scoreB: m.scoreB,
            winner: m.winner,
            myPick: viewerPicks.get(m.id) ?? null,
          })),
        };
      });
  }

  async getPickemLeaderboard() {
    const picks = await this.prisma.tournamentPick.findMany({
      include: {
        match: { select: { winner: true } },
        user: {
          select: {
            id: true,
            profile: { select: { username: true, handle: true, avatarUrl: true } },
          },
        },
      },
    });

    const board = new Map<
      string,
      {
        userId: string;
        username: string;
        handle: string | null;
        avatarUrl: string | null;
        points: number;
        correct: number;
        total: number;
      }
    >();

    for (const p of picks) {
      const entry = board.get(p.userId) ?? {
        userId: p.userId,
        username: p.user.profile?.username || 'Jogador',
        handle: p.user.profile?.handle ?? null,
        avatarUrl: p.user.profile?.avatarUrl ?? null,
        points: 0,
        correct: 0,
        total: 0,
      };
      if (p.match.winner) {
        entry.total += 1;
        if (p.match.winner === p.pickedTeam) {
          entry.correct += 1;
          entry.points += 10;
        }
      }
      board.set(p.userId, entry);
    }

    return Array.from(board.values())
      .sort((a, b) => b.points - a.points || b.correct - a.correct)
      .slice(0, 20);
  }

  async placePick(userId: string, matchId: string, pickedTeam: string) {
    const match = await this.prisma.tournamentMatch.findUnique({
      where: { id: matchId },
    });
    if (!match) {
      throw new NotFoundException('Partida não encontrada.');
    }
    if (match.winner) {
      throw new BadRequestException('Esta partida já foi encerrada.');
    }
    if (pickedTeam !== match.teamA && pickedTeam !== match.teamB) {
      throw new BadRequestException('Time escolhido inválido.');
    }

    const pick = await this.prisma.tournamentPick.upsert({
      where: { matchId_userId: { matchId, userId } },
      create: { matchId, userId, pickedTeam },
      update: { pickedTeam },
    });

    return { matchId: pick.matchId, pickedTeam: pick.pickedTeam };
  }

  async createTournament(dto: CreateTournamentDto) {
    const created = await this.prisma.tournament.create({
      data: {
        title: dto.title,
        region: dto.region,
        prizePool: dto.prizePool ?? null,
        status: dto.status,
        relevance: dto.relevance ?? 0,
        startsAt: new Date(dto.startsAt),
        teams: dto.teams as unknown as Prisma.InputJsonValue,
        matches: {
          create: dto.matches.map((m) => ({
            round: m.round,
            slot: m.slot,
            teamA: m.teamA,
            teamB: m.teamB,
          })),
        },
      },
      include: {
        matches: { orderBy: [{ round: 'asc' }, { slot: 'asc' }] },
      },
    });

    return created;
  }

  async updateMatchResult(matchId: string, dto: UpdateMatchResultDto) {
    const match = await this.prisma.tournamentMatch.findUnique({
      where: { id: matchId },
    });
    if (!match) {
      throw new NotFoundException('Partida não encontrada.');
    }
    if (dto.winner && dto.winner !== match.teamA && dto.winner !== match.teamB) {
      throw new BadRequestException('O vencedor deve ser um dos dois times da partida.');
    }

    return this.prisma.tournamentMatch.update({
      where: { id: matchId },
      data: {
        scoreA: dto.scoreA,
        scoreB: dto.scoreB,
        winner: dto.winner ?? null,
      },
    });
  }

  async deleteTournament(id: string) {
    await this.prisma.tournament.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Torneio não encontrado.');
    });
    return { ok: true };
  }
}