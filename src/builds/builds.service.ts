import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type { BuildPhasesDto, CreateBuildDto, UpdateBuildDto } from './dto/builds.dto';

export interface BuildPhasesView {
  early: string[];
  mid: string[];
  late: string[];
  situational: string[];
}

export interface BuildView {
  id: string;
  heroId: number;
  title: string;
  author: string;
  authorHandle: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  phases: BuildPhasesView;
  canEdit: boolean;
  canDelete: boolean;
}

type BuildWithAuthor = Prisma.BuildGetPayload<{
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

const cleanList = (arr: unknown): string[] =>
  Array.isArray(arr)
    ? Array.from(
        new Set(arr.filter((x): x is string => typeof x === 'string' && /^[a-zA-Z0-9_]+$/.test(x))),
      ).slice(0, 12)
    : [];

function parsePhasesJson(raw: Prisma.JsonValue): BuildPhasesView {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    early: cleanList(obj.early),
    mid: cleanList(obj.mid),
    late: cleanList(obj.late),
    situational: cleanList(obj.situational),
  };
}

function sanitizePhasesInput(phases: BuildPhasesDto): Prisma.InputJsonValue {
  return {
    early: cleanList(phases.early),
    mid: cleanList(phases.mid),
    late: cleanList(phases.late),
    situational: cleanList(phases.situational),
  };
}

@Injectable()
export class BuildsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  private toView(row: BuildWithAuthor, viewer?: AuthenticatedUser): BuildView {
    const isOwner = Boolean(viewer && row.userId && viewer.userId === row.userId);
    const isAdmin = viewer?.role === Role.ADMIN;
    const author = row.user?.profile?.username || row.authorName || 'Anônimo';

    return {
      id: row.id,
      heroId: row.heroId,
      title: row.title,
      author,
      authorHandle: row.user?.profile?.handle ?? null,
      userId: row.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      phases: parsePhasesJson(row.phases),
      canEdit: isOwner,
      canDelete: isOwner || Boolean(isAdmin),
    };
  }

  async findAll(
    viewer?: AuthenticatedUser,
    filters?: { heroId?: number; userId?: string; handle?: string },
  ): Promise<BuildView[]> {
    const cleanHandle = filters?.handle?.trim().replace(/^@+/, '').toLowerCase();
    const cleanUserId = filters?.userId?.trim();

    const rows = await this.prisma.build.findMany({
      where: {
        ...(filters?.heroId ? { heroId: filters.heroId } : {}),
        ...(cleanUserId ? { userId: cleanUserId } : {}),
        ...(cleanHandle
          ? {
              user: {
                profile: {
                  handle: { equals: cleanHandle, mode: 'insensitive' },
                },
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { username: true, handle: true } },
          },
        },
      },
    });

    return rows.map((row) => this.toView(row, viewer));
  }

  async findOne(id: string, viewer?: AuthenticatedUser): Promise<BuildView> {
    const row = await this.prisma.build.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { username: true, handle: true } },
          },
        },
      },
    });
    if (!row) throw new NotFoundException('Build não encontrada.');
    return this.toView(row, viewer);
  }

  async create(user: AuthenticatedUser, dto: CreateBuildDto): Promise<BuildView> {
    await this.moderation.assertSafeContent({ texts: [dto.title] });

    const profile = await this.prisma.profile.findUnique({
      where: { userId: user.userId },
      select: { username: true },
    });

    const created = await this.prisma.build.create({
      data: {
        userId: user.userId,
        heroId: dto.heroId,
        title: dto.title,
        authorName: profile?.username || null,
        phases: sanitizePhasesInput(dto.phases),
      },
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { username: true, handle: true } },
          },
        },
      },
    });

    return this.toView(created, user);
  }

  async update(
    id: string,
    user: AuthenticatedUser,
    dto: UpdateBuildDto,
  ): Promise<BuildView> {
    const existing = await this.prisma.build.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) throw new NotFoundException('Build não encontrada.');
    if (!existing.userId || existing.userId !== user.userId) {
      throw new ForbiddenException('Apenas o criador pode editar esta build.');
    }

    await this.moderation.assertSafeContent({ texts: [dto.title] });

    const updated = await this.prisma.build.update({
      where: { id },
      data: {
        ...(dto.heroId ? { heroId: dto.heroId } : {}),
        title: dto.title,
        phases: sanitizePhasesInput(dto.phases),
      },
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { username: true, handle: true } },
          },
        },
      },
    });

    return this.toView(updated, user);
  }

  async remove(id: string, user: AuthenticatedUser): Promise<{ ok: true }> {
    const existing = await this.prisma.build.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) throw new NotFoundException('Build não encontrada.');

    const isOwner = Boolean(existing.userId && existing.userId === user.userId);
    const isAdmin = user.role === Role.ADMIN;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Sem permissão para excluir esta build.');
    }

    await this.prisma.build.delete({ where: { id } });
    return { ok: true };
  }
}