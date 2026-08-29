import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@lobster/shared-types';

import { AuthService, type JwtPayload } from './auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * The request shape this guard reads from and writes to. Kept minimal so the backend
 * does not depend on `@types/express` (not installed); the underlying object is Express's
 * request at runtime.
 */
export interface AuthenticatedRequest {
  headers: { authorization?: string };
  /** Populated by JwtAuthGuard once the bearer token is verified. */
  user?: User;
}

/**
 * Protects routes with a Bearer JWT: extracts the token from the `Authorization` header,
 * verifies its signature/expiry, confirms the user still exists, and attaches the public
 * user (id included) to `request.user` for downstream handlers.
 *
 * An `agent`-audience token is refused here. It is signed with the same secret, so without this
 * check the narrow, short-lived credential the desktop hands to a sidecar would also open the
 * account, billing and profile endpoints — a scope that only exists if it is enforced.
 *
 * Registered as a global `APP_GUARD` (auth.module.ts), so every route authenticates by DEFAULT and
 * `@Public()` is the explicit, reviewable exception. Before that inversion the guard was opt-in
 * per controller, and the failure mode of forgetting it was an open endpoint that looked healthy.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Handler metadata overrides class metadata, so `@Public()` on one route of a guarded
    // controller works, and so would the (unused, deliberate) reverse.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, { secret: this.auth.jwtSecret });
    } catch {
      throw new UnauthorizedException('invalid or expired token');
    }

    if (payload.aud === 'agent') {
      throw new UnauthorizedException('agent tokens are not valid on this endpoint');
    }

    request.user = await this.auth.validateUser(payload.sub);
    return true;
  }

  private extractBearerToken(request: AuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
  }
}
