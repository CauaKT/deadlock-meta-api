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
import { CreateTierListDto, UpdateTierListDto } from './dto/tier-lists.dto';
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
  ) {
    return this.tierListsService.findAll(user, userId, handle);
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
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tierListsService.remove(id, user);
  }
}