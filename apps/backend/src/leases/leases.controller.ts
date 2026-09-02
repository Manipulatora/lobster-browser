import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';

import { LeasesService } from './leases.service';
import type { ProfileLease } from './leases.repository';

class AcquireLeaseDto {
  /** Stable per-install id, so the UI can name the machine holding a profile. */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  deviceId!: string;

  /** Human label for that machine ("Ivy's laptop"). Shown in the refusal message. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceLabel?: string;
}

class LeaseIdDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  leaseId!: string;
}

/**
 * Who currently has a profile open.
 *
 * A profile is one browser identity; running it from two machines means the same account arriving
 * from two IPs, which is the signal an anti-detect profile exists to avoid. Acquire therefore REFUSES
 * rather than queues, matching Octo — "you can work with it in turns".
 *
 * Every route is scoped to a profile the caller's own teams own; a profile they cannot see reads as
 * missing. See {@link LeasesService.assertVisible}.
 */
/** The presence view: every live lease on a profile the caller can see. */
@Controller('leases')
export class LeasesListController {
  constructor(private readonly leases: LeasesService) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<ApiResponse<ProfileLease[]>> {
    return ok(await this.leases.listVisible(user.id));
  }
}

@Controller('profiles/:id/lease')
export class LeasesController {
  constructor(private readonly leases: LeasesService) {}

  /** The current holder, or null when the profile is free to launch. */
  @Get()
  async current(
    @CurrentUser() user: User,
    @Param('id') id: string,
  ): Promise<ApiResponse<ProfileLease | null>> {
    return ok(await this.leases.current(user.id, id));
  }

  /** Claim it. 409 with the holder's device name when someone else has it. */
  @Post()
  @HttpCode(200)
  async acquire(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AcquireLeaseDto,
  ): Promise<ApiResponse<ProfileLease>> {
    return ok(
      await this.leases.acquire(user.id, id, dto.deviceId, dto.deviceLabel ?? dto.deviceId),
    );
  }

  /** Extend while the browser runs. 409 once the lease has been taken over. */
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: LeaseIdDto,
  ): Promise<ApiResponse<ProfileLease>> {
    return ok(await this.leases.refresh(user.id, id, dto.leaseId));
  }

  @Delete()
  @HttpCode(200)
  async release(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: LeaseIdDto,
  ): Promise<ApiResponse<{ released: true }>> {
    await this.leases.release(user.id, id, dto.leaseId);
    return ok({ released: true as const });
  }
}
