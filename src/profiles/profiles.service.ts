import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  OnboardingDto,
  UpdateProfileLookDto,
  UpdateProfileSettingsDto,
} from './dto/profiles.dto';

export interface PublicProfileView {
  id: string;
  username: string | null;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
  bio: string | null;
  bannerHeroId: number | null;
  bannerImage: string | null;
  profileColor: string | null;
  createdAt: Date;
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
  constructor(private readonly prisma: PrismaService) {}

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
            profileColor: true,
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
          profileColor: dto.profileColor ?? null,
        },
        update: {
          username: dto.username,
          bio: dto.bio ?? null,
          handle: dto.handle ?? null,
          avatarUrl: dto.avatarUrl ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
          ...(dto.profileColor !== undefined ? { profileColor: dto.profileColor } : {}),
        },
      });
    } catch (err) {
      this.mapUniqueViolation(err);
    }
  }

  async updateSettings(userId: string, dto: UpdateProfileSettingsDto) {
    await this.ensureUniqueFields(userId, dto.username, null);

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
        },
        update: {
          username: dto.username,
          steamId: dto.steamId ?? null,
          profileColor: dto.profileColor ?? null,
          favoriteHeroId: dto.favoriteHeroId ?? null,
          bannerHeroId: dto.bannerHeroId ?? null,
          bannerImage: dto.bannerImage ?? null,
        },
      });
    } catch (err) {
      this.mapUniqueViolation(err);
    }
  }

  async getCommunity(excludeUserId?: string, limit = 8): Promise<CommunityProfileView[]> {
    const safeLimit = Math.min(20, Math.max(1, Math.trunc(limit) || 8));
    return this.prisma.profile.findMany({
      where: {
        handle: { not: null },
        ...(excludeUserId ? { userId: { not: excludeUserId } } : {}),
      },
      select: {
        id: true,
        username: true,
        handle: true,
        avatarUrl: true,
        favoriteHeroId: true,
      },
      orderBy: { updatedAt: 'desc' },
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
        profileColor: true,
        createdAt: true,
      },
    });

    if (!profile) {
      throw new NotFoundException('Perfil não encontrado.');
    }

    return profile;
  }
}