import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DESKTOP_AUTH_REPOSITORY,
  type DesktopAuthRepository,
} from '../auth/desktop-auth.repository';
import { USERS_REPOSITORY, type UsersRepository } from '../auth/users.repository';
import { LEASES_REPOSITORY, type LeasesRepository } from '../leases/leases.repository';

/** Default gap between sweeps. Nothing here is urgent; an hour keeps the tables from growing. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Drops rows that have outlived their purpose.
 *
 * FOUR TABLES ARE WRITE-ONLY WITHOUT THIS. Pending sign-ups, desktop authorisation grants, email
 * verification codes and profile leases are all short-lived by design, and every one of them has
 * its expiry enforced in the predicate that reads it — so a stale row is harmless, and nothing in
 * the request path ever had a reason to delete one. The result is that they only ever grow, for
 * the life of the deployment, which is what `PendingRegistration`'s "expires and is swept, leaving
 * nothing" was always supposed to mean.
 *
 * DELETING IS THE POINT, not just tidiness: a pending registration holds a password hash and an
 * email address for an account that was never created, and a redeemed desktop grant holds the
 * material of a completed handoff. Keeping either past its window is data retained for no reason.
 *
 * Modelled on {@link RenewalService}: a plain unref'd interval rather than a cron sidecar. Every
 * sweep is idempotent and bounded by an `expiresAt` predicate, so running it from several
 * instances at once is safe and needs no coordination.
 */
@Injectable()
export class HousekeepingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HousekeepingService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    @Inject(DESKTOP_AUTH_REPOSITORY) private readonly desktopAuth: DesktopAuthRepository,
    @Inject(LEASES_REPOSITORY) private readonly leases: LeasesRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // 0 disables it, for a deployment that would rather drive the cleanup from outside.
    if (this.config.get<string>('HOUSEKEEPING_INTERVAL_MS') === '0') {
      this.logger.log('in-process housekeeping sweep disabled (HOUSEKEEPING_INTERVAL_MS=0)');
      return;
    }

    const raw = Number(this.config.get<string>('HOUSEKEEPING_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS);
    const interval = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        // Housekeeping failing is never worth taking the process down for; the next pass sees the
        // same rows still there and tries again.
        this.logger.error(`housekeeping sweep failed: ${String(err)}`);
      });
    }, interval);
    // Do not hold the event loop open — a cleanup timer must not stop the process exiting.
    this.timer.unref?.();
    this.logger.log(`housekeeping sweep every ${Math.round(interval / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run one pass. Safe to call concurrently with itself and with another instance's. */
  async sweep(now = new Date()): Promise<void> {
    await this.users.purgeExpiredPendingRegistrations(now);
    await this.users.purgeExpiredEmailVerifications(now);
    await this.desktopAuth.purgeExpired(now);
    await this.leases.purgeExpired(now);
  }
}
