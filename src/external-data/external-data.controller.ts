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
  getRankDistribution(@Query('region') region?: string) {
    return this.externalDataService.getRankDistribution(region);
  }

  @Get('playerbase')
  getPlayerbase() {
    return this.externalDataService.getPlayerbaseOverview();
  }

  @Get('player/:accountId/summary')
  getPlayerSummary(@Param('accountId') accountId: string) {
    return this.externalDataService.getPlayerSummary(accountId);
  }

  @Get('leaderboard/:region')
  getLeaderboard(
    @Param('region') region: string,
    @Query('heroId') heroId?: string,
    @Query('heroIds') heroIds?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('tier') tier?: string,
    @Query('search') search?: string,
  ) {
    const parsedHeroIds = (heroIds ? heroIds.split(',') : heroId ? [heroId] : [])
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 3);
    const parsedPage = page ? Number(page) : undefined;
    const parsedLimit = limit ? Number(limit) : undefined;
    const parsedTier = tier ? Number(tier) : undefined;
    return this.externalDataService.getLeaderboard(
      region,
      parsedHeroIds,
      parsedPage,
      parsedLimit,
      parsedTier,
      search,
    );
  }

  @Get('matches/:matchId')
  getMatchDetail(@Param('matchId') matchId: string) {
    return this.externalDataService.getMatchDetail(matchId);
  }
}