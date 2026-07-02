import { IsIn, IsOptional } from 'class-validator';
import type { SyncDirection } from '../profiles.service';

/**
 * Body for POST /profiles/:id/sync. `direction` is validated so only the two known modes are
 * accepted — anything else is a 400 at the boundary rather than a silently-ignored value.
 * When omitted the service defaults to `'push'` (see ProfilesController.sync).
 */
export class SyncProfileDto {
  @IsOptional()
  @IsIn(['push', 'pull'] satisfies SyncDirection[])
  direction?: SyncDirection;
}
