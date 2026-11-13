import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from './auth.types';
import type { AuthenticatedUser } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import {
  EmailOnlyDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private sessionCookieOptions(): CookieOptions {
    const isHttps =
      this.config.get<string>('NODE_ENV') === 'production' ||
      (this.config.get<string>('APP_URL') ?? '').startsWith('https://');

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

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto);
    if (!result.requiresEmailVerification) {
      res.cookie(SESSION_COOKIE_NAME, result.accessToken, this.sessionCookieOptions());
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: SessionUserView }> {
    const { accessToken, user } = await this.authService.login(dto);
    res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
    return { user };
  }

  @HttpCode(HttpStatus.OK)
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(SESSION_COOKIE_NAME, this.clearCookieOptions());
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
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    let parsed: { state?: string; next?: string };
    try {
      parsed = JSON.parse(rawCookie) as { state?: string; next?: string };
    } catch {
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    if (!parsed.state || parsed.state !== state) {
      res.redirect(`${front}/login?error=auth-callback-failed`);
      return;
    }

    try {
      const { accessToken, needsOnboarding } = await this.authService.handleGoogleCallback(code);
      res.cookie(SESSION_COOKIE_NAME, accessToken, this.sessionCookieOptions());
      const safeNext =
        parsed.next && parsed.next.startsWith('/') && !parsed.next.startsWith('//')
          ? parsed.next
          : '/';
      res.redirect(needsOnboarding ? `${front}/welcome` : `${front}${safeNext}`);
    } catch {
      res.redirect(`${front}/login?error=auth-callback-failed`);
    }
  }
}