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

import { AppModule } from './app.module';
import { configureBodyLimit } from './body-limit';

async function bootstrap(): Promise<void> {
  // Disable Nest's built-in body parser so the raised-limit parsers below are the only ones that
  // run; the default ~100kb limit would otherwise 413 realistic encrypted profile blobs on sync.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureBodyLimit(app);

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
