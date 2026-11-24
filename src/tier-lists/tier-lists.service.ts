import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateTierListDto,
  TierQuadrantDto,
  TierRowDto,
  UpdateTierListDto,
} from './dto/tier-lists.dto';

export interface TierRowView {
  label: string;
  color: string;
  heroes: number[];
}

export interface TierQuadrantItemView {
  heroId: number;
  x: number;
  y: number;
}

export interface TierQuadrantView {
  topLabel: string;
  bottomLabel: string;
  leftLabel: string;
  rightLabel: string;
  items: TierQuadrantItemView[];
}

export interface TierListView {
  id: string;
  title: string;
  author: string;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  style: 'classic' | 'quadrant';
  tiers: TierRowView[];
  quadrant: TierQuadrantView | null;
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
            avatarUrl: true;
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

const clampCoord = (v: number) =>
  Math.round(Math.min(100, Math.max(0, v)) * 100) / 100;

function parseQuadrantJson(raw: Prisma.JsonValue | null | undefined): TierQuadrantView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const topLabel = typeof rec.topLabel === 'string' && rec.topLabel.trim() ? rec.topLabel : 'Difícil de dominar';
  const bottomLabel = typeof rec.bottomLabel === 'string' && rec.bottomLabel.trim() ? rec.bottomLabel : 'Fácil de dominar';
  const leftLabel = typeof rec.leftLabel === 'string' && rec.leftLabel.trim() ? rec.leftLabel : 'Fácil de aprender';
  const rightLabel = typeof rec.rightLabel === 'string' && rec.rightLabel.trim() ? rec.rightLabel : 'Difícil de aprender';
  const rawItems = Array.isArray(rec.items) ? rec.items : [];
  const items: TierQuadrantItemView[] = [];
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.heroId === 'number' &&
      Number.isInteger(item.heroId) &&
      item.heroId > 0 &&
      typeof item.x === 'number' &&
      Number.isFinite(item.x) &&
      typeof item.y === 'number' &&
      Number.isFinite(item.y)
    ) {
      items.push({
        heroId: item.heroId,
        x: clampCoord(item.x),
        y: clampCoord(item.y),
      });
    }
  }
  return { topLabel, bottomLabel, leftLabel, rightLabel, items };
}

function sanitizeQuadrantInput(quadrant: TierQuadrantDto): Prisma.InputJsonValue {
  const unique = new Map<number, TierQuadrantItemView>();
  for (const item of quadrant.items) {
    unique.delete(item.heroId);
    unique.set(item.heroId, {
      heroId: item.heroId,
      x: clampCoord(item.x),
      y: clampCoord(item.y),
    });
  }
  return {
    topLabel: quadrant.topLabel,
    bottomLabel: quadrant.bottomLabel,
    leftLabel: quadrant.leftLabel,
    rightLabel: quadrant.rightLabel,
    items: Array.from(unique.values()),
  };
}

@Injectable()
export class TierListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  private toView(row: TierListWithAuthor, viewer?: AuthenticatedUser): TierListView {
    const isOwner = Boolean(viewer && row.userId && row.userId === viewer.userId);
    const isAdmin = viewer?.role === Role.ADMIN;
    const cleanSnapshot =
      row.authorName && !/^steam_\d+$/.test(row.authorName) ? row.authorName : null;
    const handle = row.user?.profile?.handle ?? null;
    const style: 'classic' | 'quadrant' =
      row.style === 'quadrant' ? 'quadrant' : 'classic';

    return {
      id: row.id,
      title: row.title,
      author: row.user?.profile?.username || cleanSnapshot || handle || 'Jogador',
      authorHandle: handle,
      authorAvatarUrl: row.user?.profile?.avatarUrl ?? null,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      style,
      tiers: style === 'classic' ? parseTiersJson(row.tiers) : [],
      quadrant: style === 'quadrant' ? parseQuadrantJson(row.quadrant) : null,
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
                avatarUrl: true,
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
                avatarUrl: true,
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
    const style: 'classic' | 'quadrant' =
      dto.style === 'quadrant' ? 'quadrant' : 'classic';

    const labelsToModerate =
      style === 'quadrant' && dto.quadrant
        ? [
            dto.quadrant.topLabel,
            dto.quadrant.bottomLabel,
            dto.quadrant.leftLabel,
            dto.quadrant.rightLabel,
          ]
        : dto.tiers.map((t) => t.label);

    await this.moderation.assertSafeContent({
      texts: [dto.title, ...labelsToModerate],
    });

    const profile = await this.prisma.profile.findUnique({
      where: { userId: user.userId },
      select: { username: true, handle: true },
    });

    const emailPrefix = user.email.split('@')[0];
    const safeEmailFallback =
      emailPrefix && !user.email.endsWith('@steam.lockpro.local')
        ? emailPrefix
        : null;

    const authorName =
      profile?.username?.trim() ||
      profile?.handle?.trim() ||
      safeEmailFallback ||
      'Jogador';

    const created = await this.prisma.tierList.create({
      data: {
        userId: user.userId,
        title: dto.title,
        authorName,
        style,
        tiers: style === 'classic' ? sanitizeTiersInput(dto.tiers) : [],
        quadrant:
          style === 'quadrant' && dto.quadrant
            ? sanitizeQuadrantInput(dto.quadrant)
            : Prisma.JsonNull,
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
                avatarUrl: true,
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

    const style: 'classic' | 'quadrant' =
      dto.style === 'quadrant' ? 'quadrant' : 'classic';

    const labelsToModerate =
      style === 'quadrant' && dto.quadrant
        ? [
            dto.quadrant.topLabel,
            dto.quadrant.bottomLabel,
            dto.quadrant.leftLabel,
            dto.quadrant.rightLabel,
          ]
        : dto.tiers.map((t) => t.label);

    await this.moderation.assertSafeContent({
      texts: [dto.title, ...labelsToModerate],
    });

    const updated = await this.prisma.tierList.update({
      where: { id },
      data: {
        title: dto.title,
        style,
        tiers: style === 'classic' ? sanitizeTiersInput(dto.tiers) : [],
        quadrant:
          style === 'quadrant' && dto.quadrant
            ? sanitizeQuadrantInput(dto.quadrant)
            : Prisma.JsonNull,
      },
      include: {
        user: {
          select: {
            id: true,
            profile: {
              select: {
                username: true,
                handle: true,
                avatarUrl: true,
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