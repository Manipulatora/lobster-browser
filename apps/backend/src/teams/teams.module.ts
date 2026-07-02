import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

/**
 * Imports AuthModule for the shared `JwtAuthGuard`, `USERS_REPOSITORY`, and `TEAMS_REPOSITORY`
 * singletons — so team endpoints read the same in-memory/Prisma store that auth writes to at
 * register time.
 */
@Module({
  imports: [AuthModule],
  controllers: [TeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
