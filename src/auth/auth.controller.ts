import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import crypto from 'node:crypto';
import { AuthService } from './auth.service';
import type { SessionUserView } from './auth.service';
import {
  ACCOUNTS_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './auth.types';
import type { AuthenticatedUser, SavedAccountView } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  ChangePasswordDto,
  ConfirmEmailChangeDto,
  EmailOnlyDto,
  LoginDto,
  RegisterDto,
  RequestEmailChangeDto,
  ResetPasswordDto,
  SwitchAccountDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { JwtAuthGuard, OptionalJwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private sessionCookieOptions(): CookieOptions {
    const isHttps =
      this.config.get<string>('NODE_ENV') === 'production' ||
      (this.config.get<string>('APP_URL') ?? '').startsWith('https://') ||
      (this.config.get<string>('FRONTEND_URL') ?? '').startsWith('https://');

    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: isHttps,
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    };
  }

  private clearCookieOptions(): CookieOptions {
    const { maxAge: _ignored, ...rest } = this.sessionCookieOptions();
    return rest;
  }

  private readAccountTokens(req: Request): string[] {
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const raw = cookies?.[ACCOUNTS_COOKIE_NAME];
    if (typeof raw !== 'string' || !raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    } catch {
      return [];
    }
  }

  private writeAccountsCookie(res: Response, tokens: string[]): void {
    if (tokens.length === 0) {
      res.clearCookie(ACCOUNTS_COOKIE_NAME, this.clearCookieOptions());
      return;
    }
    res.cookie(ACCOUNTS_COOKIE_NAME, JSON.stringify(tokens), this.sessionCookieOptions());
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto);
    if (!result.requiresEmailVerification) {
      res.cookie(SESSION_COOKIE_NAME, result.accessToken, this.sessionCookieOptions());
      const updated = await this.authService.mergeAccountToken(
        this.readAccountTokens(req),
        result.accessToken,
      );
      this.writeAccountsCookie(res, updated);
      return {
        requiresEmailVerification: false,
        user: result.user,
      };
    }
    return result;
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUserView }> {
    const { accessToken, user } = await this.authService.login(dto);
    res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
    const updated = await this.authService.mergeAccountToken(
      this.readAccountTokens(req),
      accessToken,
    );
    this.writeAccountsCookie(res, updated);
    return { user };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('keepAccount') keepAccount: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    res.clearCookie(SESSION_COOKIE_NAME, this.clearCookieOptions());
    if (user && keepAccount !== '1') {
      const updated = await this.authService.removeAccountToken(
        this.readAccountTokens(req),
        user.userId,
      );
      this.writeAccountsCookie(res, updated);
    }
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('accounts')
  async accounts(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accounts: SavedAccountView[] }> {
    const currentTokens = this.readAccountTokens(req);
    const { accounts, validTokens } = await this.authService.listSavedAccounts(
      currentTokens,
      user.userId,
    );
    if (validTokens.length !== currentTokens.length) {
      this.writeAccountsCookie(res, validTokens);
    }
    return { accounts };
  }

  @HttpCode(HttpStatus.OK)
  @Post('switch-account')
  async switchAccount(
    @Body() dto: SwitchAccountDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = await this.authService.resolveSwitchToken(
      this.readAccountTokens(req),
      dto.userId,
    );
    res.cookie(SESSION_COOKIE_NAME, token, this.sessionCookieOptions());
    return { ok: true };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('accounts/remove')
  async removeAccount(
    @Body() dto: SwitchAccountDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true; removedCurrent: boolean }> {
    const updated = await this.authService.removeAccountToken(
      this.readAccountTokens(req),
      dto.userId,
    );
    this.writeAccountsCookie(res, updated);
    const removedCurrent = user?.userId === dto.userId;
    if (removedCurrent) {
      res.clearCookie(SESSION_COOKIE_NAME, this.clearCookieOptions());
    }
    return { ok: true, removedCurrent };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Delete('me')
  async deleteMe(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    await this.authService.deleteOwnAccount(user.userId);
    res.clearCookie(SESSION_COOKIE_NAME, this.clearCookieOptions());
    const updated = await this.authService.removeAccountToken(
      this.readAccountTokens(req),
      user.userId,
    );
    this.writeAccountsCookie(res, updated);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<{ user: SessionUserView }> {
    const sessionUser = await this.authService.getSessionUser(user.userId);
    return { user: sessionUser };
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('verify-email')
  async verifyEmailPost(@Body() dto: VerifyEmailDto): Promise<{ ok: true; message: string }> {
    await this.authService.verifyEmailToken(dto.token);
    return { ok: true, message: 'E-mail confirmado com sucesso!' };
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Get('verify-email')
  async verifyEmailGet(
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const front = this.authService.getFrontendUrl();
    if (!token || token.trim().length < 16) {
      res.redirect(`${front}/login?error=invalid-verification-token`);
      return;
    }
    try {
      await this.authService.verifyEmailToken(token.trim());
      res.redirect(`${front}/login?verified=1`);
    } catch {
      res.redirect(`${front}/login?error=invalid-verification-token`);
    }
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('resend-verification')
  async resendVerification(@Body() dto: EmailOnlyDto) {
    return this.authService.resendVerification(dto);
  }

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: EmailOnlyDto) {
    return this.authService.forgotPassword(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUserView }> {
    const { accessToken, user: updatedUser } = await this.authService.changeOwnPassword(
      user.userId,
      dto.newPassword,
      dto.currentPassword,
    );
    res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
    const updated = await this.authService.mergeAccountToken(
      this.readAccountTokens(req),
      accessToken,
    );
    this.writeAccountsCookie(res, updated);
    return { user: updatedUser };
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('email-change/request')
  async requestEmailChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RequestEmailChangeDto,
  ): Promise<{ ok: true; message: string }> {
    return this.authService.requestEmailChange(user.userId, dto.newEmail, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post('email-change/confirm')
  async confirmEmailChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmEmailChangeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUserView }> {
    const { accessToken, user: updatedUser } = await this.authService.confirmEmailChange(
      user.userId,
      dto.code,
    );
    res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
    const updated = await this.authService.mergeAccountToken(
      this.readAccountTokens(req),
      accessToken,
    );
    this.writeAccountsCookie(res, updated);
    return { user: updatedUser };
  }

  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Get('google')
  googleAuth(@Query('next') next: string | undefined, @Res() res: Response): void {
    const front = this.authService.getFrontendUrl();
    const state = crypto.randomBytes(24).toString('hex');
    const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

    const url = this.authService.buildGoogleAuthorizeUrl(state);
    if (!url) {
      res.redirect(`${front}/login?error=google-not-configured`);
      return;
    }

    res.cookie(
      OAUTH_STATE_COOKIE_NAME,
      JSON.stringify({ state, next: safeNext }),
      {
        ...this.clearCookieOptions(),
        maxAge: 10 * 60 * 1000,
      },
    );
    res.redirect(url);
  }

  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const front = this.authService.getFrontendUrl();
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const rawCookie = cookies?.[OAUTH_STATE_COOKIE_NAME];
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, this.clearCookieOptions());

    if (!code || !state || typeof rawCookie !== 'string') {
      this.logger.warn(
        `Google callback inválido: hasCode=${Boolean(code)} hasState=${Boolean(state)} hasCookie=${typeof rawCookie === 'string'}`,
      );
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    let parsed: { state?: string; next?: string };
    try {
      parsed = JSON.parse(rawCookie) as { state?: string; next?: string };
    } catch {
      this.logger.warn('Google callback falhou: cookie OAuth state malformado');
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    if (!parsed.state || parsed.state !== state) {
      this.logger.warn('Google callback falhou: state mismatch');
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    try {
      const { accessToken, needsOnboarding } = await this.authService.handleGoogleCallback(code);
      res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
      const updated = await this.authService.mergeAccountToken(
        this.readAccountTokens(req),
        accessToken,
      );
      this.writeAccountsCookie(res, updated);
      const safeNext =
        parsed.next && parsed.next.startsWith('/') && !parsed.next.startsWith('//')
          ? parsed.next
          : '/';
      res.redirect(needsOnboarding ? `${front}/welcome` : `${front}${safeNext}`);
    } catch (err) {
      this.logger.warn(
        `Google callback exceção: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.redirect(`${front}/login?error=auth-callback-failed`);
    }
  }
}