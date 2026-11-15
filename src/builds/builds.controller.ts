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
import { BuildsService } from './builds.service';
import { CreateBuildDto, UpdateBuildDto } from './dto/builds.dto';

@Controller('builds')
export class BuildsController {
  constructor(private readonly buildsService: BuildsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  async findAll(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('heroId') heroId?: string,
    @Query('userId') userId?: string,
    @Query('handle') handle?: string,
  ) {
    const parsedHero = heroId && /^\d+$/.test(heroId) ? Number(heroId) : undefined;
    return this.buildsService.findAll(user, { heroId: parsedHero, userId, handle });
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ) {
    return this.buildsService.findOne(id, user);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBuildDto,
  ) {
    return this.buildsService.create(user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBuildDto,
  ) {
    return this.buildsService.update(id, user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.buildsService.remove(id, user);
  }
}