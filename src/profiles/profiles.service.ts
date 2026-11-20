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
  userId: string;
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
  friendsPublic: boolean;
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
  userId: string;
  username: string | null;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
  mutualFriendsCount: number;
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
            friendsPublic: true,
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
          handleConfirmed: true,
          avatarUrl: dto.avatarUrl ?? null,
        },
        update: {
          username: dto.username,
          handle: dto.handle,
          handleConfirmed: true,
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

  private steamIdVariants(raw: string): string[] {
    const clean = raw.trim();
    if (!/^\d{3,20}$/.test(clean)) return clean ? [clean] : [];
    const STEAM64_BASE = BigInt('76561197960265728');
    const set = new Set<string>([clean]);
    try {
      const val = BigInt(clean);
      if (val > STEAM64_BASE) set.add((val - STEAM64_BASE).toString());
      else if (val > BigInt(0)) set.add((val + STEAM64_BASE).toString());
    } catch {}
    return Array.from(set);
  }

  async updateSettings(userId: string, dto: UpdateProfileSettingsDto) {
    await this.ensureUniqueFields(userId, dto.username, null);

    const cleanSteamId = dto.steamId?.trim() || null;
    if (cleanSteamId) {
      const variants = this.steamIdVariants(cleanSteamId);
      const conflict = await this.prisma.profile.findFirst({
        where: {
          userId: { not: userId },
          steamId: { in: variants },
        },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException('Este Steam ID já está vinculado a outra conta.');
      }
    }

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

    const myFriendIds = new Set<string>();
    const mutualCounts = new Map<string, number>();

    if (excludeUserId) {
      const myFriendships = await this.prisma.friendship.findMany({
        where: {
          status: 'ACCEPTED',
          OR: [{ requesterId: excludeUserId }, { addresseeId: excludeUserId }],
        },
        select: { requesterId: true, addresseeId: true },
      });

      for (const f of myFriendships) {
        myFriendIds.add(f.requesterId === excludeUserId ? f.addresseeId : f.requesterId);
      }

      if (myFriendIds.size > 0) {
        const myFriendArr = Array.from(myFriendIds);
        const secondDegree = await this.prisma.friendship.findMany({
          where: {
            status: 'ACCEPTED',
            OR: [{ requesterId: { in: myFriendArr } }, { addresseeId: { in: myFriendArr } }],
          },
          select: { requesterId: true, addresseeId: true },
        });

        for (const f of secondDegree) {
          if (myFriendIds.has(f.requesterId) && f.addresseeId !== excludeUserId && !myFriendIds.has(f.addresseeId)) {
            mutualCounts.set(f.addresseeId, (mutualCounts.get(f.addresseeId) ?? 0) + 1);
          }
          if (myFriendIds.has(f.addresseeId) && f.requesterId !== excludeUserId && !myFriendIds.has(f.requesterId)) {
            mutualCounts.set(f.requesterId, (mutualCounts.get(f.requesterId) ?? 0) + 1);
          }
        }
      }
    }

    const excludedIds = excludeUserId ? [excludeUserId, ...Array.from(myFriendIds)] : [];

    const candidates = await this.prisma.profile.findMany({
      where: {
        handle: { not: null },
        ...(excludedIds.length > 0 ? { userId: { notIn: excludedIds } } : {}),
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
        userId: true,
        username: true,
        handle: true,
        avatarUrl: true,
        favoriteHeroId: true,
      },
      orderBy: q ? { username: 'asc' } : { updatedAt: 'desc' },
      take: q ? safeLimit : Math.max(safeLimit * 3, 50),
    });

    const mapped: CommunityProfileView[] = candidates.map((c) => ({
      ...c,
      mutualFriendsCount: mutualCounts.get(c.userId) ?? 0,
    }));

    if (!q) {
      mapped.sort((a, b) => b.mutualFriendsCount - a.mutualFriendsCount);
    }

    return mapped.slice(0, safeLimit);
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
        userId: true,
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
        friendsPublic: true,
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

  async getBySteamId(rawSteamId: string): Promise<PublicProfileView | null> {
    const clean = rawSteamId.trim();
    if (!/^\d{3,20}$/.test(clean)) return null;

    const STEAM64_BASE = BigInt('76561197960265728');
    const candidates = new Set<string>([clean]);
    try {
      const val = BigInt(clean);
      if (val > STEAM64_BASE) {
        candidates.add((val - STEAM64_BASE).toString());
      } else if (val > BigInt(0)) {
        candidates.add((val + STEAM64_BASE).toString());
      }
    } catch {
      return null;
    }

    const profile = await this.prisma.profile.findFirst({
      where: {
        steamId: { in: Array.from(candidates) },
        handle: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        userId: true,
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
        friendsPublic: true,
        createdAt: true,
      },
    });

    if (!profile) return null;

    return {
      ...profile,
      socialLinks: parseSocialLinks(profile.socialLinks),
    };
  }
}