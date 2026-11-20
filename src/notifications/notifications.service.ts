import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface NotificationItem {
  id: string;
  type: 'friend_request' | 'post_like' | 'post_comment';
  actorName: string;
  actorHandle: string | null;
  message: string;
  href: string;
  createdAt: string;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getRecent(userId: string): Promise<NotificationItem[]> {
    const [friendRequests, likes, comments] = await Promise.all([
      this.prisma.friendship.findMany({
        where: { addresseeId: userId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          requester: {
            select: {
              profile: { select: { username: true, handle: true } },
            },
          },
        },
      }),
      this.prisma.postLike.findMany({
        where: { post: { userId }, userId: { not: userId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: {
            select: {
              profile: { select: { username: true, handle: true } },
            },
          },
          post: { select: { content: true } },
        },
      }),
      this.prisma.postComment.findMany({
        where: { post: { userId }, userId: { not: userId } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          user: {
            select: {
              profile: { select: { username: true, handle: true } },
            },
          },
        },
      }),
    ]);

    const list: NotificationItem[] = [
      ...friendRequests.map((fr) => ({
        id: `fr-${fr.id}`,
        type: 'friend_request' as const,
        actorName: fr.requester.profile?.username || 'Jogador',
        actorHandle: fr.requester.profile?.handle ?? null,
        message: 'enviou um pedido de amizade.',
        href: '/profile',
        createdAt: fr.createdAt.toISOString(),
      })),
      ...likes.map((lk) => ({
        id: `lk-${lk.id}`,
        type: 'post_like' as const,
        actorName: lk.user.profile?.username || 'Jogador',
        actorHandle: lk.user.profile?.handle ?? null,
        message: `curtiu sua publicação: "${lk.post.content.slice(0, 40)}"`,
        href: '/feed',
        createdAt: lk.createdAt.toISOString(),
      })),
      ...comments.map((cm) => ({
        id: `cm-${cm.id}`,
        type: 'post_comment' as const,
        actorName: cm.user.profile?.username || 'Jogador',
        actorHandle: cm.user.profile?.handle ?? null,
        message: `comentou no seu post: "${cm.content.slice(0, 40)}"`,
        href: '/feed',
        createdAt: cm.createdAt.toISOString(),
      })),
    ];

    return list
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 20);
  }
}