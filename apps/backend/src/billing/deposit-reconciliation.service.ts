import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BILLING_REPOSITORY, type BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payments/payment-provider';

/** Outcome counts for one pass, for logging and for a caller driving it directly. */
export interface ReconciliationResult {
  examined: number;
  settled: number;
  unchanged: number;
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/** How long a payment gets to arrive on its own before we go and ask about it. */
const SETTLE_GRACE_MS = 15 * 60 * 1000;

/** How far back to keep asking. An address nobody ever sent to is not worth polling forever. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const BATCH_LIMIT = 50;

/**
 * The safety net under the payment webhook.
 *
 * THE FAILURE THIS EXISTS FOR is not a dropped callback — processors retry those. It is that
 * verifying an IPN requires reproducing the processor's own JSON serialisation of the payload
 * exactly, down to how a number is rendered, and if that ever diverges then every callback fails
 * verification simultaneously and permanently. The symptom is the worst kind: users send real
 * crypto, every deposit sits at `pending`, nothing errors, and the only evidence is a log line.
 *
 * Asking instead of waiting removes that dependency. The state comes back on our own authenticated
 * request, through the same normalisation and the same exactly-once crediting path as a webhook,
 * so a total signature outage degrades from "no deposit is ever credited" to "deposits are
 * credited within one sweep".
 *
 * It is also just correct for the ordinary case: a callback lost to a deploy, a restart or an
 * outage at either end heals here without anyone noticing.
 *
 * Safe to run from every instance at once — `creditDeposit` is idempotent on the payment id, which
 * is what makes a duplicate answer a no-op rather than a double credit.
 */
@Injectable()
export class DepositReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositReconciliationService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('DEPOSIT_RECONCILE_INTERVAL_MS') === '0') {
      this.logger.log('deposit reconciliation disabled (DEPOSIT_RECONCILE_INTERVAL_MS=0)');
      return;
    }

    const raw = Number(
      this.config.get<string>('DEPOSIT_RECONCILE_INTERVAL_MS') ?? DEFAULT_INTERVAL_MS,
    );
    const interval = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => {
      void this.sweep().catch((err: unknown) => {
        this.logger.error(`deposit reconciliation failed: ${String(err)}`);
      });
    }, interval);
    this.timer.unref?.();
    this.logger.log(`deposit reconciliation every ${Math.round(interval / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ask the processor about every deposit still waiting, and apply whatever it says. */
  async sweep(now = new Date()): Promise<ReconciliationResult> {
    const result: ReconciliationResult = { examined: 0, settled: 0, unchanged: 0 };
    if (!this.payments.isConfigured()) return result;

    const pending = await this.repo.findUnsettledDeposits({
      createdBefore: new Date(now.getTime() - SETTLE_GRACE_MS),
      createdAfter: new Date(now.getTime() - LOOKBACK_MS),
      limit: BATCH_LIMIT,
    });

    for (const deposit of pending) {
      result.examined += 1;

      // Rows carry the provider-namespaced id; the processor only knows its own half of it.
      const prefix = `${this.payments.name}:`;
      if (!deposit.providerPaymentId.startsWith(prefix)) continue;
      const event = await this.payments.fetchPayment(
        deposit.providerPaymentId.slice(prefix.length),
      );
      if (!event) {
        result.unchanged += 1;
        continue;
      }

      // Straight through `applyWebhook`, deliberately: crediting, the exactly-once guard, the
      // refund claw-back and the receipt all live there, and a second copy of that logic here is
      // how the two paths would start to disagree about what a payment is worth.
      const credited = await this.billing.applyWebhook(event);
      if (credited) {
        result.settled += 1;
        this.logger.warn(
          `deposit ${deposit.providerPaymentId} was settled by reconciliation, not by its callback` +
            ' — if this is not rare, the IPN signature check is rejecting everything',
        );
      } else {
        result.unchanged += 1;
      }
    }

    return result;
  }
}
