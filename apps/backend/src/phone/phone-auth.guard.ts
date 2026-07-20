import { timingSafeEqual } from 'node:crypto';

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface AuthedRequest {
  headers: { authorization?: string };
  query?: Record<string, unknown>;
}

/**
 * Guards the operator-facing phone endpoints. Because these endpoints spend real money (buy numbers,
 * send SMS, mint voice tokens) and the backend is public, they require a static bearer token
 * (`PHONE_ACCESS_TOKEN`). The token may arrive as `Authorization: Bearer <token>` (fetch) or as
 * `?key=<token>` (EventSource can't set headers). Webhooks do NOT use this guard — they are verified
 * by the Twilio signature / URL secret instead.
 */
@Injectable()
export class PhoneAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('PHONE_ACCESS_TOKEN')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('PHONE_ACCESS_TOKEN is not configured');
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const presented = this.extract(req);
    if (!presented || !safeEqual(presented, expected)) {
      throw new UnauthorizedException('invalid phone access token');
    }
    return true;
  }

  private extract(req: AuthedRequest): string | null {
    const header = req.headers.authorization;
    if (header) {
      const [scheme, token] = header.split(' ');
      if (scheme === 'Bearer' && token) return token;
    }
    const key = req.query?.key;
    return typeof key === 'string' && key ? key : null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
