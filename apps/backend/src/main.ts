/**
 * Application entrypoint. Bootstraps the NestJS HTTP server.
 *
 * `reflect-metadata` must be imported once, before any decorated class is loaded, so the
 * decorator metadata (`emitDecoratorMetadata`) that Nest's DI relies on is available.
 */
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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
