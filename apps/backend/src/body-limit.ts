import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Request } from 'express';

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
  configureWebhookBodyLimit(app);
  app.useBodyParser('json', { limit });
  app.useBodyParser('urlencoded', { extended: true, limit });
}

/**
 * The payment-processor callback is the ONE route that is both unauthenticated and body-driven, so
 * it does not get the blob-sized ceiling above. Its authentication is an HMAC over the payload,
 * which cannot be checked until the body has been read, parsed and re-serialised — so anyone on the
 * internet can make this process do that work. An IPN is a few hundred bytes; this is generous.
 */
export const WEBHOOK_BODY_LIMIT = '64kb';

/** Route the webhook cap is mounted on. Matches `BillingController`'s `@Post('webhook')`. */
const WEBHOOK_PATH = '/billing/webhook';

/**
 * Mount the small-bodied parsers for the webhook path.
 *
 * MUST run before {@link configureBodyLimit}'s global parsers: whichever parser reaches the request
 * first marks the body as read, and the later one steps aside. Mounted for both content types the
 * global parsers handle, or a caller could pick the other one and get the 50mb ceiling back.
 *
 * `verify` is what keeps the signature checkable — it hands over the undecoded bytes, which is the
 * same job Nest's `rawBody: true` does for the global parsers and which is bypassed here because
 * these parsers are ours.
 */
export function configureWebhookBodyLimit(
  app: NestExpressApplication,
  limit: string = WEBHOOK_BODY_LIMIT,
): void {
  const verify = (req: Request, _res: unknown, buf: Buffer): void => {
    (req as Request & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(WEBHOOK_PATH, express.json({ limit, verify }));
  app.use(WEBHOOK_PATH, express.urlencoded({ extended: true, limit, verify }));
}
