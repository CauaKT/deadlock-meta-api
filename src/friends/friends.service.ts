import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FriendshipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface FriendUserView {
  friendshipId: string;
  userId: string;
  username: string;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
  createdAt: string;
}

export interface FriendsOverviewView {
  friends: FriendUserView[];
  incoming: FriendUserView[];
  outgoing: FriendUserView[];
}

export interface PublicFriendsView {
  friendsPublic: boolean;
  hidden: boolean;
  friends: FriendUserView[];
}

const userSummarySelect = {
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

function toFriendUserView(
  friendshipId: string,
  createdAt: Date,
  user: {
    id: string;
    profile: {
      username: string | null;
      handle: string | null;
      avatarUrl: string | null;
      favoriteHeroId: number | null;
    } | null;
  },
): FriendUserView {
  return {
    friendshipId,
    userId: user.id,
    username: user.profile?.username || user.profile?.handle || 'Jogador',
    handle: user.profile?.handle ?? null,
    avatarUrl: user.profile?.avatarUrl ?? null,
    favoriteHeroId: user.profile?.favoriteHeroId ?? null,
    createdAt: createdAt.toISOString(),
  };
}

@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(userId: string): Promise<FriendsOverviewView> {
    const rows = await this.prisma.friendship.findMany({
      where: {
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: { select: userSummarySelect },
        addressee: { select: userSummarySelect },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const friends: FriendUserView[] = [];
    const incoming: FriendUserView[] = [];
    const outgoing: FriendUserView[] = [];

    for (const row of rows) {
      const other = row.requesterId === userId ? row.addressee : row.requester;
      const view = toFriendUserView(row.id, row.createdAt, other);
      if (row.status === FriendshipStatus.ACCEPTED) {
        friends.push(view);
      } else if (row.addresseeId === userId) {
        incoming.push(view);
      } else {
        outgoing.push(view);
      }
    }

    return { friends, incoming, outgoing };
  }

  async getPublicByHandle(
    handle: string,
    viewerUserId?: string,
  ): Promise<PublicFriendsView> {
    const clean = handle.trim().toLowerCase();
    const profile = await this.prisma.profile.findUnique({
      where: { handle: clean },
      select: { userId: true, friendsPublic: true },
    });

    if (!profile) {
      throw new NotFoundException('Perfil não encontrado.');
    }

    if (!profile.friendsPublic && profile.userId !== viewerUserId) {
      return { friendsPublic: false, hidden: true, friends: [] };
    }

    const rows = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ requesterId: profile.userId }, { addresseeId: profile.userId }],
      },
      include: {
        requester: { select: userSummarySelect },
        addressee: { select: userSummarySelect },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      friendsPublic: profile.friendsPublic,
      hidden: false,
      friends: rows.map((row) =>
        toFriendUserView(
          row.id,
          row.createdAt,
          row.requesterId === profile.userId ? row.addressee : row.requester,
        ),
      ),
    };
  }

  async sendRequest(requesterId: string, targetUserId: string) {
    if (requesterId === targetUserId) {
      throw new BadRequestException('Você não pode adicionar a si mesmo.');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!target) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId, addresseeId: targetUserId },
          { requesterId: targetUserId, addresseeId: requesterId },
        ],
      },
    });

    if (existing) {
      if (existing.status === FriendshipStatus.ACCEPTED) {
        throw new ConflictException('Vocês já são amigos.');
      }
      if (existing.requesterId === targetUserId) {
        const accepted = await this.prisma.friendship.update({
          where: { id: existing.id },
          data: { status: FriendshipStatus.ACCEPTED },
        });
        return { id: accepted.id, status: accepted.status };
      }
      throw new ConflictException('Pedido de amizade já enviado.');
    }

    const created = await this.prisma.friendship.create({
      data: {
        requesterId,
        addresseeId: targetUserId,
        status: FriendshipStatus.PENDING,
      },
    });
    return { id: created.id, status: created.status };
  }

  async acceptRequest(friendshipId: string, userId: string) {
    const existing = await this.prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!existing) {
      throw new NotFoundException('Pedido de amizade não encontrado.');
    }
    if (existing.addresseeId !== userId) {
      throw new ForbiddenException('Apenas o destinatário pode aceitar este pedido.');
    }
    if (existing.status === FriendshipStatus.ACCEPTED) {
      return { id: existing.id, status: existing.status };
    }

    const updated = await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: FriendshipStatus.ACCEPTED },
    });
    return { id: updated.id, status: updated.status };
  }

  async removeFriendship(friendshipId: string, userId: string) {
    const existing = await this.prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!existing) {
      throw new NotFoundException('Amizade ou pedido não encontrado.');
    }
    if (existing.requesterId !== userId && existing.addresseeId !== userId) {
      throw new ForbiddenException('Sem permissão para remover este vínculo.');
    }

    await this.prisma.friendship.delete({ where: { id: friendshipId } });
    return { deleted: true };
  }

  async updatePrivacy(userId: string, friendsPublic: boolean) {
    await this.prisma.profile.update({
      where: { userId },
      data: { friendsPublic },
    });
    return { friendsPublic };
  }
}