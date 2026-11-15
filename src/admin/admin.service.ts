import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// LGPD: o painel nunca recebe o e-mail completo (ex.: "be***@gmail.com")
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  return `${local.slice(0, local.length <= 2 ? 1 : 2)}***${email.slice(at)}`;
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(search?: string, page = 1, limit = 20) {
    const safePage = Math.max(1, Math.trunc(page) || 1);
    const safeLimit = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
    const q = search?.trim();

    const where = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { profile: { username: { contains: q, mode: 'insensitive' as const } } },
            { profile: { handle: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {};

    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          role: true,
          emailVerified: true,
          createdAt: true,
          profile: {
            select: {
              username: true,
              handle: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    return {
      page: safePage,
      limit: safeLimit,
      total,
      items: items.map((u) => ({ ...u, email: maskEmail(u.email) })),
    };
  }

  async deleteUser(targetUserId: string, actorUserId: string) {
    if (targetUserId === actorUserId) {
      throw new BadRequestException('Você não pode apagar sua própria conta pelo painel.');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true },
    });

    if (!target) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    if (target.role === Role.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: { role: Role.ADMIN },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Não é possível apagar o último administrador.');
      }
    }

    await this.prisma.user.delete({
      where: { id: targetUserId },
    });

    return { ok: true, email: maskEmail(target.email) };
  }

  async getSystemOverview() {
    const [users, verifiedUsers, admins, profiles, tierLists] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.user.count({ where: { role: Role.ADMIN } }),
      this.prisma.profile.count(),
      this.prisma.tierList.count(),
    ]);

    return {
      status: 'ok',
      counts: {
        users,
        verifiedUsers,
        admins,
        profiles,
        tierLists,
      },
    };
  }
}