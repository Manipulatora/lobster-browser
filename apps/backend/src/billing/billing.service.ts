import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  entitledProfileLimit,
  FREE_PLAN_PROFILE_LIMIT,
  periodPriceCents,
  PLAN_CATALOG,
  planByTier,
  type BillingPeriod,
  type CreditTransaction,
  type Deposit,
  type PaidPlanTier,
  type Subscription,
} from '@lobster/shared-types';

import { USERS_REPOSITORY, type UsersRepository } from '../auth/users.repository';
import { MailService } from '../mail/mail.service';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { addPeriod, subtractPeriod } from './billing-period';
import {
  BILLING_REPOSITORY,
  type BillingRepository,
  type StoredDeposit,
} from './billing.repository';
import {
  DEPOSIT_CHAINS,
  depositChainByCode,
  MAX_DEPOSIT_CENTS,
  MIN_DEPOSIT_CENTS,
} from './deposit-chains';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payments/payment-provider';

/** What the dashboard needs to render the billing page in one request. */
export interface BillingOverview {
  balanceCents: number;
  subscription: Subscription | null;
  plans: typeof PLAN_CATALOG;
  chains: typeof DEPOSIT_CHAINS;
  freePlanProfileLimit: number;
  /**
   * When Credit will next be debited for the package, or null when nothing is due — the free tier,
   * auto-renew off, a cancelled package.
   *
   * THE SAME INSTANT THE CHARGE USES, forwarded rather than recomputed. A client that works the
   * date out for itself from a period length is a client that eventually shows a day the sweep
   * does not charge on, and the user only finds out which of the two was right afterwards.
   */
  nextBillingAt: string | null;
  /**
   * The profile allowance actually in force right now.
   *
   * `subscription.profileLimit` is what was BOUGHT and stays put through a lapse; this is what the
   * API will enforce on the next create. Sent as its own field so no client has to re-derive the
   * "is this entitlement still live" rule and quietly disagree with the server about it.
   */
  entitledProfileLimit: number;
  /**
   * Whether the processor is actually usable right now. Sent so the page can say so BEFORE the
   * user picks an amount, rather than letting them commit to Pay and meet a 503 — the credentials
   * being absent is a fact we already know at render time.
   */
  depositsAvailable: boolean;
}

/** A newly issued deposit address for the user to send to. */
export interface DepositInstruction {
  depositId: string;
  address: string;
  amountCrypto: string;
  asset: string;
  chain: string;
  amountCents: number;
  hostedUrl?: string;
}

/**
 * Credit and package logic.
 *
 * THE BILLING MODEL, in one paragraph. Users hold a USD Credit balance, topped up by crypto
 * deposits of any size at any time. A package is bought by DEBITING that balance — there is no
 * card, no external subscription object, and no third party holding a mandate against the user.
 * On the same calendar day of each month (or of each year, for a package paid twelve months up
 * front) the renewal job debits the same balance again; if the balance is short the subscription
 * lapses to `past_due` and recovers by itself the next time a deposit lands. Credit therefore
 * behaves like a prepaid account, and the only way money enters the system is a confirmed on-chain
 * payment.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    private readonly mail: MailService,
  ) {}

  /**
   * Resolve the team to bill from the AUTHENTICATED caller.
   *
   * Mirrors ProfilesService: an explicit `teamId` is honoured only after the caller's membership
   * is verified, and otherwise the caller's own team is used. A team id is never trusted from the
   * request body — on a billing endpoint that would let anyone spend another team's Credit.
   */
  private async resolveTeamId(userId: string, teamId?: string): Promise<string> {
    if (teamId) {
      const membership = await this.teams.getMembership(teamId, userId);
      if (!membership) throw new ForbiddenException('you are not a member of the requested team');
      return teamId;
    }
    const teams = await this.teams.findTeamsForUser(userId);
    const first = teams[0];
    if (!first) throw new ForbiddenException('you do not belong to any team');
    return first.id;
  }

  async getOverview(userId: string, teamId?: string): Promise<BillingOverview> {
    const team = await this.resolveTeamId(userId, teamId);
    const [balanceCents, subscription] = await Promise.all([
      this.repo.getBalanceCents(team),
      this.repo.getSubscription(team),
    ]);
    return {
      balanceCents,
      subscription,
      plans: PLAN_CATALOG,
      // Only rails the processor will actually accept. Offering one it refuses turns a curated
      // list into a trap: the user picks it, confirms, and only then meets the refusal.
      chains: DEPOSIT_CHAINS.filter((c) => this.payments.supportsCurrency(c.code)),
      depositsAvailable: this.payments.isConfigured(),
      freePlanProfileLimit: FREE_PLAN_PROFILE_LIMIT,
      nextBillingAt: nextBillingAt(subscription),
      entitledProfileLimit: entitledProfileLimit(subscription),
    };
  }

  async listTransactions(
    userId: string,
    limit = 50,
    teamId?: string,
  ): Promise<CreditTransaction[]> {
    const team = await this.resolveTeamId(userId, teamId);
    return this.repo.listTransactions(team, Math.min(Math.max(limit, 1), 200));
  }

  async listDeposits(userId: string, limit = 20, teamId?: string): Promise<Deposit[]> {
    const team = await this.resolveTeamId(userId, teamId);
    return this.repo.listDeposits(team, Math.min(Math.max(limit, 1), 100));
  }

  // --- Deposits -------------------------------------------------------------

  /** Issue a deposit address for `amountCents` on the chosen chain. */
  async createDeposit(
    userId: string,
    amountCents: number,
    currencyCode: string,
    teamId?: string,
  ): Promise<DepositInstruction> {
    const team = await this.resolveTeamId(userId, teamId);

    if (!Number.isInteger(amountCents)) {
      throw new BadRequestException('amount must be a whole number of cents');
    }
    if (amountCents < MIN_DEPOSIT_CENTS || amountCents > MAX_DEPOSIT_CENTS) {
      throw new BadRequestException(
        // Phrased in Credit, matching the account page: the balance is Credit, not dollars.
        `deposit must be between ${MIN_DEPOSIT_CENTS / 100} and ${MAX_DEPOSIT_CENTS / 100} Credit`,
      );
    }

    // Reject unknown codes rather than forwarding them. The curated list is the contract; passing
    // an arbitrary currency through to the processor would let a client opt into a chain we do
    // not display a network cost for, which is the whole point of curating it.
    const chain = depositChainByCode(currencyCode);
    if (!chain) throw new BadRequestException('unsupported deposit currency');

    // Missing credentials are a deployment state, not a client error — and the provider would
    // otherwise throw from inside `createDeposit` and surface as a bare 500 "Internal server
    // error" on the payment page, after the user had already confirmed.
    if (!this.payments.isConfigured()) {
      throw new ServiceUnavailableException(
        'crypto deposits are temporarily unavailable — no payment has been taken',
      );
    }

    const orderId = `${team}:${Date.now()}`;
    // A processor that refuses the request is an upstream fault, not a bug in the caller's input,
    // and it must not reach the payment page as a bare 500 "Internal server error". The detail is
    // logged here and NOT returned: it can carry merchant identifiers and upstream diagnostics.
    // The one thing the user needs to know is that no money moved.
    let created: Awaited<ReturnType<PaymentProvider['createDeposit']>>;
    try {
      created = await this.payments.createDeposit({ amountCents, currencyCode, orderId });
    } catch (err) {
      this.logger.error(
        `deposit address request failed via ${this.payments.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        'could not reach the payment processor — no payment has been taken, please try again shortly',
      );
    }

    const deposit = await this.repo.createDeposit({
      teamId: team,
      provider: this.payments.name,
      // Namespaced so ids from two processors can never collide in the unique column.
      providerPaymentId: `${this.payments.name}:${created.providerPaymentId}`,
      // Persisted, not just returned to the client: what the user asked for is the only thing the
      // amount the webhook later settles at can be reconciled against.
      amountCents,
      chain: chain.chain,
      asset: created.asset,
      address: created.address,
      amountCrypto: created.amountCrypto,
    });

    return {
      depositId: deposit.id,
      address: created.address,
      amountCrypto: created.amountCrypto,
      asset: created.asset,
      chain: chain.chain,
      amountCents,
      hostedUrl: created.hostedUrl,
    };
  }

  /**
   * Apply a VERIFIED webhook. The caller must have authenticated it via
   * `PaymentProvider.verifyWebhook` — this method assumes the event is genuine.
   *
   * Returns whether Credit was actually minted, which the controller reports back to the
   * processor. A `false` here is normal: it is what a duplicate delivery looks like.
   */
  async applyWebhook(event: {
    providerPaymentId: string;
    status: Deposit['status'];
    creditCents?: number;
    txHash?: string;
    amountCrypto?: string;
    raw: Record<string, unknown>;
  }): Promise<boolean> {
    const key = `${this.payments.name}:${event.providerPaymentId}`;

    if (event.status !== 'confirmed') {
      const patch = {
        txHash: event.txHash,
        amountCrypto: event.amountCrypto,
        providerPayload: event.raw,
      };

      // A REFUND OR CHARGEBACK ARRIVES AS AN ORDINARY TERMINAL STATUS. The payment may already have
      // settled and minted Credit, and writing only the status would leave the user holding both the
      // returned crypto and the balance it bought — the merchant pays for one deposit twice, with no
      // operator surface to undo it. `reverseDeposit` takes the Credit back in the same transaction
      // as the status write, and is a plain status write for the ordinary case of a payment that
      // never settled at all.
      if (event.status === 'failed' || event.status === 'expired') {
        const reversal = await this.repo.reverseDeposit(key, event.status, patch);
        if (reversal.reversed) {
          this.logger.warn(
            `deposit ${key} was reversed after settling — clawed back ${reversal.clawedBackCents} cents`,
          );
          if (reversal.unrecoveredCents > 0) {
            // The balance was already spent. Nothing automatic can recover it: the wallet is not
            // allowed to go negative, so this is a real loss and has to reach a person.
            this.logger.error(
              `deposit ${key} reversal is ${reversal.unrecoveredCents} cents short — the Credit ` +
                'had already been spent and the wallet cannot go negative',
            );
          }
        }
        return false;
      }

      await this.repo.updateDepositStatus(key, event.status, patch);
      return false;
    }

    const cents = event.creditCents ?? 0;
    if (cents <= 0) {
      // Settled but worth nothing to credit — a fully refunded or zero-value payment. Record the
      // status so it stops showing as pending, but mint nothing.
      this.logger.warn(`settled deposit ${key} credits 0 cents — recording without crediting`);
      await this.repo.updateDepositStatus(key, 'confirmed', {
        txHash: event.txHash,
        amountCrypto: event.amountCrypto,
        providerPayload: event.raw,
      });
      return false;
    }

    // Read BEFORE the credit, while the row still says what was asked for and nothing has been
    // stamped on it. Used for the reconciliation check and to address the receipt.
    const deposit = await this.repo.findDepositByProviderId(key);

    const credited = await this.repo.creditDeposit(key, {
      creditedCents: cents,
      txHash: event.txHash,
      amountCrypto: event.amountCrypto,
      providerPayload: event.raw,
    });

    if (!credited) {
      // Either a duplicate delivery or an unknown payment. Both are expected; neither is an error
      // the processor should retry.
      this.logger.log(`no-op for ${key} (already credited, or unknown payment)`);
      return false;
    }

    this.logger.log(`credited ${cents} cents for ${key}`);
    if (deposit) {
      this.reconcile(key, deposit, cents);
      await this.sendReceipt(deposit, cents);
    }
    return true;
  }

  /**
   * Compare what settled against what was asked for.
   *
   * A settled deposit is worth what the PROCESSOR says it is worth: under- and overpayment are
   * ordinary on a chain, and refusing to credit a mismatch would strand real money that has already
   * arrived. What is NOT ordinary is a payment settling for an amount unrelated to the one it was
   * quoted at — the shape a processor bug or a crossed payment takes — and that used to be
   * invisible, because the requested figure was never stored. It is a loud log rather than a hold
   * for the same reason: the money is already ours, and the useful thing is that a human can see it.
   */
  private reconcile(key: string, deposit: StoredDeposit, creditedCents: number): void {
    const requested = deposit.amountCents;
    if (requested === undefined || requested <= 0) return;

    const drift = Math.abs(creditedCents - requested);
    // Wide on purpose: a partial payment or a generous rounding is not worth a log line every time.
    if (drift <= 100 || drift / requested <= 0.05) return;

    this.logger.warn(
      `deposit ${key} settled at ${usd(creditedCents)} against a requested ${usd(requested)} — ` +
        'expected for an under/overpayment, worth investigating if it repeats',
    );
  }

  /**
   * Tell the payer their money landed.
   *
   * This is the receipt `EmailVerifiedGuard` exists for: a deposit is gated on a proven address
   * precisely so there is somewhere to send this, and a payment that produces no confirmation
   * leaves the user watching a page for a balance that already changed.
   *
   * BEST-EFFORT, and deliberately last. The Credit is already recorded; a missing mailbox, an
   * unconfigured SMTP host or a lookup failure must not turn a settled payment into an error the
   * processor retries. It goes to the team's admins, because the team — not the browsing session —
   * is what holds the balance.
   */
  private async sendReceipt(deposit: StoredDeposit, creditedCents: number): Promise<void> {
    try {
      const members = await this.teams.listMembers(deposit.teamId);
      const admins = members.filter((m) => m.role === 'admin');
      const recipient = (admins[0] ?? members[0])?.userId;
      if (!recipient) return;

      const user = await this.users.findById(recipient);
      if (!user) return;

      const balance = await this.repo.getBalanceCents(deposit.teamId);
      await this.mail.sendDepositReceipt(
        user.email,
        usd(creditedCents),
        usd(balance),
        deposit.asset,
      );
    } catch (err) {
      this.logger.warn(
        `deposit receipt not sent for ${deposit.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- Packages -------------------------------------------------------------

  /**
   * Buy a package, paying from Credit.
   *
   * ORDER OF OPERATIONS MATTERS. The debit happens first and the subscription is activated only
   * if it succeeded. Reversing them would grant the package and then discover the team could not
   * pay for it, leaving an active subscription with no charge behind it. `move` returns null
   * rather than throwing on insufficient funds, so "you cannot afford this" is an ordinary
   * outcome handled here, not an exception escaping from the data layer.
   *
   * THE PERIOD IS ANCHORED TO TODAY. A purchase starts a fresh period whichever way it arrives —
   * first package, upgrade, downgrade — so the billing day becomes the day of the month the team
   * last paid on, and the unused remainder of any previous period is credited back rather than
   * carried. Anything else would have to answer "which of the two billing days survives an
   * upgrade", and every answer to that is a surprise to somebody.
   */
  async purchasePlan(
    userId: string,
    tier: PaidPlanTier,
    period: BillingPeriod = 'monthly',
    teamId?: string,
  ): Promise<Subscription> {
    const team = await this.resolveTeamId(userId, teamId);
    const plan = planByTier(tier);
    const priceCents = periodPriceCents(plan, period);

    const existing = await this.repo.getSubscription(team);
    if (
      existing &&
      existing.tier === tier &&
      existing.status === 'active' &&
      (existing.billingPeriod ?? 'monthly') === period
    ) {
      throw new ConflictException(`already subscribed to ${plan.name}`);
    }

    // Credit back whatever the team already paid for and has not used, so switching packages
    // mid-period does not quietly confiscate the remainder. See {@link unusedCents}.
    const unused = unusedCents(existing);
    const netCents = priceCents - unused;

    const term = period === 'yearly' ? ', 12 months' : '';
    const description =
      unused > 0
        ? `${plan.name} package${term} — ${plan.profileLimit} profiles ` +
          `(less ${usd(unused)} credit for unused time)`
        : `${plan.name} package${term} — ${plan.profileLimit} profiles`;

    const metadata = {
      tier,
      billingPeriod: period,
      profileLimit: plan.profileLimit,
      unusedCreditCents: unused,
    };

    // ONE movement, not a refund followed by a charge. Two movements can half-apply: refund first
    // and the charge fails, and the team keeps its old package plus a windfall; charge first and
    // the refund fails, and they have paid twice. Netting them means the whole plan change either
    // happens or does not.
    //
    // A net that is zero or negative (downgrading to something cheaper than the credit owed) is a
    // refund, and `move` must be given the correct sign and kind for the statement to read
    // sensibly.
    const charge =
      netCents > 0
        ? await this.repo.move({
            teamId: team,
            kind: 'purchase',
            amountCents: -netCents,
            description,
            metadata,
          })
        : await this.repo.move({
            teamId: team,
            kind: 'refund',
            amountCents: -netCents,
            description,
            metadata,
          });

    if (!charge) {
      const balance = await this.repo.getBalanceCents(team);
      const shortBy = netCents - balance;
      const cost =
        unused > 0
          ? `${plan.name} costs ${usd(netCents)} after credit for your unused time`
          : `${plan.name} costs ${usd(priceCents)}`;
      throw new BadRequestException(
        `not enough Credit — ${cost}, you have ${usd(balance)}. Deposit ${usd(shortBy)} more.`,
      );
    }

    const start = new Date();
    const subscription = await this.repo.activateSubscription({
      teamId: team,
      tier,
      profileLimit: plan.profileLimit,
      priceCents,
      billingPeriod: period,
      // The day of the month they paid on, read in UTC so the anchor is the same calendar day the
      // charge landed on wherever the server happens to be.
      billingAnchorDay: start.getUTCDate(),
      currentPeriodStart: start,
      currentPeriodEnd: addPeriod(start, period),
    });

    this.logger.log(`team ${team} purchased ${tier} (${period}) for ${priceCents} cents`);
    return subscription;
  }

  /**
   * Turn auto-renew on or off. Off means the package simply expires at `currentPeriodEnd`; it does
   * not refund the current period, which the user has already paid for and is still using.
   */
  async setAutoRenew(userId: string, autoRenew: boolean, teamId?: string): Promise<Subscription> {
    const team = await this.resolveTeamId(userId, teamId);
    const existing = await this.repo.getSubscription(team);
    if (!existing || existing.tier === 'free') {
      throw new BadRequestException('no active package');
    }
    return this.repo.setAutoRenew(team, autoRenew);
  }
}

/**
 * When the renewal job will next debit this subscription, or null when it never will.
 *
 * Mirrors `findDueForRenewal`'s predicate exactly — same statuses, same auto-renew flag, same
 * instant — so the date a user is shown is the date they are charged on. A `past_due` package
 * returns its period end even though that is in the past, which is the truth: the charge is due
 * now and lands the moment Credit arrives.
 */
function nextBillingAt(subscription: Subscription | null): string | null {
  if (!subscription || subscription.tier === 'free') return null;
  if (!subscription.autoRenew || !subscription.currentPeriodEnd) return null;
  if (subscription.status !== 'active' && subscription.status !== 'past_due') return null;
  return subscription.currentPeriodEnd;
}

/** Format USD cents for a user-facing message. */
function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * What a team has already paid for and not yet used, in USD cents.
 *
 * WHY THIS EXISTS. Without it, switching packages mid-period charges the new plan in full and
 * silently discards the remainder of the old one — someone who upgrades from Light to Pro on day
 * two has just thrown away 28 days they paid for. That is an ordinary action, not an edge case, and
 * losing the customer's money on it is a defect rather than simplicity.
 *
 * PRORATED AGAINST THE REAL PERIOD, `currentPeriodStart` to `currentPeriodEnd`. Measuring against
 * an assumed 30 days instead gets February wrong in one direction and July in the other, and gets a
 * yearly package wrong by a factor of twelve — it would refund a whole year's price for the last
 * fortnight of one. Floored to the cent, so rounding can never credit MORE than was unused.
 *
 * Returns 0 for:
 *   - no subscription, or the free tier — nothing was paid
 *   - a period that has already ended — it was consumed, and the next one was never charged
 *   - `past_due` — the last renewal failed, so there is no paid period to refund
 */
function unusedCents(subscription: Subscription | null): number {
  if (!subscription || subscription.tier === 'free') return 0;
  if (subscription.status !== 'active') return 0;
  if (!subscription.currentPeriodEnd || subscription.priceCents <= 0) return 0;

  const end = new Date(subscription.currentPeriodEnd);
  const remainingMs = end.getTime() - Date.now();
  if (remainingMs <= 0) return 0;

  // Rows written before period starts were recorded fall back to one period back from the end,
  // which is where the period they are in began.
  const start = subscription.currentPeriodStart
    ? new Date(subscription.currentPeriodStart)
    : subtractPeriod(end, subscription.billingPeriod ?? 'monthly', subscription.billingAnchorDay);
  const periodMs = end.getTime() - start.getTime();
  if (periodMs <= 0) return 0;

  // Only bites when `now` precedes the period start — a support grant dated into the future, or a
  // clock that moved. Refunding more than was ever paid is not a rounding question.
  if (remainingMs >= periodMs) return subscription.priceCents;

  // Integer cents throughout: a cents × ms product stays far inside the exact-integer range, so
  // there is no float fraction to accumulate error in.
  return Math.floor((subscription.priceCents * remainingMs) / periodMs);
}
