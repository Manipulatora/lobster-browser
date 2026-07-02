import type { ConfigService } from '@nestjs/config';

/**
 * Dev-only fallback secret, used ONLY outside production (local dev, tests). It is deliberately not
 * a secret. Production must set a real `JWT_SECRET` — see {@link resolveJwtSecret}.
 */
export const DEV_JWT_SECRET = 'lobster-dev-secret-change-me';

/**
 * Resolve the JWT signing/verification secret.
 *
 * In **production** a real `JWT_SECRET` is REQUIRED — we hard-fail if it is missing so a
 * misconfigured deployment can never silently issue forgeable tokens signed with the public dev
 * secret. Outside production (`NODE_ENV` !== 'production'), fall back to {@link DEV_JWT_SECRET}.
 */
export function resolveJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (secret && secret.length > 0) {
    return secret;
  }
  const env = config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    throw new Error(
      'JWT_SECRET is required in production. Refusing to start with the public dev secret.',
    );
  }
  return DEV_JWT_SECRET;
}
