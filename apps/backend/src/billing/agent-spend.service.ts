import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BILLING_REPOSITORY,
  type AgentUsageRow,
  type BillingRepository,
} from './billing.repository';
import {
  computeAgentCostMicros,
  estimateAgentCostMicros,
  agentModelPrice,
  MICROS_PER_CENT,
  resolveAgentMargin,
  type AgentCallUsage,
} from './agent-pricing';

/** Everything the meter needs to attribute one call, on top of what it needs to price it. */
export interface AgentChargeRequest extends AgentCallUsage {
  teamId: string;
  userId?: string;
  profileId?: string;
  sessionId?: string;
}

export interface AgentChargeResult {
  /** False when the model had no price and the provider returned no cost — nothing was charged. */
  priced: boolean;
  /** What this call cost, in micro-USD, margin included. */
  costMicros: number;
  /** Whole cents this call moved out of the wallet. Zero on most calls, and that is correct. */
  chargedCents: number;
  /** Micro-USD still carried on the team: sub-cent change plus anything the balance could not cover. */
  pendingMicros: number;
  /** Cents that were owed but could not be taken because the balance was short. */
  unpaidCents: number;
}

/** The pre-flight answer, with enough detail for the caller to say WHY it refused. */
export interface AgentAffordability {
  ok: boolean;
  balanceCents: number;
  /** What the call plus the standing accrual would need, rounded up to whole cents. */
  requiredCents: number;
}

/**
 * How long one wallet read answers the pre-flight check before the wallet is read again.
 *
 * Short enough that a deposit or another instance's charges are seen within seconds; long enough
 * that a run stepping every second or two never pays for the read. See {@link AgentSpendService.canAfford}.
 */
export const AFFORDABILITY_WINDOW_MS = 5_000;

/** Above this many cached wallets, expired ones are swept before a new one is added. */
const WALLET_SNAPSHOT_CAP = 1_000;

/** A team's wallet as last read, kept coherent by this process's own charges until it expires. */
interface WalletSnapshot {
  balanceCents: number;
  pendingMicros: number;
  readAt: number;
}

/**
 * Metering and charging for Lobee.
 *
 * THE SHAPE OF THE PROBLEM. One agent call is worth a fraction of a cent, and a wallet is
 * denominated in whole cents. Charging per call therefore cannot mean "debit the wallet per call":
 * rounding up overcharges a long conversation many times over, and rounding down means the model
 * time is free. Spend is accrued in micro-USD instead, and the wallet is only touched when the
 * accrual has crossed a whole cent — so the remainder is carried, not invented and not lost.
 *
 * WHY POST-CHARGE, AND WHY A RESERVE CHECK AS WELL. The cost of a completion is not knowable until
 * it has been produced, so the charge has to follow the call. On its own that lets a team with an
 * empty balance keep spending. {@link canAfford} is the other half: it refuses the NEXT call when
 * the balance cannot cover an estimate of it, which bounds what an exhausted team can overspend to
 * a single call rather than a whole run.
 */
@Injectable()
export class AgentSpendService {
  private readonly logger = new Logger(AgentSpendService.name);

  /** The margin over raw model cost. Resolved once at boot — it is a deployment decision. */
  readonly marginMultiplier: number;

  private readonly wallets = new Map<string, WalletSnapshot>();
  /** Wall clock, overridable by tests that need to move it. */
  private now = (): number => Date.now();

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly repo: BillingRepository,
    config: ConfigService,
  ) {
    this.marginMultiplier = resolveAgentMargin(config.get<string>('LOBSTER_AGENT_MARGIN'));
  }

  /** True when we know what a model costs. A model we cannot price must be refused, not served. */
  isPriced(model: string): boolean {
    return agentModelPrice(model) !== undefined;
  }

  /**
   * What a call is likely to cost before it runs, in micro-USD, or undefined for a model with no
   * known price.
   */
  estimateMicros(args: {
    model: string;
    tokensIn: number;
    maxTokensOut: number;
  }): number | undefined {
    return estimateAgentCostMicros(args, this.marginMultiplier);
  }

  /**
   * Can this team afford one more call?
   *
   * The standing accrual counts against the balance. It is spend already incurred and not yet
   * charged, so ignoring it would let a team that is exactly at zero keep starting calls that can
   * never be paid for.
   *
   * READ ONCE PER WINDOW, NOT ONCE PER STEP. This check sits in front of every Lobee step, and it
   * used to cost two wallet reads (one of them an upsert) before the model was even contacted — a
   * measurable slice of a step on a loaded Postgres, with two concurrent runs on one team
   * serialising on the same wallet row for it. The wallet is now read into a {@link WalletSnapshot}
   * and the check is answered from that for {@link AFFORDABILITY_WINDOW_MS}. The snapshot is not
   * blind in the meantime: every charge this process makes moves it by exactly what the ledger
   * moved ({@link followCharge}), so within the window it lags the database only by what OTHER
   * writers did — a deposit landing, another instance's charges — and that lag is bounded by the
   * window. What the window bounds is overspend: a team going from solvent to empty can start at
   * most a window's worth of calls past the point a fresh read would have refused.
   *
   * A refusal is never served from the snapshot. It evicts it, so the very next attempt reads the
   * wallet again and a top-up is honoured the moment it lands rather than up to a window later.
   */
  async canAfford(teamId: string, estimatedMicros: number): Promise<AgentAffordability> {
    const wallet = await this.walletSnapshot(teamId);
    // Rounded UP: a reserve that rounds down reserves less than the call can cost, which is the
    // one direction the check exists to prevent.
    const requiredCents = Math.ceil(
      (wallet.pendingMicros + Math.max(0, estimatedMicros)) / MICROS_PER_CENT,
    );
    const ok = wallet.balanceCents >= requiredCents;
    if (!ok) this.wallets.delete(teamId);
    return { ok, balanceCents: wallet.balanceCents, requiredCents };
  }

  /**
   * Charge one completed call, and write the row that explains it.
   *
   * The accrual is credited first and only then flushed, so a crash anywhere in the middle leaves
   * the team UNDER-charged rather than double-charged — the micros stay accrued and the next call
   * flushes them. That direction is deliberate: an un-flushed cent is a cent we collect a minute
   * later, while a double-charged one is a support ticket and a refund.
   */
  async charge(request: AgentChargeRequest): Promise<AgentChargeResult> {
    const { teamId, userId, profileId, sessionId } = request;
    const costMicros = computeAgentCostMicros(request, this.marginMultiplier);

    if (costMicros === undefined) {
      // Unpriceable, and already served — the refusal belongs in the pre-flight check, so reaching
      // here means one slipped past it. Record the call at zero so the usage audit still shows it
      // happened rather than pretending the tokens were never spent.
      this.logger.warn(`agent spend unpriced model=${request.model} team=${teamId}`);
      await this.repo.recordAgentUsage({
        teamId,
        userId,
        profileId,
        sessionId,
        model: request.model,
        tokensIn: request.tokensIn,
        tokensOut: request.tokensOut,
        cachedIn: request.cachedIn,
        costMicros: 0,
        chargedCents: 0,
      });
      return {
        priced: false,
        costMicros: 0,
        chargedCents: 0,
        pendingMicros: await this.repo.getAgentAccruedMicros(teamId),
        unpaidCents: 0,
      };
    }

    const { chargedCents, pendingMicros, unpaidCents } = await this.flush(teamId, costMicros);
    this.followCharge(teamId, chargedCents, pendingMicros);

    await this.repo.recordAgentUsage({
      teamId,
      userId,
      profileId,
      sessionId,
      model: request.model,
      tokensIn: request.tokensIn,
      tokensOut: request.tokensOut,
      cachedIn: request.cachedIn,
      costMicros,
      chargedCents,
    });

    return { priced: true, costMicros, chargedCents, pendingMicros, unpaidCents };
  }

  /** Newest-first usage rows, for explaining a charge to the team that disputes it. */
  async listUsage(teamId: string, limit = 50): Promise<AgentUsageRow[]> {
    return this.repo.listAgentUsage(teamId, limit);
  }

  /** The team's wallet as read within the current window, or read afresh. */
  private async walletSnapshot(teamId: string): Promise<WalletSnapshot> {
    const now = this.now();
    const cached = this.wallets.get(teamId);
    if (cached && now - cached.readAt < AFFORDABILITY_WINDOW_MS) return cached;
    if (this.wallets.size >= WALLET_SNAPSHOT_CAP) this.evictExpired(now);
    const [balanceCents, pendingMicros] = await Promise.all([
      this.repo.getBalanceCents(teamId),
      this.repo.getAgentAccruedMicros(teamId),
    ]);
    const fresh: WalletSnapshot = { balanceCents, pendingMicros, readAt: now };
    this.wallets.set(teamId, fresh);
    return fresh;
  }

  /**
   * Keep the snapshot honest about what this process just did to the ledger.
   *
   * `flush` reports the cents it moved and the accrual it left behind, which is exactly the state
   * the next pre-flight needs; applying it here makes a step's own spend visible to the following
   * step without a round trip, so the window only has to cover what others did.
   */
  private followCharge(teamId: string, chargedCents: number, pendingMicros: number): void {
    const wallet = this.wallets.get(teamId);
    if (!wallet) return;
    wallet.balanceCents -= chargedCents;
    wallet.pendingMicros = pendingMicros;
  }

  private evictExpired(now: number): void {
    for (const [teamId, wallet] of this.wallets) {
      if (now - wallet.readAt >= AFFORDABILITY_WINDOW_MS) this.wallets.delete(teamId);
    }
  }

  /**
   * Accrue `costMicros` and move whatever whole cents that produces onto the wallet.
   *
   * The debit goes through the ordinary `move` — the same conditional UPDATE that guards every
   * other debit in the product. Agent spend gets no debit mechanism of its own, so there is exactly
   * one place in the codebase where a balance can go down, and exactly one place to audit.
   */
  private async flush(
    teamId: string,
    costMicros: number,
  ): Promise<{ chargedCents: number; pendingMicros: number; unpaidCents: number }> {
    let pendingMicros = await this.repo.accrueAgentMicros(teamId, costMicros);
    const owedCents = Math.floor(pendingMicros / MICROS_PER_CENT);
    if (owedCents <= 0) return { chargedCents: 0, pendingMicros, unpaidCents: 0 };

    // Charge what the balance can actually cover. `move` refuses an overdraw outright, so asking
    // for the full amount against a short balance would charge NOTHING and let the debt keep
    // growing; taking the affordable part instead leaves only the genuinely unpayable remainder.
    const balanceCents = await this.repo.getBalanceCents(teamId);
    const chargeableCents = Math.min(owedCents, Math.max(balanceCents, 0));
    if (chargeableCents <= 0) {
      return { chargedCents: 0, pendingMicros, unpaidCents: owedCents };
    }

    // Claim before charging. The claim is the exclusive right to flush these micros — a concurrent
    // call that crossed the same cent finds the accrual already reduced and backs off instead of
    // charging the team twice for one cent.
    const claimed = await this.repo.claimAgentMicros(teamId, chargeableCents * MICROS_PER_CENT);
    if (!claimed) {
      return {
        chargedCents: 0,
        pendingMicros: await this.repo.getAgentAccruedMicros(teamId),
        unpaidCents: 0,
      };
    }

    const tx = await this.repo.move({
      teamId,
      kind: 'agent_usage',
      amountCents: -chargeableCents,
      description: 'Lobee agent usage',
      metadata: { costMicros, flushedMicros: chargeableCents * MICROS_PER_CENT },
    });

    if (!tx) {
      // The balance moved between the read and the debit. Put the micros back so the spend is
      // still owed and the next call retries it — dropping them here would be a silent write-off.
      pendingMicros = await this.repo.accrueAgentMicros(teamId, chargeableCents * MICROS_PER_CENT);
      return { chargedCents: 0, pendingMicros, unpaidCents: owedCents };
    }

    return {
      chargedCents: chargeableCents,
      pendingMicros: await this.repo.getAgentAccruedMicros(teamId),
      unpaidCents: owedCents - chargeableCents,
    };
  }
}
