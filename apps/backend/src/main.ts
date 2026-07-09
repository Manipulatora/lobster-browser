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

async function bootstrap(): Promise<void> {
  // Disable Nest's built-in body parser so the raised-limit parsers below are the only ones that
  // run; the default ~100kb limit would otherwise 413 realistic encrypted profile blobs on sync.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureBodyLimit(app);

  // SEC-3b / SEC-6: baseline hardening — helmet headers + per-IP rate limit.
  app.use(helmet({ contentSecurityPolicy: false }));
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
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🦞 Lobster backend listening on :${port}`);
}

void bootstrap();
