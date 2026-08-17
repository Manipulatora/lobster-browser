import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { generateSymmetricKey } from '@lobster/crypto';
import type { User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VAULT_REPOSITORY, type VaultRepository } from './vault.repository';

/**
 * The key this account's profile snapshots are scrambled with.
 *
 * ONE ROUTE, and no setup step: a signed-in client asks for its key and gets it, created on first
 * use. That is the whole feature. Signing in is all a user needs to reach their profiles from a new
 * machine, and a password reset costs them nothing.
 *
 * There is no `:userId` — the route is scoped to the authenticated caller, so there is no shape that
 * could hand one user's key to another.
 */
@Controller('vault')
@UseGuards(JwtAuthGuard)
export class VaultController {
  constructor(@Inject(VAULT_REPOSITORY) private readonly repo: VaultRepository) {}

  @Get('key')
  async key(@CurrentUser() user: User): Promise<ApiResponse<{ dataKey: string }>> {
    const key = await this.repo.findOrCreate(user.id, () => generateSymmetricKey());
    return ok({ dataKey: key.toString('base64') });
  }
}
