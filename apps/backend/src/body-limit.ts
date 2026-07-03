import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Max request body size. Client-encrypted profile blobs are pushed as base64 on sync and routinely
 * exceed Express's ~100kb default (which would 413 realistic blobs), so raise the ceiling well
 * above any plausible encrypted profile. Kept as a shared constant so the running server (main.ts)
 * and the e2e tests apply the exact same limit.
 */
export const BODY_LIMIT = '50mb';

/**
 * Register the size-limited JSON/urlencoded body parsers on `app`.
 *
 * The app MUST be created with `{ bodyParser: false }` so these are the only parsers that run —
 * otherwise Nest's built-in ~100kb parser would reject large blobs before these ever see them.
 */
export function configureBodyLimit(app: NestExpressApplication, limit: string = BODY_LIMIT): void {
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { extended: true, limit });
}
