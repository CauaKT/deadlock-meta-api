import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TokenType } from '@prisma/client';
import type { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from './auth.types';
import type {
  EmailOnlyDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

interface GoogleTokenResponse {
  access_token?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface SessionUserView {
  id: string;
  email: string;
  role: Role;
  emailVerified: boolean;
  createdAt: Date;
  profile: {
    username: string | null;
    handle: string | null;
    avatarUrl: string | null;
    favoriteHeroId: number | null;
  } | null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  private requireEmailVerification(): boolean {
    return this.config.get<string>('REQUIRE_EMAIL_VERIFICATION') !== 'false';
  }

  private getApiUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3001').replace(/\/+$/, '');
  }

  getFrontendUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
  }

  private getPublicApiUrl(): string {
    const explicit = this.config.get<string>('PUBLIC_API_URL')?.trim();
    if (explicit) {
      return explicit.replace(/\/+$/, '');
    }
    return `${this.getFrontendUrl()}/api/backend`;
  }

  private getGoogleRedirectUri(): string {
    const explicit = this.config.get<string>('GOOGLE_CALLBACK_URL')?.trim();
    if (explicit) {
      return explicit.replace(/\/+$/, '');
    }
    return `${this.getPublicApiUrl()}/auth/google/callback`;
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private async issueToken(userId: string, type: TokenType, ttlHours: number): Promise<string> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, type } }),
      this.prisma.authToken.create({
        data: { userId, type, tokenHash, expiresAt },
      }),
    ]);

    return rawToken;
  }

  private async signSessionJwt(userId: string, role: Role): Promise<string> {
    const payload: JwtPayload = { sub: userId, role };
    return this.jwt.signAsync(payload);
  }

  async register(dto: RegisterDto): Promise<
    | { requiresEmailVerification: true; message: string }
    | { requiresEmailVerification: false; accessToken: string; user: SessionUserView }
  > {
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (existingEmail) {
      throw new ConflictException('Este e-mail já está cadastrado. Tente fazer login.');
    }

    const existingNick = await this.prisma.profile.findFirst({
      where: { username: { equals: dto.username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existingNick) {
      throw new ConflictException('Este nick já está em uso. Escolha outro.');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const requireVerify = this.requireEmailVerification();

    let createdUser: SessionUserView;
    try {
      createdUser = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          emailVerified: !requireVerify,
          profile: {
            create: {
              username: dto.username,
            },
          },
        },
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
              avatarUrl: true,
              favoriteHeroId: true,
            },
          },
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('E-mail ou nick já está em uso.');
      }
      throw err;
    }

    if (requireVerify) {
      const rawToken = await this.issueToken(createdUser.id, TokenType.EMAIL_VERIFY, 24);
      const verifyUrl = `${this.getPublicApiUrl()}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
      await this.mail.sendVerificationEmail(createdUser.email, verifyUrl);
      return {
        requiresEmailVerification: true,
        message:
          'Conta criada com sucesso! Verifique seu e-mail para ativar sua conta antes de entrar.',
      };
    }

    const accessToken = await this.signSessionJwt(createdUser.id, createdUser.role);
    return {
      requiresEmailVerification: false,
      accessToken,
      user: createdUser,
    };
  }

  async login(dto: LoginDto): Promise<{ accessToken: string; user: SessionUserView }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        role: true,
        emailVerified: true,
        createdAt: true,
        profile: {
          select: {
            username: true,
            handle: true,
            avatarUrl: true,
            favoriteHeroId: true,
          },
        },
      },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    }

    const validPassword = await bcrypt.compare(dto.password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedException('E-mail ou senha incorretos.');
    }

    if (this.requireEmailVerification() && !user.emailVerified) {
      throw new ForbiddenException(
        'Seu e-mail ainda não foi confirmado. Verifique sua caixa de entrada.',
      );
    }

    const accessToken = await this.signSessionJwt(user.id, user.role);
    const { passwordHash: _removed, ...userView } = user;
    return { accessToken, user: userView };
  }

  async getSessionUser(userId: string): Promise<SessionUserView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
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
            avatarUrl: true,
            favoriteHeroId: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }

    return user;
  }

  async verifyEmailToken(rawToken: string): Promise<void> {
    const tokenHash = this.hashToken(rawToken);
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash },
    });

    if (!record || record.type !== TokenType.EMAIL_VERIFY || record.expiresAt < new Date()) {
      throw new BadRequestException('Link de verificação inválido ou expirado.');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true },
      }),
      this.prisma.authToken.deleteMany({
        where: { userId: record.userId, type: TokenType.EMAIL_VERIFY },
      }),
    ]);
  }

  async resendVerification(dto: EmailOnlyDto): Promise<{ ok: true; message: string }> {
    const generic = {
      ok: true as const,
      message: 'Se o e-mail estiver pendente de ativação, enviaremos um novo link.',
    };

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true, emailVerified: true },
    });

    if (!user || user.emailVerified) {
      return generic;
    }

    const rawToken = await this.issueToken(user.id, TokenType.EMAIL_VERIFY, 24);
    const verifyUrl = `${this.getPublicApiUrl()}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
    await this.mail.sendVerificationEmail(user.email, verifyUrl);

    return generic;
  }

  async forgotPassword(dto: EmailOnlyDto): Promise<{ ok: true; message: string }> {
    const generic = {
      ok: true as const,
      message: 'Se o e-mail estiver cadastrado, enviaremos as instruções de redefinição.',
    };

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true, email: true },
    });

    if (!user) {
      return generic;
    }

    const rawToken = await this.issueToken(user.id, TokenType.PASSWORD_RESET, 1);
    const resetUrl = `${this.getFrontendUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
    await this.mail.sendPasswordResetEmail(user.email, resetUrl);

    return generic;
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ ok: true; message: string }> {
    const tokenHash = this.hashToken(dto.token);
    const record = await this.prisma.authToken.findUnique({
      where: { tokenHash },
    });

    if (!record || record.type !== TokenType.PASSWORD_RESET || record.expiresAt < new Date()) {
      throw new BadRequestException('Token de redefinição inválido ou expirado.');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          emailVerified: true,
        },
      }),
      this.prisma.authToken.deleteMany({
        where: { userId: record.userId, type: TokenType.PASSWORD_RESET },
      }),
    ]);

    return { ok: true, message: 'Senha redefinida com sucesso!' };
  }

  buildGoogleAuthorizeUrl(state: string): string | null {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('GOOGLE_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) {
      return null;
    }

    const redirectUri = this.getGoogleRedirectUri();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleGoogleCallback(code: string): Promise<{
    accessToken: string;
    needsOnboarding: boolean;
  }> {
    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID').trim();
    const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET').trim();
    const redirectUri = this.getGoogleRedirectUri();

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      throw new UnauthorizedException('Falha ao trocar código com o Google.');
    }

    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenData.access_token) {
      throw new UnauthorizedException('Token do Google ausente.');
    }

    const userInfoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userInfoRes.ok) {
      throw new UnauthorizedException('Falha ao consultar dados da conta Google.');
    }

    const info = (await userInfoRes.json()) as GoogleUserInfo;
    if (!info.sub || !info.email || info.email_verified !== true) {
      throw new UnauthorizedException('Conta Google sem e-mail verificado.');
    }

    const email = info.email.trim().toLowerCase();
    const googleId = info.sub;

    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ googleId }, { email }],
      },
      include: { profile: true },
    });

    if (user) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: user.googleId ?? googleId,
          emailVerified: true,
          profile: user.profile
            ? undefined
            : {
                create: {
                  avatarUrl: info.picture ?? null,
                },
              },
        },
        include: { profile: true },
      });
    } else {
      user = await this.prisma.user.create({
        data: {
          email,
          googleId,
          emailVerified: true,
          profile: {
            create: {
              avatarUrl: info.picture ?? null,
            },
          },
        },
        include: { profile: true },
      });
    }

    const accessToken = await this.signSessionJwt(user.id, user.role);
    const needsOnboarding =
      !user.profile ||
      !user.profile.username ||
      user.profile.username.trim() === '' ||
      !user.profile.handle;

    return { accessToken, needsOnboarding };
  }
}