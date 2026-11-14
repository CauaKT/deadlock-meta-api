import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, TokenType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import type { AdminResetPasswordDto } from './dto/admin.dto';

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
      items,
    };
  }

  async updateUserRole(targetUserId: string, role: Role) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true },
    });

    if (!target) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    if (target.role === Role.ADMIN && role !== Role.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: { role: Role.ADMIN },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Não é possível rebaixar o último administrador.');
      }
    }

    return this.prisma.user.update({
      where: { id: targetUserId },
      data: target.role !== role ? { role, sessionVersion: { increment: 1 } } : { role },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });
  }

  async resetUserPassword(targetUserId: string, dto: AdminResetPasswordDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true },
    });

    if (!target) {
      throw new NotFoundException('Usuário não encontrado.');
    }

    if (dto.letUserChoose) {
      await this.prisma.user.update({
        where: { id: targetUserId },
        data: {
          mustChangePassword: true,
          sessionVersion: { increment: 1 },
        },
      });
      return { ok: true, email: target.email, letUserChoose: true };
    }

    if (!dto.newPassword) {
      throw new BadRequestException('Informe uma nova senha ou escolha deixar o usuário definir.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: targetUserId },
        data: {
          passwordHash,
          mustChangePassword: false,
          sessionVersion: { increment: 1 },
        },
      }),
      this.prisma.authToken.deleteMany({
        where: {
          userId: targetUserId,
          type: TokenType.PASSWORD_RESET,
        },
      }),
    ]);

    return { ok: true, email: target.email, letUserChoose: false };
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

    return { ok: true, email: target.email };
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