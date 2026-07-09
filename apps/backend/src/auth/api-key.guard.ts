import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { ApiKeysService } from '../api-keys/api-keys.service';

/**
 * Request shape for API-key auth. Kept minimal (no @types/express dependency).
 * Populated fields are consumed by controllers that accept either JWT or API-key auth.
 */
export interface ApiKeyAuthenticatedRequest {
  headers: { authorization?: string };
  /** Owning team id resolved from a verified `lb_live_` secret. */
  apiKeyTeamId?: string;
  /** Public api-key id (not the secret). */
  apiKeyId?: string;
}

/**
 * BE-5: Bearer `lb_live_…` API-key guard. Verifies the secret via {@link ApiKeysService.verify};
 * revoked/unknown secrets → 401. Attaches `apiKeyTeamId` / `apiKeyId` for downstream handlers.
 *
 * Use on automation-facing routes (or compose with JWT). Does not accept JWTs — those stay on
 * {@link JwtAuthGuard}.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyAuthenticatedRequest>();
    const secret = this.extractBearerToken(request);
    if (!secret) {
      throw new UnauthorizedException('missing bearer api key');
    }
    if (!secret.startsWith('lb_live_')) {
      throw new UnauthorizedException('invalid api key');
    }
    const verified = await this.apiKeys.verify(secret);
    if (!verified) {
      throw new UnauthorizedException('invalid or revoked api key');
    }
    request.apiKeyTeamId = verified.teamId;
    request.apiKeyId = verified.apiKeyId;
    return true;
  }

  private extractBearerToken(request: ApiKeyAuthenticatedRequest): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
  }
}
