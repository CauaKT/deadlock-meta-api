import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateTierListCommentDto,
  CreateTierListDto,
  UpdateTierListDto,
} from './dto/tier-lists.dto';
import { TierListsService } from './tier-lists.service';

@Controller('tier-lists')
export class TierListsController {
  constructor(private readonly tierListsService: TierListsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async findAll(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('userId') userId?: string,
    @Query('handle') handle?: string,
    @Query('style') style?: string,
    @Query('sort') sort?: string,
    @Query('search') search?: string,
    @Query('heroId') heroId?: string,
    @Query('likedByMe') likedByMe?: string,
  ) {
    const parsedHeroId = heroId ? Number(heroId) : undefined;
    return this.tierListsService.findAll(user, {
      userId,
      handle,
      style,
      sort,
      search,
      heroId: parsedHeroId && Number.isInteger(parsedHeroId) ? parsedHeroId : undefined,
      likedByMe: likedByMe === '1' || likedByMe === 'true',
    });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id/comments')
  async getComments(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.tierListsService.getComments(id, user);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.tierListsService.findOne(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTierListDto,
  ) {
    return this.tierListsService.create(user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/like')
  async toggleLike(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tierListsService.toggleLike(id, user);
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post(':id/view')
  async recordView(@Param('id', ParseUUIDPipe) id: string) {
    return this.tierListsService.recordView(id);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/comments')
  async addComment(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTierListCommentDto,
  ) {
    return this.tierListsService.addComment(id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateTierListDto,
  ) {
    return this.tierListsService.update(id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Delete('comments/:commentId')
  async removeComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tierListsService.removeComment(commentId, user);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 15, ttl: 60000 } })
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tierListsService.remove(id, user);
  }
}