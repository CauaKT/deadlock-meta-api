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
  CreateTierListCommentDto,
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

export type TierQuadrantItemView = {
  heroId: number;
  x: number;
  y: number;
};

export interface TierQuadrantView {
  topLabel: string;
  bottomLabel: string;
  leftLabel: string;
  rightLabel: string;
  axes: string[];
  items: TierQuadrantItemView[];
}

export interface TierListCommentAuthorView {
  id: string;
  username: string;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
}

export interface TierListCommentView {
  id: string;
  tierListId: string;
  content: string;
  createdAt: string;
  author: TierListCommentAuthorView;
  canDelete: boolean;
}

export interface TierListView {
  id: string;
  title: string;
  description: string | null;
  author: string;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  style: 'classic' | 'quadrant';
  tiers: TierRowView[];
  quadrant: TierQuadrantView | null;
  viewsCount: number;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  relevanceScore: number;
  recentComments: TierListCommentView[];
  comments?: TierListCommentView[];
  canEdit: boolean;
  canDelete: boolean;
}

const commentAuthorSelect = {
  id: true,
  profile: {
    select: {
      username: true,
      handle: true,
      avatarUrl: true,
      favoriteHeroId: true,
    },
  },
} satisfies Prisma.UserSelect;

function tierListInclude(viewerId?: string, fullComments = false) {
  return {
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
    _count: {
      select: {
        likes: true,
        comments: true,
      },
    },
    likes: viewerId
      ? { where: { userId: viewerId }, select: { id: true } }
      : false,
    comments: {
      orderBy: { createdAt: fullComments ? ('asc' as const) : ('desc' as const) },
      ...(fullComments ? {} : { take: 3 }),
      include: {
        user: { select: commentAuthorSelect },
      },
    },
  } satisfies Prisma.TierListInclude;
}

type TierListWithRelations = Prisma.TierListGetPayload<{
  include: ReturnType<typeof tierListInclude>;
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
  const rawAxes = Array.isArray(rec.axes)
    ? rec.axes
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim())
        .slice(0, 10)
    : [];
  const axes =
    rawAxes.length >= 3
      ? rawAxes
      : [topLabel, rightLabel, bottomLabel, leftLabel];
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
  return { topLabel, bottomLabel, leftLabel, rightLabel, axes, items };
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
  const rawAxes = Array.isArray(quadrant.axes)
    ? quadrant.axes.map((a) => a.trim()).filter(Boolean).slice(0, 10)
    : [];
  const axes =
    rawAxes.length >= 3
      ? rawAxes
      : [
          quadrant.topLabel?.trim() || 'Difícil de dominar',
          quadrant.rightLabel?.trim() || 'Difícil de aprender',
          quadrant.bottomLabel?.trim() || 'Fácil de dominar',
          quadrant.leftLabel?.trim() || 'Fácil de aprender',
        ];
  return {
    topLabel: axes[0],
    rightLabel: axes[1],
    bottomLabel: axes[2] ?? axes[1],
    leftLabel: axes[3] ?? axes[axes.length - 1],
    axes,
    items: Array.from(unique.values()),
  };
}

function toCommentView(
  c: {
    id: string;
    tierListId: string;
    userId: string;
    content: string;
    createdAt: Date;
    user: {
      id: string;
      profile: {
        username: string | null;
        handle: string | null;
        avatarUrl: string | null;
        favoriteHeroId: number | null;
      } | null;
    };
  },
  tierListOwnerId: string | null,
  viewer?: AuthenticatedUser,
): TierListCommentView {
  const canDelete = Boolean(
    viewer &&
      (c.userId === viewer.userId ||
        (tierListOwnerId && tierListOwnerId === viewer.userId) ||
        viewer.role === Role.ADMIN),
  );
  return {
    id: c.id,
    tierListId: c.tierListId,
    content: c.content,
    createdAt: c.createdAt.toISOString(),
    author: {
      id: c.user.id,
      username: c.user.profile?.username || c.user.profile?.handle || 'Jogador',
      handle: c.user.profile?.handle ?? null,
      avatarUrl: c.user.profile?.avatarUrl ?? null,
      favoriteHeroId: c.user.profile?.favoriteHeroId ?? null,
    },
    canDelete,
  };
}

function computeRelevanceScore(
  likesCount: number,
  commentsCount: number,
  viewsCount: number,
  createdAt: Date,
): number {
  const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / 86_400_000);
  const raw =
    (likesCount * 4 + commentsCount * 6 + Math.min(viewsCount, 500) * 0.15 + 1) /
    Math.pow(ageDays + 1, 0.75);
  return Math.round(raw * 100) / 100;
}

@Injectable()
export class TierListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  private toView(
    row: TierListWithRelations,
    viewer?: AuthenticatedUser,
    fullComments = false,
  ): TierListView {
    const isOwner = Boolean(viewer && row.userId && row.userId === viewer.userId);
    const isAdmin = viewer?.role === Role.ADMIN;
    const cleanSnapshot =
      row.authorName && !/^steam_\d+$/.test(row.authorName) ? row.authorName : null;
    const handle = row.user?.profile?.handle ?? null;
    const style: 'classic' | 'quadrant' =
      row.style === 'quadrant' ? 'quadrant' : 'classic';

    const likesCount = row._count?.likes ?? 0;
    const commentsCount = row._count?.comments ?? 0;
    const likedByMe = Array.isArray(row.likes) && row.likes.length > 0;
    const viewsCount = row.viewsCount ?? 0;

    const mappedComments = (row.comments ?? []).map((c) =>
      toCommentView(c, row.userId, viewer),
    );
    const orderedComments = fullComments
      ? mappedComments
      : [...mappedComments].reverse();

    return {
      id: row.id,
      title: row.title,
      description: row.description ?? null,
      author: row.user?.profile?.username || cleanSnapshot || handle || 'Jogador',
      authorHandle: handle,
      authorAvatarUrl: row.user?.profile?.avatarUrl ?? null,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      style,
      tiers: style === 'classic' ? parseTiersJson(row.tiers) : [],
      quadrant: style === 'quadrant' ? parseQuadrantJson(row.quadrant) : null,
      viewsCount,
      likesCount,
      commentsCount,
      likedByMe,
      relevanceScore: computeRelevanceScore(
        likesCount,
        commentsCount,
        viewsCount,
        row.createdAt,
      ),
      recentComments: fullComments ? orderedComments.slice(-3) : orderedComments,
      ...(fullComments ? { comments: orderedComments } : {}),
      canEdit: isOwner,
      canDelete: isOwner || isAdmin,
    };
  }

  async findAll(
    viewer?: AuthenticatedUser,
    filters?: {
      userId?: string;
      handle?: string;
      style?: string;
      sort?: string;
      search?: string;
      heroId?: number;
      likedByMe?: boolean;
    },
  ): Promise<TierListView[]> {
    const cleanUserId = filters?.userId?.trim();
    const cleanHandle = filters?.handle?.trim().replace(/^@+/, '');
    const cleanSearch = filters?.search?.trim();

    const andConditions: Prisma.TierListWhereInput[] = [];
    if (cleanUserId) {
      andConditions.push({ userId: cleanUserId });
    } else if (cleanHandle) {
      andConditions.push({
        user: {
          profile: {
            handle: { equals: cleanHandle, mode: 'insensitive' },
          },
        },
      });
    }

    if (filters?.style === 'classic' || filters?.style === 'quadrant') {
      andConditions.push({ style: filters.style });
    }

    if (filters?.likedByMe && viewer) {
      andConditions.push({
        likes: { some: { userId: viewer.userId } },
      });
    }

    if (cleanSearch) {
      andConditions.push({
        OR: [
          { title: { contains: cleanSearch, mode: 'insensitive' } },
          { description: { contains: cleanSearch, mode: 'insensitive' } },
          { authorName: { contains: cleanSearch, mode: 'insensitive' } },
          {
            user: {
              profile: {
                OR: [
                  { username: { contains: cleanSearch, mode: 'insensitive' } },
                  { handle: { contains: cleanSearch, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }

    const rows = await this.prisma.tierList.findMany({
      where: andConditions.length > 0 ? { AND: andConditions } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: tierListInclude(viewer?.userId, false),
    });

    let items = rows.map((row) => this.toView(row, viewer, false));

    const targetHeroId = filters?.heroId;
    if (targetHeroId && Number.isInteger(targetHeroId) && targetHeroId > 0) {
      items = items.filter((item) =>
        item.style === 'quadrant'
          ? Boolean(item.quadrant?.items.some((it) => it.heroId === targetHeroId))
          : item.tiers.some((t) => t.heroes.includes(targetHeroId)),
      );
    }

    const sort = filters?.sort;
    if (sort === 'likes') {
      items.sort(
        (a, b) =>
          b.likesCount - a.likesCount ||
          b.commentsCount - a.commentsCount ||
          b.createdAt.localeCompare(a.createdAt),
      );
    } else if (sort === 'comments') {
      items.sort(
        (a, b) =>
          b.commentsCount - a.commentsCount ||
          b.likesCount - a.likesCount ||
          b.createdAt.localeCompare(a.createdAt),
      );
    } else if (sort === 'views') {
      items.sort(
        (a, b) =>
          b.viewsCount - a.viewsCount ||
          b.likesCount - a.likesCount ||
          b.createdAt.localeCompare(a.createdAt),
      );
    } else if (sort === 'relevance') {
      items.sort(
        (a, b) =>
          b.relevanceScore - a.relevanceScore ||
          b.likesCount - a.likesCount ||
          b.createdAt.localeCompare(a.createdAt),
      );
    }

    return items;
  }

  async findOne(id: string, viewer?: AuthenticatedUser): Promise<TierListView> {
    const row = await this.prisma.tierList.findUnique({
      where: { id },
      include: tierListInclude(viewer?.userId, true),
    });

    if (!row) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    return this.toView(row, viewer, true);
  }

  async create(user: AuthenticatedUser, dto: CreateTierListDto): Promise<TierListView> {
    const style: 'classic' | 'quadrant' =
      dto.style === 'quadrant' ? 'quadrant' : 'classic';

    const labelsToModerate =
      style === 'quadrant' && dto.quadrant
        ? dto.quadrant.axes?.length
          ? dto.quadrant.axes
          : [
              dto.quadrant.topLabel ?? '',
              dto.quadrant.bottomLabel ?? '',
              dto.quadrant.leftLabel ?? '',
              dto.quadrant.rightLabel ?? '',
            ].filter(Boolean)
        : dto.tiers.map((t) => t.label);

    await this.moderation.assertSafeContent({
      texts: [
        dto.title,
        ...(dto.description ? [dto.description] : []),
        ...labelsToModerate,
      ],
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
        description: dto.description ?? null,
        authorName,
        style,
        tiers: style === 'classic' ? sanitizeTiersInput(dto.tiers) : [],
        quadrant:
          style === 'quadrant' && dto.quadrant
            ? sanitizeQuadrantInput(dto.quadrant)
            : Prisma.JsonNull,
      },
      include: tierListInclude(user.userId, false),
    });

    return this.toView(created, user, false);
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
        ? dto.quadrant.axes?.length
          ? dto.quadrant.axes
          : [
              dto.quadrant.topLabel ?? '',
              dto.quadrant.bottomLabel ?? '',
              dto.quadrant.leftLabel ?? '',
              dto.quadrant.rightLabel ?? '',
            ].filter(Boolean)
        : dto.tiers.map((t) => t.label);

    await this.moderation.assertSafeContent({
      texts: [
        dto.title,
        ...(dto.description ? [dto.description] : []),
        ...labelsToModerate,
      ],
    });

    const updated = await this.prisma.tierList.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description ?? null,
        style,
        tiers: style === 'classic' ? sanitizeTiersInput(dto.tiers) : [],
        quadrant:
          style === 'quadrant' && dto.quadrant
            ? sanitizeQuadrantInput(dto.quadrant)
            : Prisma.JsonNull,
      },
      include: tierListInclude(user.userId, false),
    });

    return this.toView(updated, user, false);
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

  async toggleLike(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{ liked: boolean; likesCount: number }> {
    const existingList = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existingList) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    const existing = await this.prisma.tierListLike.findUnique({
      where: { tierListId_userId: { tierListId: id, userId: user.userId } },
      select: { id: true },
    });

    let liked = false;
    if (existing) {
      await this.prisma.tierListLike.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.tierListLike.create({
        data: { tierListId: id, userId: user.userId },
      });
      liked = true;
    }

    const likesCount = await this.prisma.tierListLike.count({
      where: { tierListId: id },
    });

    return { liked, likesCount };
  }

  async recordView(id: string): Promise<{ viewsCount: number }> {
    const existing = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    const updated = await this.prisma.tierList.update({
      where: { id },
      data: { viewsCount: { increment: 1 } },
      select: { viewsCount: true },
    });

    return { viewsCount: updated.viewsCount };
  }

  async getComments(
    id: string,
    viewer?: AuthenticatedUser,
  ): Promise<TierListCommentView[]> {
    const list = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!list) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    const rows = await this.prisma.tierListComment.findMany({
      where: { tierListId: id },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: commentAuthorSelect } },
    });

    return rows.map((c) => toCommentView(c, list.userId, viewer));
  }

  async addComment(
    id: string,
    user: AuthenticatedUser,
    dto: CreateTierListCommentDto,
  ): Promise<TierListCommentView> {
    const list = await this.prisma.tierList.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!list) {
      throw new NotFoundException('Tier list não encontrada.');
    }

    await this.moderation.assertSafeContent({ texts: [dto.content] });

    const created = await this.prisma.tierListComment.create({
      data: {
        tierListId: id,
        userId: user.userId,
        content: dto.content,
      },
      include: { user: { select: commentAuthorSelect } },
    });

    return toCommentView(created, list.userId, user);
  }

  async removeComment(
    commentId: string,
    user: AuthenticatedUser,
  ): Promise<{ deleted: true }> {
    const existing = await this.prisma.tierListComment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        userId: true,
        tierList: { select: { userId: true } },
      },
    });
    if (!existing) {
      throw new NotFoundException('Comentário não encontrado.');
    }

    const isCommentAuthor = existing.userId === user.userId;
    const isListOwner = existing.tierList.userId === user.userId;
    const isAdmin = user.role === Role.ADMIN;

    if (!isCommentAuthor && !isListOwner && !isAdmin) {
      throw new ForbiddenException('Sem permissão para excluir este comentário.');
    }

    await this.prisma.tierListComment.delete({ where: { id: commentId } });
    return { deleted: true };
  }
}