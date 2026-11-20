import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateLfgDto } from './dto/lfg.dto';
import { LfgService } from './lfg.service';

@Controller('lfg')
export class LfgController {
  constructor(private readonly lfgService: LfgService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('region') region?: string,
    @Query('rankTier') rankTier?: string,
    @Query('mode') mode?: string,
    @Query('heroId') heroId?: string,
  ) {
    return this.lfgService.findAll(user, {
      region,
      rankTier,
      mode,
      heroId: heroId ? Number(heroId) : undefined,
    });
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLfgDto) {
    return this.lfgService.create(user, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.lfgService.remove(id, user);
  }
}