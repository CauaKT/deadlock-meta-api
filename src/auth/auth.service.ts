import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, TokenType } from '@prisma/client';
import type { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { ModerationService } from '../moderation/moderation.service';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload, SavedAccountView } from './auth.types';

const MAX_SAVED_ACCOUNTS = 5;
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
  mustChangePassword: boolean;
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly moderation: ModerationService,
  ) {}

  private requireEmailVerification(): boolean {
    return this.config.get<string>('REQUIRE_EMAIL_VERIFICATION') === 'true';
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

  private async signSessionJwt(
    userId: string,
    role: Role,
    sessionVersion: number,
  ): Promise<string> {
    const payload: JwtPayload = { sub: userId, role, sv: sessionVersion };
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

    await this.moderation.assertSafeContent({ texts: [dto.username] });

    const passwordHash = await bcrypt.hash(dto.password, 12);
    const requireVerify = this.requireEmailVerification();

    let createdUser: SessionUserView;
    try {
      createdUser = await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          emailVerified: false,
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
          mustChangePassword: true,
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

    try {
      const rawToken = await this.issueToken(createdUser.id, TokenType.EMAIL_VERIFY, 24);
      const verifyUrl = `${this.getPublicApiUrl()}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
      await this.mail.sendVerificationEmail(createdUser.email, verifyUrl);
    } catch (err) {
      this.logger.error(
        `Falha ao enviar e-mail de verificação para ${createdUser.email}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (requireVerify) {
        await this.prisma.user.delete({ where: { id: createdUser.id } }).catch(() => {});
        throw new ServiceUnavailableException(
          'Não foi possível enviar o e-mail de confirmação. Tente novamente em instantes.',
        );
      }
    }

    if (requireVerify) {
      return {
        requiresEmailVerification: true,
        message:
          'Conta criada com sucesso! Verifique seu e-mail para ativar sua conta antes de entrar.',
      };
    }

    const accessToken = await this.signSessionJwt(createdUser.id, createdUser.role, 1);
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
        mustChangePassword: true,
        sessionVersion: true,
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

    const accessToken = await this.signSessionJwt(user.id, user.role, user.sessionVersion);
    const { passwordHash: _removed, sessionVersion: _sv, ...userView } = user;
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
        mustChangePassword: true,
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

  async changeOwnPassword(
    userId: string,
    newPassword: string,
    currentPassword?: string,
  ): Promise<{ accessToken: string; user: SessionUserView }> {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, mustChangePassword: true },
    });
    if (!existing) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }
    if (existing.passwordHash && !existing.mustChangePassword) {
      if (!currentPassword) {
        throw new BadRequestException('Informe sua senha atual.');
      }
      const valid = await bcrypt.compare(currentPassword, existing.passwordHash);
      if (!valid) {
        throw new UnauthorizedException('Senha atual incorreta.');
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          mustChangePassword: false,
          sessionVersion: { increment: 1 },
        },
        select: {
          id: true,
          email: true,
          role: true,
          emailVerified: true,
          mustChangePassword: true,
          sessionVersion: true,
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
      }),
      this.prisma.authToken.deleteMany({
        where: { userId, type: TokenType.PASSWORD_RESET },
      }),
    ]);

    const accessToken = await this.signSessionJwt(
      updated.id,
      updated.role,
      updated.sessionVersion,
    );
    const { sessionVersion: _sv, ...userView } = updated;
    return { accessToken, user: userView };
  }

  async deleteOwnAccount(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }

    if (user.role === 'ADMIN') {
      const adminCount = await this.prisma.user.count({
        where: { role: 'ADMIN' },
      });
      if (adminCount <= 1) {
        throw new BadRequestException('Não é possível apagar a conta do último administrador.');
      }
    }

    await this.prisma.user.delete({ where: { id: userId } });
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
          sessionVersion: { increment: 1 },
        },
      }),
      this.prisma.authToken.deleteMany({
        where: { userId: record.userId, type: TokenType.PASSWORD_RESET },
      }),
    ]);

    return { ok: true, message: 'Senha redefinida com sucesso!' };
  }

  private emailChangeHash(userId: string, newEmail: string, code: string): string {
    return crypto.createHash('sha256').update(`${userId}:${newEmail}:${code}`).digest('hex');
  }

  async requestEmailChange(
    userId: string,
    newEmail: string,
    password: string,
  ): Promise<{ ok: true; message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, mustChangePassword: true },
    });
    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado.');
    }
    if (!user.passwordHash || user.mustChangePassword) {
      throw new BadRequestException(
        'Defina uma senha para a sua conta antes de trocar o e-mail.',
      );
    }
    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedException('Senha incorreta.');
    }
    if (newEmail === user.email) {
      throw new BadRequestException('Este já é o e-mail atual da sua conta.');
    }

    const taken = await this.prisma.user.findUnique({
      where: { email: newEmail },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException('Este e-mail já está em uso por outra conta.');
    }

    const last = await this.prisma.authToken.findFirst({
      where: { userId, type: TokenType.EMAIL_CHANGE },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < 60_000) {
      throw new BadRequestException('Aguarde um minuto para pedir um novo código.');
    }

    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const tokenHash = this.emailChangeHash(userId, newEmail, code);

    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, type: TokenType.EMAIL_CHANGE } }),
      this.prisma.authToken.create({
        data: {
          userId,
          type: TokenType.EMAIL_CHANGE,
          tokenHash,
          payload: newEmail,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      }),
    ]);

    try {
      await this.mail.sendEmailChangeCode(newEmail, code);
    } catch (err) {
      this.logger.error(
        `Falha ao enviar código de troca de e-mail: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma.authToken
        .deleteMany({ where: { userId, type: TokenType.EMAIL_CHANGE } })
        .catch(() => {});
      throw new ServiceUnavailableException(
        'Não foi possível enviar o código. Tente novamente em instantes.',
      );
    }

    return {
      ok: true,
      message: 'Enviamos um código de 6 dígitos para o novo e-mail. Ele vale por 15 minutos.',
    };
  }

  async confirmEmailChange(
    userId: string,
    code: string,
  ): Promise<{ accessToken: string; user: SessionUserView }> {
    const record = await this.prisma.authToken.findFirst({
      where: { userId, type: TokenType.EMAIL_CHANGE },
    });
    if (!record || !record.payload || record.expiresAt < new Date()) {
      throw new BadRequestException('Código inválido ou expirado. Peça um novo código.');
    }
    if (record.attempts >= 5) {
      await this.prisma.authToken.deleteMany({ where: { userId, type: TokenType.EMAIL_CHANGE } });
      throw new BadRequestException('Muitas tentativas. Peça um novo código.');
    }

    const expected = Buffer.from(this.emailChangeHash(userId, record.payload, code));
    const stored = Buffer.from(record.tokenHash);
    if (expected.length !== stored.length || !crypto.timingSafeEqual(expected, stored)) {
      await this.prisma.authToken.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Código incorreto.');
    }

    const oldEmail = (
      await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
    )?.email;

    let updated;
    try {
      [updated] = await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: {
            email: record.payload,
            emailVerified: true,
            sessionVersion: { increment: 1 },
          },
          select: {
            id: true,
            email: true,
            role: true,
            emailVerified: true,
            mustChangePassword: true,
            sessionVersion: true,
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
        }),
        this.prisma.authToken.deleteMany({
          where: {
            userId,
            type: { in: [TokenType.EMAIL_CHANGE, TokenType.EMAIL_VERIFY] },
          },
        }),
      ]);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Este e-mail já está em uso por outra conta.');
      }
      throw err;
    }

    if (oldEmail && oldEmail !== updated.email) {
      this.mail.sendEmailChangedNotice(oldEmail, updated.email).catch(() => {});
    }

    const { sessionVersion, ...userView } = updated;
    const accessToken = await this.signSessionJwt(updated.id, updated.role, sessionVersion);
    return { accessToken, user: userView };
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
      const errBody = await tokenRes.text().catch(() => '');
      throw new UnauthorizedException(
        `Falha ao trocar código com o Google (${tokenRes.status}): ${errBody}`,
      );
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

    // Conta com senha e e-mail não confirmado pode ser de quem cadastrou o e-mail de terceiro: recriar derruba a senha e a sessão dele
    if (user && !user.googleId && !user.emailVerified && user.passwordHash && user.role === 'USER') {
      await this.prisma.$transaction([
        this.prisma.tierList.deleteMany({ where: { userId: user.id } }),
        this.prisma.user.delete({ where: { id: user.id } }),
      ]);
      user = null;
    }

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

    const accessToken = await this.signSessionJwt(
      user.id,
      user.role,
      user.sessionVersion,
    );
    const needsOnboarding =
      !user.profile ||
      !user.profile.username ||
      user.profile.username.trim() === '' ||
      !user.profile.handle;

    return { accessToken, needsOnboarding };
  }

  private async verifyAccountTokens(tokens: string[]): Promise<{
    validEntries: Array<{
      token: string;
      user: {
        id: string;
        email: string;
        sessionVersion: number;
        profile: {
          username: string | null;
          handle: string | null;
          avatarUrl: string | null;
        } | null;
      };
    }>;
    validTokens: string[];
  }> {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    const seenSubs = new Set<string>();
    const decoded: Array<{ token: string; sub: string; sv: number }> = [];

    for (const token of tokens) {
      if (typeof token !== 'string' || token.length === 0) continue;
      try {
        const payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret });
        if (!payload?.sub || typeof payload.sv !== 'number' || seenSubs.has(payload.sub)) {
          continue;
        }
        seenSubs.add(payload.sub);
        decoded.push({ token, sub: payload.sub, sv: payload.sv });
      } catch {
        // Ignora tokens expirados ou inválidos
      }
    }

    if (decoded.length === 0) {
      return { validEntries: [], validTokens: [] };
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: decoded.map((d) => d.sub) } },
      select: {
        id: true,
        email: true,
        sessionVersion: true,
        profile: {
          select: {
            username: true,
            handle: true,
            avatarUrl: true,
          },
        },
      },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    const validEntries: Array<{
      token: string;
      user: (typeof users)[number];
    }> = [];

    for (const item of decoded) {
      const user = byId.get(item.sub);
      if (user && user.sessionVersion === item.sv) {
        validEntries.push({ token: item.token, user });
      }
    }

    return {
      validEntries,
      validTokens: validEntries.map((e) => e.token),
    };
  }

  async mergeAccountToken(existingTokens: string[], newToken: string): Promise<string[]> {
    const { validTokens } = await this.verifyAccountTokens([newToken, ...existingTokens]);
    return validTokens.slice(0, MAX_SAVED_ACCOUNTS);
  }

  async removeAccountToken(existingTokens: string[], targetUserId: string): Promise<string[]> {
    const { validEntries } = await this.verifyAccountTokens(existingTokens);
    return validEntries
      .filter((entry) => entry.user.id !== targetUserId)
      .map((entry) => entry.token);
  }

  async listSavedAccounts(
    tokens: string[],
    activeUserId?: string,
  ): Promise<{ accounts: SavedAccountView[]; validTokens: string[] }> {
    const { validEntries, validTokens } = await this.verifyAccountTokens(tokens);
    return {
      validTokens,
      accounts: validEntries.map((entry) => ({
        id: entry.user.id,
        email: entry.user.email,
        username: entry.user.profile?.username ?? null,
        handle: entry.user.profile?.handle ?? null,
        avatarUrl: entry.user.profile?.avatarUrl ?? null,
        isCurrent: entry.user.id === activeUserId,
      })),
    };
  }

  async resolveSwitchToken(tokens: string[], targetUserId: string): Promise<string> {
    const { validEntries } = await this.verifyAccountTokens(tokens);
    const match = validEntries.find((entry) => entry.user.id === targetUserId);
    if (!match) {
      throw new UnauthorizedException(
        'A sessão desta conta expirou ou foi revogada. Faça login novamente.',
      );
    }
    return match.token;
  }
}