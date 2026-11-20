import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateLfgDto } from './dto/lfg.dto';

export interface LfgPostView {
  id: string;
  region: string;
  rankTier: string;
  mode: string;
  heroIds: number[];
  note: string;
  createdAt: string;
  author: {
    id: string;
    username: string;
    handle: string | null;
    avatarUrl: string | null;
  };
  canDelete: boolean;
}

@Injectable()
export class LfgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  async findAll(
    viewer?: AuthenticatedUser,
    filters?: { region?: string; rankTier?: string; mode?: string; heroId?: number },
  ): Promise<LfgPostView[]> {
    const where: Prisma.LfgPostWhereInput = {};
    if (filters?.region) where.region = filters.region;
    if (filters?.rankTier) where.rankTier = filters.rankTier;
    if (filters?.mode) where.mode = filters.mode;

    const rows = await this.prisma.lfgPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: { username: true, handle: true, avatarUrl: true },
            },
          },
        },
      },
    });

    const mapped = rows.map((r) => {
      const heroIds = Array.isArray(r.heroIds)
        ? r.heroIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      return {
        id: r.id,
        region: r.region,
        rankTier: r.rankTier,
        mode: r.mode,
        heroIds,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        author: {
          id: r.user.id,
          username: r.user.profile?.username || 'Jogador',
          handle: r.user.profile?.handle ?? null,
          avatarUrl: r.user.profile?.avatarUrl ?? null,
        },
        canDelete: Boolean(
          viewer && (viewer.userId === r.userId || viewer.role === Role.ADMIN),
        ),
      };
    });

    if (filters?.heroId && filters.heroId > 0) {
      return mapped.filter((item) => item.heroIds.includes(filters.heroId!));
    }
    return mapped;
  }

  async create(user: AuthenticatedUser, dto: CreateLfgDto): Promise<LfgPostView> {
    await this.moderation.assertSafeContent({ texts: [dto.note] });

    const created = await this.prisma.lfgPost.create({
      data: {
        userId: user.userId,
        region: dto.region,
        rankTier: dto.rankTier,
        mode: dto.mode,
        heroIds: dto.heroIds as unknown as Prisma.InputJsonValue,
        note: dto.note,
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: { username: true, handle: true, avatarUrl: true },
            },
          },
        },
      },
    });

    return {
      id: created.id,
      region: created.region,
      rankTier: created.rankTier,
      mode: created.mode,
      heroIds: dto.heroIds,
      note: created.note,
      createdAt: created.createdAt.toISOString(),
      author: {
        id: created.user.id,
        username: created.user.profile?.username || 'Jogador',
        handle: created.user.profile?.handle ?? null,
        avatarUrl: created.user.profile?.avatarUrl ?? null,
      },
      canDelete: true,
    };
  }

  async remove(id: string, user: AuthenticatedUser): Promise<{ ok: true }> {
    const existing = await this.prisma.lfgPost.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) {
      throw new NotFoundException('Anúncio LFG não encontrado.');
    }
    if (existing.userId !== user.userId && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Sem permissão para excluir este anúncio.');
    }
    await this.prisma.lfgPost.delete({ where: { id } });
    return { ok: true };
  }
}