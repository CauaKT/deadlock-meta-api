import { Controller, Get, Param, Query } from '@nestjs/common';
import { ExternalDataService } from './external-data.service';

@Controller('external-data')
export class ExternalDataController {
  constructor(private readonly externalDataService: ExternalDataService) {}

  @Get('status')
  getStatus() {
    return this.externalDataService.getStatus();
  }

  @Get('player/:accountId/summary')
  getPlayerSummary(@Param('accountId') accountId: string) {
    return this.externalDataService.getPlayerSummary(accountId);
  }

  @Get('leaderboard/:region')
  getLeaderboard(
    @Param('region') region: string,
    @Query('heroId') heroId?: string,
  ) {
    const parsedHeroId = heroId ? Number(heroId) : undefined;
    return this.externalDataService.getLeaderboard(region, parsedHeroId);
  }

  @Get('matches/:matchId')
  getMatchDetail(@Param('matchId') matchId: string) {
    return this.externalDataService.getMatchDetail(matchId);
  }
}