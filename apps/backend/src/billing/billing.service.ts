import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  FREE_PLAN_PROFILE_LIMIT,
  PLAN_CATALOG,
  planByTier,
  type CreditTransaction,
  type Deposit,
  type PaidPlanTier,
  type Subscription,
} from '@lobster/shared-types';

import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { BILLING_REPOSITORY, type BillingRepository } from './billing.repository';
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

/** How long a purchased package lasts before auto-renew charges again. */
const PERIOD_DAYS = 30;

/**
 * Credit and package logic.
 *
 * THE BILLING MODEL, in one paragraph. Users hold a USD Credit balance, topped up by crypto
 * deposits of any size at any time. A package is bought by DEBITING that balance — there is no
 * card, no external subscription object, and no third party holding a mandate against the user.
 * Every 30 days the renewal job debits the same balance again; if the balance is short the
 * subscription lapses to `past_due` and recovers by itself the next time a deposit lands. Credit
 * therefore behaves like a prepaid account, and the only way money enters the system is a
 * confirmed on-chain payment.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
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
      chains: DEPOSIT_CHAINS,
      freePlanProfileLimit: FREE_PLAN_PROFILE_LIMIT,
    };
  }

  async listTransactions(userId: string, limit = 50, teamId?: string): Promise<CreditTransaction[]> {
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
        `deposit must be between $${MIN_DEPOSIT_CENTS / 100} and $${MAX_DEPOSIT_CENTS / 100}`,
      );
    }

    // Reject unknown codes rather than forwarding them. The curated list is the contract; passing
    // an arbitrary currency through to the processor would let a client opt into a chain we do
    // not display a network cost for, which is the whole point of curating it.
    const chain = depositChainByCode(currencyCode);
    if (!chain) throw new BadRequestException('unsupported deposit currency');

    const orderId = `${team}:${Date.now()}`;
    const created = await this.payments.createDeposit({ amountCents, currencyCode, orderId });

    const deposit = await this.repo.createDeposit({
      teamId: team,
      provider: this.payments.name,
      // Namespaced so ids from two processors can never collide in the unique column.
      providerPaymentId: `${this.payments.name}:${created.providerPaymentId}`,
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
      await this.repo.updateDepositStatus(key, event.status, {
        txHash: event.txHash,
        amountCrypto: event.amountCrypto,
        providerPayload: event.raw,
      });
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

    const credited = await this.repo.creditDeposit(key, {
      creditedCents: cents,
      txHash: event.txHash,
      amountCrypto: event.amountCrypto,
      providerPayload: event.raw,
    });

    if (credited) {
      this.logger.log(`credited ${cents} cents for ${key}`);
    } else {
      // Either a duplicate delivery or an unknown payment. Both are expected; neither is an error
      // the processor should retry.
      this.logger.log(`no-op for ${key} (already credited, or unknown payment)`);
    }
    return credited;
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
   */
  async purchasePlan(userId: string, tier: PaidPlanTier, teamId?: string): Promise<Subscription> {
    const team = await this.resolveTeamId(userId, teamId);
    const plan = planByTier(tier);

    const existing = await this.repo.getSubscription(team);
    if (existing && existing.tier === tier && existing.status === 'active') {
      throw new ConflictException(`already subscribed to ${plan.name}`);
    }

    // Credit back whatever the team already paid for and has not used, so switching packages
    // mid-period does not quietly confiscate the remainder. See {@link unusedCents}.
    const unused = unusedCents(existing);
    const netCents = plan.priceCents - unused;

    const description =
      unused > 0
        ? `${plan.name} package — ${plan.profileLimit} profiles ` +
          `(less ${usd(unused)} credit for unused time)`
        : `${plan.name} package — ${plan.profileLimit} profiles`;

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
            metadata: { tier, profileLimit: plan.profileLimit, unusedCreditCents: unused },
          })
        : await this.repo.move({
            teamId: team,
            kind: 'refund',
            amountCents: -netCents,
            description,
            metadata: { tier, profileLimit: plan.profileLimit, unusedCreditCents: unused },
          });

    if (!charge) {
      const balance = await this.repo.getBalanceCents(team);
      const shortBy = netCents - balance;
      const cost =
        unused > 0
          ? `${plan.name} costs ${usd(netCents)} after credit for your unused time`
          : `${plan.name} costs ${usd(plan.priceCents)}`;
      throw new BadRequestException(
        `not enough Credit — ${cost}, you have ${usd(balance)}. Deposit ${usd(shortBy)} more.`,
      );
    }

    const subscription = await this.repo.activateSubscription({
      teamId: team,
      tier,
      profileLimit: plan.profileLimit,
      priceCents: plan.priceCents,
      currentPeriodEnd: addDays(new Date(), PERIOD_DAYS),
    });

    this.logger.log(`team ${team} purchased ${tier} for ${plan.priceCents} cents`);
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

export function addDays(from: Date, days: number): Date {
  const out = new Date(from);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
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
 * Prorated by elapsed time against a 30-day period, floored to the cent so rounding can never
 * credit MORE than was actually unused. Returns 0 for:
 *   - no subscription, or the free tier — nothing was paid
 *   - a period that has already ended — it was consumed, and the next one was never charged
 *   - `past_due` — the last renewal failed, so there is no paid period to refund
 */
function unusedCents(subscription: Subscription | null): number {
  if (!subscription || subscription.tier === 'free') return 0;
  if (subscription.status !== 'active') return 0;
  if (!subscription.currentPeriodEnd || subscription.priceCents <= 0) return 0;

  const remainingMs = new Date(subscription.currentPeriodEnd).getTime() - Date.now();
  if (remainingMs <= 0) return 0;

  const periodMs = PERIOD_DAYS * 24 * 60 * 60 * 1000;
  // Clamp: a period end further out than one full period (a support grant, a clock skew) must not
  // refund more than the team ever paid.
  const fraction = Math.min(remainingMs / periodMs, 1);
  return Math.floor(subscription.priceCents * fraction);
}
