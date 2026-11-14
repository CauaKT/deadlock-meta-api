import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TierListsController } from './tier-lists.controller';
import { TierListsService } from './tier-lists.service';

@Module({
  imports: [AuthModule],
  controllers: [TierListsController],
  providers: [TierListsService],
})
export class TierListsModule {}