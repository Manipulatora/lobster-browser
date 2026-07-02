import { createParamDecorator, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { User } from '@lobster/shared-types';

import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Injects the authenticated principal (`request.user`, set by {@link JwtAuthGuard}) into a
 * controller handler. Controllers MUST derive identity from this decorator — never from the
 * request body or a stub id — so a caller can only ever act as themselves.
 *
 * Only valid on routes protected by `JwtAuthGuard`; on an unguarded route `request.user` is
 * absent and this throws (defence in depth — the guard normally rejects first).
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new UnauthorizedException();
  }
  return request.user;
});
