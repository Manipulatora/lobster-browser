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
  classifyPlanChange,
  entitledProfileLimit,
  FREE_PLAN_PROFILE_LIMIT,
  periodPriceCents,
  PLAN_CATALOG,
  planByTier,
  planChangeAllowed,
  type BillingPeriod,
  type CreditTransaction,
  type Deposit,
  type PaidPlanTier,
  type PlanChangeQuote,
  type PlanDefinition,
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
  /**
   * The memo / destination tag that MUST be sent with the transfer, on the chains that use one.
   *
   * Not optional detail — it is the second half of the destination. XRP, Stellar and Cosmos-style
   * chains issue ONE shared deposit address for every payment the processor takes and tell
   * depositors apart by this tag alone, so a transfer that arrives on the address without it
   * credits nobody and is not recoverable. Absent, never empty, on chains that issue a real
   * per-payment address; the page must render nothing tag-shaped when it is missing, because a
   * blank tag field on a chain that has no tag is its own way of losing a payment.
   */
  paymentTag?: string;
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
      // Stored beside the address, not just handed to the client: on a shared-address chain this
      // tag is the only thing that attributes the incoming transfer to this user, so it is what a
      // missing-deposit dispute has to compare the sender's transaction against.
      paymentTag: created.paymentTag,
      amountCrypto: created.amountCrypto,
    });

    return {
      depositId: deposit.id,
      address: created.address,
      paymentTag: created.paymentTag,
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
   * Price a package for this team WITHOUT buying it.
   *
   * Exists so a confirmation dialog can state the exact figure that is about to leave the balance.
   * Proration is the one number a client cannot work out for itself — it depends on the real period
   * bounds and on this server's clock — and a dialog that computed it locally would quote one
   * amount and charge another. It also reports refusals ahead of the press, so a downgrade is
   * explained where the user is looking rather than as an error after they committed.
   *
   * Advisory, not a reservation. The balance can move between the quote and the purchase, which is
   * why {@link purchasePlan} prices the change again for itself rather than trusting this.
   */
  async quotePlanChange(
    userId: string,
    tier: PaidPlanTier,
    period: BillingPeriod = 'monthly',
    teamId?: string,
  ): Promise<PlanChangeQuote> {
    const team = await this.resolveTeamId(userId, teamId);
    const { quote } = await this.priceChange(team, tier, period, new Date());
    return quote;
  }

  /**
   * Buy a package, paying from Credit.
   *
   * THE CHANGE IS CLASSIFIED FIRST, and three of the six outcomes never reach a charge — see
   * {@link classifyPlanChange} for what each one means and why a downgrade is refused rather than
   * prorated. What survives that filter always costs more than the credit it reclaims, so the debit
   * below is a single positive movement and never a disguised refund.
   *
   * ONE MOVEMENT, INSIDE ONE TRANSACTION WITH THE PERIOD WRITE. Charging and then activating can
   * half-apply in both directions — a debit with no package, or a package with no debit — and two
   * requests that both read the same subscription would both price the same upgrade and both pay
   * for it. `changePlan` does the compare-and-swap and the debit together, so a double-submitted
   * purchase is refused as `superseded` instead of charged twice.
   *
   * THE PERIOD IS ANCHORED TO TODAY. A purchase starts a fresh period whichever way it arrives, so
   * the billing day becomes the day of the month the team last paid on, and the unused remainder of
   * any previous period is credited back rather than carried. Anything else would have to answer
   * "which of the two billing days survives an upgrade", and every answer to that is a surprise to
   * somebody.
   */
  async purchasePlan(
    userId: string,
    tier: PaidPlanTier,
    period: BillingPeriod = 'monthly',
    teamId?: string,
  ): Promise<Subscription> {
    const team = await this.resolveTeamId(userId, teamId);
    const plan = planByTier(tier);
    const start = new Date();
    const { quote, existing } = await this.priceChange(team, tier, period, start);

    if (!quote.allowed) throw refusePlanChange(quote, plan);

    // An invariant of the classifier, not a case to handle: every allowed change moves onto a
    // package dearer than the credit it reclaims. A zero or negative figure here would activate a
    // package for nothing, and clamping it would hide the defect that produced it.
    if (quote.dueCents <= 0) {
      throw new Error(
        `plan change priced at ${quote.dueCents} cents for team ${team} (${quote.kind})`,
      );
    }

    const term = period === 'yearly' ? ', 12 months' : '';
    const description =
      quote.unusedCreditCents > 0
        ? `${plan.name} package${term} — ${plan.profileLimit} profiles ` +
          `(less ${usd(quote.unusedCreditCents)} credit for unused time)`
        : `${plan.name} package${term} — ${plan.profileLimit} profiles`;

    const outcome = await this.repo.changePlan({
      teamId: team,
      expected: existing
        ? {
            tier: existing.tier,
            billingPeriod: existing.billingPeriod ?? 'monthly',
            currentPeriodEnd: existing.currentPeriodEnd ?? null,
          }
        : null,
      dueCents: quote.dueCents,
      description,
      metadata: {
        tier,
        billingPeriod: period,
        profileLimit: plan.profileLimit,
        unusedCreditCents: quote.unusedCreditCents,
        change: quote.kind,
      },
      tier,
      profileLimit: plan.profileLimit,
      priceCents: quote.priceCents,
      billingPeriod: period,
      // The day of the month they paid on, read in UTC so the anchor is the same calendar day the
      // charge landed on wherever the server happens to be.
      billingAnchorDay: start.getUTCDate(),
      currentPeriodStart: start,
      currentPeriodEnd: addPeriod(start, period),
    });

    if (outcome.status === 'insufficient_credit') {
      const balance = await this.repo.getBalanceCents(team);
      const cost =
        quote.unusedCreditCents > 0
          ? `${plan.name} costs ${usd(quote.dueCents)} after credit for your unused time`
          : `${plan.name} costs ${usd(quote.priceCents)}`;
      throw new BadRequestException(
        `not enough Credit — ${cost}, you have ${usd(balance)}. ` +
          `Deposit ${usd(quote.dueCents - balance)} more.`,
      );
    }

    if (outcome.status === 'superseded') {
      // The package moved between pricing this change and charging it, which is what a
      // double-submitted purchase looks like. Refused rather than re-priced and retried: the caller
      // asked for a change from a state that no longer exists, and one of the two attempts has
      // already delivered what they asked for.
      throw new ConflictException(
        'your package was changed by another request — reload to see where it stands',
      );
    }

    this.logger.log(
      `team ${team} ${quote.kind} to ${tier} (${period}) for ${quote.dueCents} cents`,
    );
    return outcome.subscription;
  }

  /**
   * Work out what a package would cost this team right now, and whether it may have it.
   *
   * Shared by the quote and the purchase so the figure shown and the figure charged come from one
   * piece of arithmetic. Returns the subscription it priced against as well, because the purchase
   * needs it as the compare-and-swap guard.
   */
  private async priceChange(
    team: string,
    tier: PaidPlanTier,
    period: BillingPeriod,
    now: Date,
  ): Promise<{ quote: PlanChangeQuote; existing: Subscription | null }> {
    const plan = planByTier(tier);
    const priceCents = periodPriceCents(plan, period);
    const [balanceCents, existing] = await Promise.all([
      this.repo.getBalanceCents(team),
      this.repo.getSubscription(team),
    ]);

    const live = hasLivePeriod(existing, now);
    const kind = classifyPlanChange(
      {
        tier: existing?.tier ?? 'free',
        period: existing?.billingPeriod ?? 'monthly',
        live,
      },
      { tier, period },
    );
    const allowed = planChangeAllowed(kind);

    // No credit is quoted against a change that will not happen: the figure a refused card shows
    // is the plain list price, which is what it will cost when the current period ends.
    const unusedCreditCents = allowed ? unusedCents(existing, now) : 0;
    const dueCents = priceCents - unusedCreditCents;

    return {
      existing,
      quote: {
        tier,
        period,
        kind,
        allowed,
        priceCents,
        unusedCreditCents,
        dueCents,
        balanceCents,
        balanceAfterCents: balanceCents - dueCents,
        shortfallCents: Math.max(0, dueCents - balanceCents),
        currentTier: existing?.tier ?? 'free',
        currentPeriod: live ? (existing?.billingPeriod ?? 'monthly') : null,
        currentPeriodEnd: live ? (existing?.currentPeriodEnd ?? null) : null,
        nextBillingAt: addPeriod(now, period).toISOString(),
      },
    };
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

/** Just the date, for a message that names the day a period runs out. */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'the end of the current period';
}

/**
 * Whether a team is still inside a period it has paid for.
 *
 * THE single condition that decides whether a purchase is a plain `new` one or a change to
 * something live, and the same condition {@link unusedCents} pays out against — so the classifier
 * cannot call a change an upgrade while the arithmetic credits it nothing, or the reverse.
 *
 * `trialing` is excluded deliberately, unlike in `entitledProfileLimit`: a trial entitles the
 * allowance but was never charged, so there is nothing paid for to protect or refund.
 */
function hasLivePeriod(subscription: Subscription | null, now: Date): boolean {
  if (!subscription || subscription.tier === 'free') return false;
  if (subscription.status !== 'active' || !subscription.currentPeriodEnd) return false;
  return new Date(subscription.currentPeriodEnd) > now;
}

/**
 * Turn a refused change into the exception the caller sees, saying what to do instead.
 *
 * Every one of these is reachable from an ordinary click, so none of them may read as a fault. The
 * quote endpoint answers with the same three kinds BEFORE the press, which is where a client is
 * expected to explain them; this is the server holding the same line for a request that arrives
 * anyway.
 */
function refusePlanChange(quote: PlanChangeQuote, plan: PlanDefinition): ConflictException {
  switch (quote.kind) {
    case 'downgrade':
      return new ConflictException(
        `a smaller package cannot replace one that is already paid for. Your current package runs ` +
          `to ${day(quote.currentPeriodEnd)} — turn auto-renew off and buy ${plan.name} once it ends.`,
      );
    case 'shorten':
      return new ConflictException(
        `your package is paid twelve months up front, to ${day(quote.currentPeriodEnd)}. Choose the ` +
          `yearly term to move now, or turn auto-renew off and buy ${plan.name} monthly once the ` +
          `year ends.`,
      );
    default:
      return new ConflictException(`already subscribed to ${plan.name}`);
  }
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
 * Returns 0 for anything {@link hasLivePeriod} rejects — no subscription, the free tier, a
 * `past_due` package whose last renewal was never paid, and a period that has already ended and
 * was therefore consumed — and for a live period that cost nothing.
 */
function unusedCents(subscription: Subscription | null, now: Date): number {
  if (!hasLivePeriod(subscription, now) || !subscription) return 0;
  if (!subscription.currentPeriodEnd || subscription.priceCents <= 0) return 0;

  const end = new Date(subscription.currentPeriodEnd);
  const remainingMs = end.getTime() - now.getTime();
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
