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
}

/**
 * Guards the managed agent-LLM proxy. This endpoint spends the operator's OpenRouter balance on every
 * call, so it requires a static bearer token (`AGENT_PROXY_TOKEN`) that the
 * desktop presents. The token authorizes use of the SERVER-held OpenRouter key without ever exposing it
 * to the client. Header-only (no `?key=` query form) since the sidecar always calls with `fetch`.
 */
@Injectable()
export class AgentProxyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('AGENT_PROXY_TOKEN')?.trim();
    if (!expected) {
      throw new ServiceUnavailableException('AGENT_PROXY_TOKEN is not configured');
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token || !safeEqual(token, expected)) {
      throw new UnauthorizedException('invalid agent proxy token');
    }
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
