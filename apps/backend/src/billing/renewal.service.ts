import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { periodPriceCents, planByTier, type PaidPlanTier } from '@lobster/shared-types';

import { nextCycle } from './billing-period';
import { BILLING_REPOSITORY, type BillingRepository } from './billing.repository';

/** Outcome counts for one sweep, for logging and the admin trigger's response. */
export interface RenewalSweepResult {
  examined: number;
  renewed: number;
  lapsed: number;
  skipped: number;
  /** Packages ended because their window closed and auto-renew was off. */
  expired: number;
}

const BATCH_LIMIT = 200;

/**
 * Calendar auto-renewal.
 *
 * Every `RENEWAL_SWEEP_INTERVAL_MS` this looks for subscriptions whose period has ended and
 * charges each one's Credit for another period — the next month on the team's own billing day, or
 * the next year for a package paid twelve months up front. There is no external scheduler
 * dependency: the sweep is idempotent and safe to run from every instance concurrently (see
 * `BillingRepository.renewSubscription` for the compare-and-swap that makes that true), so a
 * plain interval is sufficient and one less moving part than a cron sidecar.
 *
 * WHAT HAPPENS WHEN CREDIT IS SHORT. The subscription lapses to `past_due` rather than being
 * cancelled, and its profile limit stops applying — existing profiles keep working, new ones are
 * refused. `findDueForRenewal` deliberately keeps returning `past_due` rows, so the next sweep
 * after a deposit lands renews the team automatically. Nobody has to notice, and no support
 * action is needed to recover. What that recovery costs, and why a lapsed window is never invoiced
 * retroactively, is `nextCycle`.
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
      expired: 0,
    };

    // END the packages nothing will ever renew. findDueForRenewal only selects autoRenew rows, so
    // before this existed a package with auto-renew off kept status='active' at its paid tier
    // forever once its window closed - the API went on honouring a plan the team had stopped
    // paying for, and the dashboard went on calling it "Current". Done before the renewal loop so a
    // row can never be examined by both passes in one sweep.
    for (const sub of await this.repo.findDueForExpiry(now, BATCH_LIMIT)) {
      if (!sub.currentPeriodEnd) {
        result.skipped += 1;
        continue;
      }
      const outcome = await this.repo.expireSubscription({
        teamId: sub.teamId,
        expectedPeriodEnd: sub.currentPeriodEnd,
      });
      if (outcome === 'expired') {
        result.expired += 1;
        this.logger.log(`subscription expired: team=${sub.teamId} tier=${sub.tier}`);
      }
    }

    for (const sub of due) {
      // `free` is filtered out by the query, and a row without a period end cannot be
      // compare-and-swapped against; both would be bugs upstream, so skip rather than guess.
      if (sub.tier === 'free' || !sub.currentPeriodEnd) {
        result.skipped += 1;
        continue;
      }

      const plan = planByTier(sub.tier as PaidPlanTier);
      const period = sub.billingPeriod ?? 'monthly';

      // Charge what the team actually agreed to, not today's list price. `priceCents` was
      // snapshotted at purchase precisely so a catalog change cannot silently re-price an existing
      // subscriber; falling back to the catalog covers rows written before that field existed.
      const price = sub.priceCents > 0 ? sub.priceCents : periodPriceCents(plan, period);

      const previousEnd = new Date(sub.currentPeriodEnd);
      const cycle = nextCycle({
        previousEnd,
        now,
        period,
        // An absent anchor is a row written before anchors existed and missed by the backfill. Its
        // period end is the day it has been charged on, so that is the honest anchor for it.
        anchorDay: sub.billingAnchorDay ?? previousEnd.getUTCDate(),
        // `past_due` is precisely the state in which the team was NOT getting what it pays for, so
        // the period it is now buying starts today rather than back when the last one ran out.
        lapsed: sub.status === 'past_due',
      });

      const outcome = await this.repo.renewSubscription({
        teamId: sub.teamId,
        expectedPeriodEnd: sub.currentPeriodEnd,
        priceCents: price,
        newPeriodStart: cycle.start,
        newPeriodEnd: cycle.end,
        description: `${plan.name} package — ${period} renewal`,
      });

      if (outcome === 'renewed') {
        result.renewed += 1;
      } else if (outcome === 'insufficient_credit') {
        await this.repo.markPastDue(sub.teamId, 'insufficient_credit');
        result.lapsed += 1;
        this.logger.log(
          `team ${sub.teamId} lapsed to past_due — not enough Credit for ${sub.tier}`,
        );
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
