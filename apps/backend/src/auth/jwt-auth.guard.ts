import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@lobster/shared-types';

import { AuthService, type JwtPayload } from './auth.service';

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
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
