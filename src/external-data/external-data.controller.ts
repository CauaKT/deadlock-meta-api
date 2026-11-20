import { Controller, Get, Param, Query } from '@nestjs/common';
import { ExternalDataService } from './external-data.service';

@Controller('external-data')
export class ExternalDataController {
  constructor(private readonly externalDataService: ExternalDataService) {}

  @Get('status')
  getStatus() {
    return this.externalDataService.getStatus();
  }

  @Get('rank-distribution')
  getRankDistribution() {
    return this.externalDataService.getRankDistribution();
  }

  @Get('player/:accountId/summary')
  getPlayerSummary(@Param('accountId') accountId: string) {
    return this.externalDataService.getPlayerSummary(accountId);
  }

  @Get('leaderboard/:region')
  getLeaderboard(
    @Param('region') region: string,
    @Query('heroId') heroId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedHeroId = heroId ? Number(heroId) : undefined;
    const parsedPage = page ? Number(page) : undefined;
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.externalDataService.getLeaderboard(
      region,
      parsedHeroId,
      parsedPage,
      parsedLimit,
    );
  }

  @Get('matches/:matchId')
  getMatchDetail(@Param('matchId') matchId: string) {
    return this.externalDataService.getMatchDetail(matchId);
  }
}