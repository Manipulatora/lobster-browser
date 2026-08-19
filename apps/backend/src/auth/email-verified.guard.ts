import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';

import { USERS_REPOSITORY, type UsersRepository } from './users.repository';

/**
 * Requires a PROVEN email address, not merely a valid token.
 *
 * Stacked after `JwtAuthGuard`, which establishes who the caller is; this one establishes that the
 * address they registered is really theirs. It reads the user fresh rather than trusting a claim
 * in the JWT: a token minted at registration is still valid after verification completes, so a
 * claim baked in at signing time would be permanently stale and would lock a verified user out.
 *
 * Applied to the endpoints that move money. An unverified account that could open a deposit would
 * be an account we cannot reach — no way to send a receipt, and no way to resolve a dispute with
 * someone whose address was never confirmed.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  constructor(@Inject(USERS_REPOSITORY) private readonly users: UsersRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const id = request.user?.id;
    if (!id) throw new ForbiddenException('confirm your email address first');

    const user = await this.users.findById(id);
    if (!user?.emailVerifiedAt) {
      throw new ForbiddenException('confirm your email address first');
    }
    return true;
  }
}
