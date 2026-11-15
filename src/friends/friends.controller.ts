import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SendFriendRequestDto, UpdateFriendsPrivacyDto } from './dto/friends.dto';
import { FriendsService } from './friends.service';

@Controller('friends')
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getOwn(@CurrentUser() user: AuthenticatedUser) {
    return this.friendsService.getOverview(user.userId);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('by-handle/:handle')
  async getByHandle(
    @Param('handle') handle: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.friendsService.getPublicByHandle(handle, user?.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('requests')
  async sendRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SendFriendRequestDto,
  ) {
    return this.friendsService.sendRequest(user.userId, dto.targetUserId);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('requests/:id/accept')
  async acceptRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.friendsService.acceptRequest(id, user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Delete(':id')
  async removeFriendship(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.friendsService.removeFriendship(id, user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('privacy')
  async updatePrivacy(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateFriendsPrivacyDto,
  ) {
    return this.friendsService.updatePrivacy(user.userId, dto.friendsPublic);
  }
}