import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCommentDto, CreatePostDto } from './dto/feed.dto';

export interface FeedAuthorView {
  id: string;
  username: string;
  handle: string | null;
  avatarUrl: string | null;
  favoriteHeroId: number | null;
}

export interface FeedCommentView {
  id: string;
  postId: string;
  content: string;
  createdAt: string;
  author: FeedAuthorView;
  canDelete: boolean;
}

export interface FeedPostView {
  id: string;
  content: string;
  mediaUrl: string | null;
  createdAt: string;
  author: FeedAuthorView;
  likesCount: number;
  commentsCount: number;
  likedByMe: boolean;
  canDelete: boolean;
  comments: FeedCommentView[];
}

const authorSelect = {
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

function toAuthorView(user: {
  id: string;
  profile: {
    username: string | null;
    handle: string | null;
    avatarUrl: string | null;
    favoriteHeroId: number | null;
  } | null;
}): FeedAuthorView {
  return {
    id: user.id,
    username: user.profile?.username || user.profile?.handle || 'Jogador',
    handle: user.profile?.handle ?? null,
    avatarUrl: user.profile?.avatarUrl ?? null,
    favoriteHeroId: user.profile?.favoriteHeroId ?? null,
  };
}

@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  async findAll(
    viewer?: AuthenticatedUser,
    page = 1,
    limit = 20,
  ): Promise<{ items: FeedPostView[]; page: number; hasMore: boolean }> {
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(Math.max(1, limit), 50);
    const skip = (safePage - 1) * safeLimit;

    const rows = await this.prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit + 1,
      include: {
        user: { select: authorSelect },
        _count: { select: { likes: true, comments: true } },
        likes: viewer
          ? { where: { userId: viewer.userId }, select: { id: true } }
          : false,
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: authorSelect } },
        },
      },
    });

    const hasMore = rows.length > safeLimit;
    const sliced = hasMore ? rows.slice(0, safeLimit) : rows;

    const items: FeedPostView[] = sliced.map((row) => ({
      id: row.id,
      content: row.content,
      mediaUrl: row.mediaUrl,
      createdAt: row.createdAt.toISOString(),
      author: toAuthorView(row.user),
      likesCount: row._count.likes,
      commentsCount: row._count.comments,
      likedByMe: Array.isArray(row.likes) && row.likes.length > 0,
      canDelete: Boolean(
        viewer && (row.userId === viewer.userId || viewer.role === Role.ADMIN),
      ),
      comments: row.comments.map((c) => ({
        id: c.id,
        postId: c.postId,
        content: c.content,
        createdAt: c.createdAt.toISOString(),
        author: toAuthorView(c.user),
        canDelete: Boolean(
          viewer && (c.userId === viewer.userId || viewer.role === Role.ADMIN),
        ),
      })),
    }));

    return { items, page: safePage, hasMore };
  }

  async createPost(
    user: AuthenticatedUser,
    dto: CreatePostDto,
  ): Promise<FeedPostView> {
    await this.moderation.assertSafeContent({
      texts: [dto.content],
      images: dto.mediaUrl ? [dto.mediaUrl] : [],
    });

    const created = await this.prisma.post.create({
      data: {
        userId: user.userId,
        content: dto.content,
        mediaUrl: dto.mediaUrl ?? null,
      },
      include: {
        user: { select: authorSelect },
      },
    });

    return {
      id: created.id,
      content: created.content,
      mediaUrl: created.mediaUrl,
      createdAt: created.createdAt.toISOString(),
      author: toAuthorView(created.user),
      likesCount: 0,
      commentsCount: 0,
      likedByMe: false,
      canDelete: true,
      comments: [],
    };
  }

  async removePost(id: string, user: AuthenticatedUser): Promise<{ deleted: true }> {
    const existing = await this.prisma.post.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!existing) throw new NotFoundException('Postagem não encontrada.');

    if (existing.userId !== user.userId && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Sem permissão para excluir esta postagem.');
    }

    await this.prisma.post.delete({ where: { id } });
    return { deleted: true };
  }

  async toggleLike(
    postId: string,
    user: AuthenticatedUser,
  ): Promise<{ liked: boolean; likesCount: number }> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Postagem não encontrada.');

    const existing = await this.prisma.postLike.findUnique({
      where: { postId_userId: { postId, userId: user.userId } },
      select: { id: true },
    });

    let liked = false;
    if (existing) {
      await this.prisma.postLike.delete({ where: { id: existing.id } });
    } else {
      await this.prisma.postLike.create({
        data: { postId, userId: user.userId },
      });
      liked = true;
    }

    const likesCount = await this.prisma.postLike.count({ where: { postId } });
    return { liked, likesCount };
  }

  async createComment(
    postId: string,
    user: AuthenticatedUser,
    dto: CreateCommentDto,
  ): Promise<FeedCommentView> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Postagem não encontrada.');

    await this.moderation.assertSafeContent({ texts: [dto.content] });

    const created = await this.prisma.postComment.create({
      data: {
        postId,
        userId: user.userId,
        content: dto.content,
      },
      include: {
        user: { select: authorSelect },
      },
    });

    return {
      id: created.id,
      postId: created.postId,
      content: created.content,
      createdAt: created.createdAt.toISOString(),
      author: toAuthorView(created.user),
      canDelete: true,
    };
  }

  async removeComment(
    commentId: string,
    user: AuthenticatedUser,
  ): Promise<{ deleted: true }> {
    const existing = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true },
    });
    if (!existing) throw new NotFoundException('Comentário não encontrado.');

    if (existing.userId !== user.userId && user.role !== Role.ADMIN) {
      throw new ForbiddenException('Sem permissão para excluir este comentário.');
    }

    await this.prisma.postComment.delete({ where: { id: commentId } });
    return { deleted: true };
  }
}