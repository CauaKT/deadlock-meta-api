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
import { Role } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import {
  CreateTournamentDto,
  PlacePickDto,
  UpdateMatchResultDto,
} from './dto/tournaments.dto';
import { TournamentsService } from './tournaments.service';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournamentsService: TournamentsService) {}

  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser | undefined) {
    return this.tournamentsService.listAll(user?.userId);
  }

  @Get('pickem-leaderboard')
  leaderboard() {
    return this.tournamentsService.getPickemLeaderboard();
  }

  @UseGuards(JwtAuthGuard)
  @Post('matches/:matchId/pick')
  placePick(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PlacePickDto,
  ) {
    return this.tournamentsService.placePick(user.userId, matchId, dto.pickedTeam);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Post()
  create(@Body() dto: CreateTournamentDto) {
    return this.tournamentsService.createTournament(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Patch('matches/:matchId')
  updateMatch(
    @Param('matchId', ParseUUIDPipe) matchId: string,
    @Body() dto: UpdateMatchResultDto,
  ) {
    return this.tournamentsService.updateMatchResult(matchId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tournamentsService.deleteTournament(id);
  }
}