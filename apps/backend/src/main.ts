/**
 * Application entrypoint. Bootstraps the NestJS HTTP server.
 *
 * `reflect-metadata` must be imported once, before any decorated class is loaded, so the
 * decorator metadata (`emitDecoratorMetadata`) that Nest's DI relies on is available.
 */
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { configureBodyLimit } from './body-limit';
import { ApiExceptionFilter } from './common/api-exception.filter';

async function bootstrap(): Promise<void> {
  // Disable Nest's built-in body parser so the raised-limit parsers below are the only ones that
  // run; the default ~100kb limit would otherwise 413 realistic encrypted profile blobs on sync.
  //
  // `rawBody: true` additionally retains the undecoded request bytes as `req.rawBody`. The payment
  // processor's IPN signature is an HMAC over the payload it sent, so verifying it requires the
  // exact bytes — a parsed-and-re-serialised object is not the same string and would never match.
  // Without this, every crypto deposit callback would be rejected and no Credit would ever land.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
  });
  configureBodyLimit(app);

  // SEC-3b / SEC-6: baseline hardening — helmet headers + per-IP rate limit.
  app.use(helmet({ contentSecurityPolicy: false }));
  // Trust exactly ONE proxy hop, so `req.ip` is the client address from X-Forwarded-For rather than
  // the proxy's. In production nginx proxies to 127.0.0.1:8080, so without this every request in
  // the world shares a single rate-limit bucket keyed on the loopback address: one bulk flow (a
  // restore is one pull per profile) 429s every other user, including sign-in. `1` — not `true` —
  // because trusting the whole chain would let a client spoof its own key via X-Forwarded-For.
  app.set('trust proxy', 1);
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const max = Number(process.env.RATE_LIMIT_MAX ?? 120);
  app.use(
    rateLimit({
      windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60_000,
      max: Number.isFinite(max) && max > 0 ? max : 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Every error answers in the same `{ code, data, msg }` envelope as every success.
  app.useGlobalFilters(new ApiExceptionFilter());

  // Global request validation. `whitelist` strips properties not declared on the DTO,
  // and `transform` coerces payloads into their DTO class instances.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS for the desktop UI + web dashboard. Restricted to an explicit allowlist (never reflect all
  // origins while sending credentials). Override in prod via CORS_ORIGINS (comma-separated).
  const corsOrigins = (
    process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000,tauri://localhost'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  const port = process.env.PORT ?? 8080;
  // Bind host is configurable; default keeps prior behaviour. For a local-only agent-LLM proxy on the
  // same host as the desktop app, set HOST=127.0.0.1 so the OpenRouter broker is never internet-facing.
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
  // eslint-disable-next-line no-console
  console.log(`🦞 Lobster backend listening on ${host}:${port}`);
}

void bootstrap();
