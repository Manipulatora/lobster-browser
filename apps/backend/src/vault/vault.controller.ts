import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsInt, IsString, Matches, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VaultService } from './vault.service';
import type { VaultEnrollmentRecord } from './vault.repository';

/** Argon2id cost the client used. Echoed back on read so an unlock uses the cost its wrap was made with. */
class ArgonCostDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  memoryKiB!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  iterations!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  parallelism!: number;
}

/**
 * Wrapped key material, submitted as base64.
 *
 * base64 rather than raw bytes because this rides JSON, and validated as strict base64 here so a
 * malformed field is a 400 at the boundary instead of a confusing length error deeper in the service.
 */
class EnrollVaultDto {
  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'passwordSalt must be base64' })
  passwordSalt!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'recoverySalt must be base64' })
  recoverySalt!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'wrappedByPassword must be base64' })
  wrappedByPassword!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9+/]+={0,2}$/, { message: 'wrappedByRecovery must be base64' })
  wrappedByRecovery!: string;

  @IsString()
  @Matches(/^[0-9a-f]{16,64}$/, { message: 'keyFingerprint must be lowercase hex' })
  keyFingerprint!: string;

  @ValidateNested()
  @Type(() => ArgonCostDto)
  argon!: ArgonCostDto;
}

/** The read shape: the same blobs, base64, plus the non-secret timestamps. */
interface VaultEnrollmentView {
  passwordSalt: string;
  recoverySalt: string;
  wrappedByPassword: string;
  wrappedByRecovery: string;
  keyFingerprint: string;
  argon: { memoryKiB: number; iterations: number; parallelism: number };
  enrolledAt: string;
  recoveryCodeUsedAt?: string;
  rotatedAt?: string;
}

/**
 * The user's own wrapped key material.
 *
 * Every route is scoped to the AUTHENTICATED caller — there is no `:userId` parameter anywhere, so
 * there is no route shape that could serve one user's wraps to another. The blobs are useless without
 * the password or the recovery code, but "useless without a secret" is not a reason to hand them out:
 * they are exactly the material an offline attack would want.
 */
@Controller('vault')
@UseGuards(JwtAuthGuard)
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  /** `data: null` when the caller has never enrolled, which is how a client knows to offer setup. */
  @Get()
  async get(@CurrentUser() user: User): Promise<ApiResponse<VaultEnrollmentView | null>> {
    const record = await this.vault.get(user.id);
    return ok(record ? this.toView(record) : null);
  }

  @Post('enroll')
  @HttpCode(201)
  async enroll(
    @CurrentUser() user: User,
    @Body() dto: EnrollVaultDto,
  ): Promise<ApiResponse<VaultEnrollmentView>> {
    return ok(this.toView(await this.vault.enroll(this.toInput(user.id, dto))));
  }

  /** Re-wrap the SAME key under new material. The fingerprint must match, or it is refused. */
  @Post('rotate')
  @HttpCode(200)
  async rotate(
    @CurrentUser() user: User,
    @Body() dto: EnrollVaultDto,
  ): Promise<ApiResponse<VaultEnrollmentView>> {
    return ok(this.toView(await this.vault.rotate(this.toInput(user.id, dto))));
  }

  /**
   * The client reporting that it recovered using the printed code.
   *
   * Advisory by construction: the server cannot verify a code it has no key for. It exists so support
   * and the UI can see the code has left its paper copy, and nothing authorises on it.
   */
  @Post('recovery-code-used')
  @HttpCode(200)
  async recoveryUsed(@CurrentUser() user: User): Promise<ApiResponse<{ noted: true }>> {
    await this.vault.noteRecoveryUsed(user.id);
    return ok({ noted: true as const });
  }

  private toInput(userId: string, dto: EnrollVaultDto) {
    return {
      userId,
      passwordSalt: Buffer.from(dto.passwordSalt, 'base64'),
      recoverySalt: Buffer.from(dto.recoverySalt, 'base64'),
      wrappedByPassword: Buffer.from(dto.wrappedByPassword, 'base64'),
      wrappedByRecovery: Buffer.from(dto.wrappedByRecovery, 'base64'),
      keyFingerprint: dto.keyFingerprint,
      argon: {
        memoryKiB: dto.argon.memoryKiB,
        iterations: dto.argon.iterations,
        parallelism: dto.argon.parallelism,
      },
    };
  }

  private toView(record: VaultEnrollmentRecord): VaultEnrollmentView {
    return {
      passwordSalt: record.passwordSalt.toString('base64'),
      recoverySalt: record.recoverySalt.toString('base64'),
      wrappedByPassword: record.wrappedByPassword.toString('base64'),
      wrappedByRecovery: record.wrappedByRecovery.toString('base64'),
      keyFingerprint: record.keyFingerprint,
      argon: record.argon,
      enrolledAt: record.enrolledAt,
      ...(record.recoveryCodeUsedAt ? { recoveryCodeUsedAt: record.recoveryCodeUsedAt } : {}),
      ...(record.rotatedAt ? { rotatedAt: record.rotatedAt } : {}),
    };
  }
}
