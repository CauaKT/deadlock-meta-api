import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  OnboardingDto,
  SocialLinksDto,
  UpdateProfileLookDto,
  UpdateProfileSettingsDto,
} from './dto/profiles.dto';

export interface SocialLinksView {
  steam?: string | null;
  twitter?: string | null;
  instagram?: string | null;
  discord?: string | null;
  youtube?: string | null;
  twitch?: string | null;
}

export interface PublicProfileView {
  id: string;
  username: string | null;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
  bio: string | null;
  bannerHeroId: number | null;
  bannerImage: string | null;
  bannerNsfw: boolean;
  profileColor: string | null;
  socialLinks: SocialLinksView | null;
  createdAt: Date;
}

function sanitizeSocialLinks(
  raw: SocialLinksDto | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return Prisma.JsonNull;
  const cleaned: Record<string, string> = {};
  const keys = ['steam', 'twitter', 'instagram', 'discord', 'youtube', 'twitch'] as const;
  for (const key of keys) {
    const val = raw[key]?.trim();
    if (val) cleaned[key] = val;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : Prisma.JsonNull;
}

function parseSocialLinks(raw: Prisma.JsonValue | null | undefined): SocialLinksView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out: SocialLinksView = {};
  const keys = ['steam', 'twitter', 'instagram', 'discord', 'youtube', 'twitch'] as const;
  for (const key of keys) {
    if (typeof rec[key] === 'string' && rec[key].trim()) {
      out[key] = rec[key].trim();
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface CommunityProfileView {
  id: string;
  username: string | null;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
}

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  private async ensureUniqueFields(
    userId: string,
    username: string,
    handle?: string | null,
  ): Promise<void> {
    const nickOwner = await this.prisma.profile.findFirst({
      where: {
        userId: { not: userId },
        username: { equals: username, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (nickOwner) {
      throw new ConflictException('Este nick já está em uso. Escolha outro.');
    }

    if (handle) {
      const handleOwner = await this.prisma.profile.findFirst({
        where: {
          userId: { not: userId },
          handle,
        },
        select: { id: true },
      });
      if (handleOwner) {
        throw new ConflictException('Esse @ já está em uso. Escolha outro.');
      }
    }
  }

  private mapUniqueViolation(err: unknown): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : '';
      if (target.includes('handle')) {
        throw new ConflictException('Esse @ já está em uso. Escolha outro.');
      }
      throw new ConflictException('Este nick já está em uso. Escolha outro.');
    }
    throw err;
  }

  async getOwnProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        profile: {
          select: {
            id: true,
            username: true,
            bio: true,
            handle: true,
            avatarUrl: true,
            steamId: true,
            favoriteHeroId: true,
            bannerHeroId: true,
            bannerImage: true,
            bannerNsfw: true,
            profileColor: true,
            socialLinks: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    return user;
  }

  async completeOnboarding(userId: string, dto: OnboardingDto) {
    await this.ensureUniqueFields(userId, dto.username, dto.handle);
    await this.moderation.assertSafeContent({
      texts: [dto.username, dto.handle],
      images: [dto.avatarUrl],
    });

    try {
      return await this.prisma.profile.upsert({
        where: { userId },
        create: {
          userId,
          username: dto.username,
          handle: dto.handle,
          avatarUrl: dto.avatarUrl ?? null,
        },
        update: {
          username: dto.username,
          handle: dto.handle,
          avatarUrl: dto.avatarUrl ?? null,
        },
      });
    } catch (err) {
      this.mapUniqueViolation(err);
    }
  }

  async updateLook(userId: string, dto: UpdateProfileLookDto) {
    await this.ensureUniqueFields(userId, dto.username, dto.handle ?? null);
    await this.moderation.assertSafeContent({
      texts: [
        dto.username,
        dto.bio,
        dto.handle,
        ...(dto.socialLinks ? Object.values(dto.socialLinks) : []),
      ],
      images: [dto.avatarUrl],
    });
    const { isNsfw: bannerNsfw } = await this.moderation.classifyImage(dto.bannerImage);
    const socialLinks = sanitizeSocialLinks(dto.socialLinks);

    try {
      return await this.prisma.profile.upsert({
        where: { userId },
        create: {
          userId,
          username: dto.username,
          bio: dto.bio ?? null,
          handle: dto.handle ?? null,
          avatarUrl: dto.avatarUrl ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
          bannerNsfw,
          profileColor: dto.profileColor ?? null,
          ...(socialLinks !== undefined ? { socialLinks } : {}),
        },
        update: {
          username: dto.username,
          bio: dto.bio ?? null,
          handle: dto.handle ?? null,
          avatarUrl: dto.avatarUrl ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
          bannerNsfw,
          ...(dto.profileColor !== undefined ? { profileColor: dto.profileColor } : {}),
          ...(socialLinks !== undefined ? { socialLinks } : {}),
        },
      });
    } catch (err) {
      this.mapUniqueViolation(err);
    }
  }

  async updateSettings(userId: string, dto: UpdateProfileSettingsDto) {
    await this.ensureUniqueFields(userId, dto.username, null);
    await this.moderation.assertSafeContent({
      texts: [
        dto.username,
        dto.steamId,
        ...(dto.socialLinks ? Object.values(dto.socialLinks) : []),
      ],
    });
    const { isNsfw: bannerNsfw } = await this.moderation.classifyImage(dto.bannerImage);
    const socialLinks = sanitizeSocialLinks(dto.socialLinks);

    try {
      return await this.prisma.profile.upsert({
        where: { userId },
        create: {
          userId,
          username: dto.username,
          steamId: dto.steamId ?? null,
          profileColor: dto.profileColor ?? null,
          favoriteHeroId: dto.favoriteHeroId ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
          bannerNsfw,
          ...(socialLinks !== undefined ? { socialLinks } : {}),
        },
        update: {
          username: dto.username,
          steamId: dto.steamId ?? null,
          profileColor: dto.profileColor ?? null,
          favoriteHeroId: dto.favoriteHeroId ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
          bannerNsfw,
          ...(socialLinks !== undefined ? { socialLinks } : {}),
        },
      });
    } catch (err) {
      this.mapUniqueViolation(err);
    }
  }

  async getCommunity(
    excludeUserId?: string,
    limit = 8,
    search?: string,
  ): Promise<CommunityProfileView[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 8));
    const q = search?.trim().replace(/^@+/, '');

    return this.prisma.profile.findMany({
      where: {
        handle: { not: null },
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
        ...(q
          ? {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { handle: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        username: true,
        handle: true,
        avatarUrl: true,
        favoriteHeroId: true,
      },
      orderBy: q ? { username: 'asc' } : { updatedAt: 'desc' },
      take: safeLimit,
    });
  }

  async getByHandle(handle: string): Promise<PublicProfileView> {
    const clean = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(clean)) {
      throw new NotFoundException('Perfil não encontrado.');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { handle: clean },
      select: {
        id: true,
        username: true,
        handle: true,
        avatarUrl: true,
        favoriteHeroId: true,
        bio: true,
        bannerHeroId: true,
        bannerImage: true,
        bannerNsfw: true,
        profileColor: true,
        socialLinks: true,
        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Perfil não encontrado.');
    }

    return {
      ...profile,
      socialLinks: parseSocialLinks(profile.socialLinks),
    };
  }
}