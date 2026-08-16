import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { planByTier, type PaidPlanTier } from '@lobster/shared-types';

import { addDays } from './billing.service';
import { BILLING_REPOSITORY, type BillingRepository } from './billing.repository';

/** Outcome counts for one sweep, for logging and the admin trigger's response. */
export interface RenewalSweepResult {
  examined: number;
  renewed: number;
  lapsed: number;
  skipped: number;
}

const PERIOD_DAYS = 30;
const BATCH_LIMIT = 200;

/**
 * Monthly auto-renewal.
 *
 * Every `RENEWAL_SWEEP_INTERVAL_MS` this looks for subscriptions whose period has ended and
 * charges each one's Credit for another month. There is no external scheduler dependency: the
 * sweep is idempotent and safe to run from every instance concurrently (see
 * `BillingRepository.renewSubscription` for the compare-and-swap that makes that true), so a
 * plain interval is sufficient and one less moving part than a cron sidecar.
 *
 * WHAT HAPPENS WHEN CREDIT IS SHORT. The subscription lapses to `past_due` rather than being
 * cancelled, and its profile limit stops applying — existing profiles keep working, new ones are
 * refused. `findDueForRenewal` deliberately keeps returning `past_due` rows, so the next sweep
 * after a deposit lands renews the team automatically. Nobody has to notice, and no support
 * action is needed to recover.
 */
@Injectable()
export class RenewalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RenewalService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const raw = Number(this.config.get<string>('RENEWAL_SWEEP_INTERVAL_MS') ?? 60 * 60 * 1000);
    const interval = Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;

    // 0 disables the in-process sweep, for deployments that would rather drive it from an external
    // cron against the admin endpoint.
    if (this.config.get<string>('RENEWAL_SWEEP_INTERVAL_MS') === '0') {
      this.logger.log('in-process renewal sweep disabled (RENEWAL_SWEEP_INTERVAL_MS=0)');
      return;
    }

    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        // A failed sweep must never take the process down; the next one retries from the same
        // durable state.
        this.logger.error(`renewal sweep failed: ${String(err)}`);
      });
    }, interval);
    // Do not hold the event loop open: a pending renewal timer should not stop the process exiting.
    this.timer.unref?.();
    this.logger.log(`renewal sweep every ${Math.round(interval / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run one pass over everything currently due. Safe to call concurrently. */
  async sweep(now = new Date()): Promise<RenewalSweepResult> {
    const due = await this.repo.findDueForRenewal(now, BATCH_LIMIT);
    const result: RenewalSweepResult = {
      examined: due.length,
      renewed: 0,
      lapsed: 0,
      skipped: 0,
    };

    for (const sub of due) {
      // `free` is filtered out by the query, and a row without a period end cannot be
      // compare-and-swapped against; both would be bugs upstream, so skip rather than guess.
      if (sub.tier === 'free' || !sub.currentPeriodEnd) {
        result.skipped += 1;
        continue;
      }

      // Charge what the team actually agreed to, not today's list price. `priceCents` was
      // snapshotted at purchase precisely so a catalog change cannot silently re-price an existing
      // subscriber; falling back to the catalog covers rows written before that field existed.
      const price = sub.priceCents > 0 ? sub.priceCents : planByTier(sub.tier as PaidPlanTier).priceCents;
      const plan = planByTier(sub.tier as PaidPlanTier);

      const outcome = await this.repo.renewSubscription({
        teamId: sub.teamId,
        expectedPeriodEnd: sub.currentPeriodEnd,
        priceCents: price,
        newPeriodEnd: nextPeriodEnd(new Date(sub.currentPeriodEnd), now),
        description: `${plan.name} package — monthly renewal`,
      });

      if (outcome === 'renewed') {
        result.renewed += 1;
      } else if (outcome === 'insufficient_credit') {
        await this.repo.markPastDue(sub.teamId, 'insufficient_credit');
        result.lapsed += 1;
        this.logger.log(`team ${sub.teamId} lapsed to past_due — not enough Credit for ${sub.tier}`);
      } else {
        // Another instance renewed this period between the query and the attempt. Expected.
        result.skipped += 1;
      }
    }

    if (result.renewed || result.lapsed) {
      this.logger.log(
        `renewal sweep: ${result.renewed} renewed, ${result.lapsed} lapsed, ${result.skipped} skipped`,
      );
    }
    return result;
  }
}

/**
 * Where the next period should end.
 *
 * Normally: one period after the last one ended. Anchoring to the previous END rather than to
 * `now` keeps the billing date stable — a sweep that runs six hours late, or a team that spent
 * three days in `past_due` waiting for a deposit, must not have that delay permanently added to
 * their billing month.
 *
 * THE CATCH-UP TRAP, which the naive version walks straight into. If a team lapses for longer than
 * one period, `previousEnd + 30d` is STILL in the past. The row therefore comes back as due on the
 * very next sweep, and again, and again — each pass charging another month. A team that lapsed for
 * four months and then deposited $10 would have it consumed instantly by four retroactive
 * renewals, for service they demonstrably did not receive, in seconds, with no way to intervene.
 *
 * So a period end that has already passed is rebased onto `now`. Missed months are forgiven rather
 * than invoiced: the team resumes with a full period from the moment they can pay for it, and each
 * sweep can charge a given subscription at most once.
 */
function nextPeriodEnd(previousEnd: Date, now: Date): Date {
  const anchored = addDays(previousEnd, PERIOD_DAYS);
  return anchored > now ? anchored : addDays(now, PERIOD_DAYS);
}
