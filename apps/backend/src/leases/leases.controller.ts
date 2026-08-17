import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
 */
@Controller('profiles/:id/lease')
@UseGuards(JwtAuthGuard)
export class LeasesController {
  constructor(private readonly leases: LeasesService) {}

  /** The current holder, or null when the profile is free to launch. */
  @Get()
  async current(@Param('id') id: string): Promise<ApiResponse<ProfileLease | null>> {
    return ok(await this.leases.current(id));
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
      await this.leases.acquire(id, user.id, dto.deviceId, dto.deviceLabel ?? dto.deviceId),
    );
  }

  /** Extend while the browser runs. 409 once the lease has been taken over. */
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Param('id') id: string,
    @Body() dto: LeaseIdDto,
  ): Promise<ApiResponse<ProfileLease>> {
    return ok(await this.leases.refresh(id, dto.leaseId));
  }

  @Delete()
  @HttpCode(200)
  async release(
    @Param('id') id: string,
    @Body() dto: LeaseIdDto,
  ): Promise<ApiResponse<{ released: true }>> {
    await this.leases.release(id, dto.leaseId);
    return ok({ released: true as const });
  }
}
