import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The single Prisma client for the app. It connects on module init ONLY when `DATABASE_URL` is set,
 * so dev/test without a database boot cleanly (the in-memory repositories are used instead). This is
 * the "real data layer": in production with `DATABASE_URL` configured, repositories persist to Postgres.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    if (!process.env.DATABASE_URL) {
      this.logger.warn('DATABASE_URL not set — skipping Prisma connect (using in-memory store).');
      return;
    }
    await this.$connect();
    this.logger.log('Connected to Postgres via Prisma.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
