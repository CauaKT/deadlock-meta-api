import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BuildsController } from './builds.controller';
import { BuildsService } from './builds.service';

@Module({
  imports: [AuthModule],
  controllers: [BuildsController],
  providers: [BuildsService],
})
export class BuildsModule {}