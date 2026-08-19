import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';

/** Header the operator's cron sends the shared secret in. */
const HEADER = 'x-admin-token';

/**
 * Guards the operator-only billing endpoints with a shared secret from the environment.
 *
 * NOT A USER IDENTITY. These routes are driven by a cron job or a shell, not by a person with a
 * session, so there is no JWT to check and no team to resolve — and the actions behind them (moving
 * every due subscription's money at once) belong to whoever runs the deployment, not to any account
 * inside it. A secret in the environment is exactly the authority that describes.
 *
 * AN UNSET SECRET REFUSES rather than defaulting to open. The endpoint charges money on a whole
 * database; a deployment that forgot to configure it must not discover that by having someone else
 * run the sweep. The refusal says which variable is missing, because that fact is only useful to the
 * person deploying and gives an attacker nothing they could not learn by getting a 401 instead.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('BILLING_ADMIN_TOKEN')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException(
        'admin endpoints are disabled — BILLING_ADMIN_TOKEN is not configured',
      );
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const header = request.headers[HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !sameSecret(provided, expected)) {
      throw new UnauthorizedException('invalid admin token');
    }
    return true;
  }
}

/**
 * Constant-time comparison, over digests so the two sides are the same length.
 *
 * `timingSafeEqual` throws on a length mismatch, and a plain `===` leaks the length of the matching
 * prefix through how long it takes to fail. Hashing first makes both problems go away without
 * needing to pad or to branch on the candidate's size.
 */
function sameSecret(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(provided).digest(),
    createHash('sha256').update(expected).digest(),
  );
}
