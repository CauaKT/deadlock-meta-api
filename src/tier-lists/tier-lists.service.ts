import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTierListDto, TierRowDto, UpdateTierListDto } from './dto/tier-lists.dto';

export interface TierRowView {
  label: string;
  color: string;
  heroes: number[];
}

export interface TierListView {
  id: string;
  title: string;
  author: string;
  authorHandle: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  tiers: TierRowView[];
  canEdit: boolean;
  canDelete: boolean;
}

type TierListWithAuthor = Prisma.TierListGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        profile: {
          select: {
            username: true;
            handle: true;
          };
        };
      };
    };
  };
}>;

function parseTiersJson(raw: Prisma.JsonValue): TierRowView[] {
  if (!Array.isArray(raw)) return [];
  const rows: TierRowView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? rec.label : '';
    const color = typeof rec.color === 'string' ? rec.color : '#64748b';
    const heroes = Array.isArray(rec.heroes)
      ? rec.heroes.filter((h): h is number => typeof h === 'number' && Number.isInteger(h) && h > 0)
      : [];
    rows.push({ label, color, heroes });
  }
  return rows;
}

function sanitizeTiersInput(tiers: TierRowDto[]): Prisma.InputJsonValue {
  const seenHeroes = new Set<number>();
  return tiers.map((t) => {
    const uniqueHeroes: number[] = [];
    for (const h of t.heroes) {
      if (!seenHeroes.has(h)) {
        seenHeroes.add(h);
        uniqueHeroes.push(h);
      }
    }
    return {
      label: t.label,
      color: t.color,
      heroes: uniqueHeroes,
    };
  });
}

@Injectable()
export class TierListsService {
  constructor(private readonly prisma: PrismaService) {}

  private toView(row: TierListWithAuthor, viewer?: AuthenticatedUser): TierListView {
    const isOwner = Boolean(viewer && row.userId && row.userId === viewer.userId);
    const isAdmin = viewer?.role === Role.ADMIN;

    return {
      id: row.id,
      title: row.title,
      author: row.user?.profile?.username || row.authorName || 'Anônimo',
      authorHandle: row.user?.profile?.handle ?? null,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      tiers: parseTiersJson(row.tiers),
      canEdit: isOwner,
      canDelete: isOwner || isAdmin,
    };
  }

  async findAll(
    viewer?: AuthenticatedUser,
    userId?: string,
    handle?: string,
  ): Promise<TierListView[]> {
    const cleanUserId = userId?.trim();
    const cleanHandle = handle?.trim().replace(/^@+/, '');

    let where: Prisma.TierListWhereInput | undefined;
    if (cleanUserId) {
      where = { userId: cleanUserId };
    } else if (cleanHandle) {
      where = {
        user: {
          profile: {
            handle: { equals: cleanHandle, mode: 'insensitive' },
          },
        },
      };
    }

    const rows = await this.prisma.tierList.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
              },
            },
          },
        },
      },
    });

    return rows.map((row) => this.toView(row, viewer));
  }

  async findOne(id: string, viewer?: AuthenticatedUser): Promise<TierListView> {
    const row = await this.prisma.tierList.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
              },
            },
          },
        },
      },
    });

    if (!row) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    return this.toView(row, viewer);
  }

  async create(user: AuthenticatedUser, dto: CreateTierListDto): Promise<TierListView> {
    const profile = await this.prisma.profile.findUnique({
      where: { userId: user.userId },
      select: { username: true },
    });

    const authorName =
      profile?.username?.trim() ||
      dto.authorName?.trim() ||
      user.email.split('@')[0] ||
      'Anônimo';

    const created = await this.prisma.tierList.create({
      data: {
        userId: user.userId,
        title: dto.title,
        authorName,
        tiers: sanitizeTiersInput(dto.tiers),
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
              },
            },
          },
        },
      },
    });

    return this.toView(created, user);
  }

  async update(
    id: string,
    user: AuthenticatedUser,
    dto: UpdateTierListDto,
  ): Promise<TierListView> {
    const existing = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!existing) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    if (!existing.userId || existing.userId !== user.userId) {
      throw new ForbiddenException('Apenas o criador pode editar esta tier list.');
    }

    const updated = await this.prisma.tierList.update({
      where: { id },
      data: {
        title: dto.title,
        ...(dto.authorName ? { authorName: dto.authorName } : {}),
        tiers: sanitizeTiersInput(dto.tiers),
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
              },
            },
          },
        },
      },
    });

    return this.toView(updated, user);
  }

  async remove(id: string, user: AuthenticatedUser): Promise<{ ok: true }> {
    const existing = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!existing) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    const isOwner = Boolean(existing.userId && existing.userId === user.userId);
    const isAdmin = user.role === Role.ADMIN;

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Você não tem permissão para excluir esta tier list.');
    }

    await this.prisma.tierList.delete({ where: { id } });
    return { ok: true };
  }
}