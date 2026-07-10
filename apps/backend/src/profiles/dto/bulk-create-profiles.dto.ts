import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ENGINE_KINDS, PROFILE_OS_TARGETS } from '@lobster/shared-types';
import type { EngineKind, ProfileOsTarget } from '@lobster/shared-types';

/** Upper bound on a single bulk-create call (also guards against accidental huge batches). */
export const MAX_BULK_CREATE = 50;

/**
 * Body for POST /profiles/bulk — create many profiles at once, each with its OWN unique seed (never a
 * shared identity). Every profile is named `${namePrefix} ${n}` (1-based). The whole batch is checked
 * against the team's plan limit up front, so a batch that would exceed the limit is rejected wholesale.
 */
export class BulkCreateProfilesDto {
  @IsInt()
  @Min(1)
  @Max(MAX_BULK_CREATE)
  count!: number;

  @IsString()
  @MaxLength(100)
  namePrefix!: string;

  @IsIn([...ENGINE_KINDS])
  engine!: EngineKind;

  @IsIn([...PROFILE_OS_TARGETS])
  os!: ProfileOsTarget;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  folder?: string;
}
