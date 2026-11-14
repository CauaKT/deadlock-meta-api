import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  OnboardingDto,
  UpdateProfileLookDto,
  UpdateProfileSettingsDto,
} from './dto/profiles.dto';
import { ProfilesService } from './profiles.service';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.getOwnProfile(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Put('onboarding')
  async onboarding(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OnboardingDto,
  ) {
    return this.profilesService.completeOnboarding(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/look')
  async updateLook(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileLookDto,
  ) {
    return this.profilesService.updateLook(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileSettingsDto,
  ) {
    return this.profilesService.updateSettings(user.userId, dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('community')
  async community(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const parsed = limit ? Number(limit) : 8;
    return this.profilesService.getCommunity(
      user?.userId,
      Number.isFinite(parsed) ? parsed : 8,
      search,
    );
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('by-handle/:handle')
  async byHandle(@Param('handle') handle: string) {
    return this.profilesService.getByHandle(handle);
  }
}