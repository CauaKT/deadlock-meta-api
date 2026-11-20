import {
  BadRequestException,
  Injectable,
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

@Injectable()
export class TournamentsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(viewerUserId?: string) {
    const rows = await this.prisma.tournament.findMany({
      include: {
        matches: {
          orderBy: [{ round: 'asc' }, { slot: 'asc' }],
        },
      },
      orderBy: [{ relevance: 'desc' }, { startsAt: 'desc' }],
    });

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
      .map((t) => ({
        id: t.id,
        title: t.title,
        region: t.region,
        prizePool: t.prizePool,
        status: t.status,
        relevance: t.relevance,
        startsAt: t.startsAt.toISOString(),
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
      }));
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