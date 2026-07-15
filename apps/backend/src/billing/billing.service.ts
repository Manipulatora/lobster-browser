import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlanTier } from '@lobster/shared-types';

import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';

// NOTE: Stripe is a declared dependency but is only used in the COMMENTED stubs below.
// Uncomment the import + client once STRIPE_SECRET_KEY is wired (Day 2/3).
// import Stripe from 'stripe';

/** Result of creating a Stripe Checkout session — client redirects to `url`. */
export interface CheckoutSession {
  sessionId: string;
  url: string;
}

/** Minimal acknowledgement returned to Stripe after a webhook is processed. */
export interface WebhookAck {
  received: true;
  handled: boolean;
}

/**
 * Billing logic. Metered on PROFILE COUNT: a team's plan sets `Subscription.profileLimit`,
 * and usage records track how many profiles the team has provisioned.
 *
 * Day 0 STUB — no real Stripe calls. Keys are read from config, NEVER hardcoded.
 */
@Injectable()
export class BillingService {
  // private readonly stripe: Stripe;

  constructor(
    private readonly config: ConfigService,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
  ) {
    // TODO(Day 2): construct the Stripe client from config (throw if the key is missing).
    // const apiKey = this.config.getOrThrow<string>('STRIPE_SECRET_KEY');
    // this.stripe = new Stripe(apiKey, { apiVersion: '2024-06-20' });
    void this.config;
  }

  /**
   * Resolve the team to bill from the AUTHENTICATED caller — mirrors ProfilesService: an explicit
   * `teamId` is honored only if the caller is a member; otherwise the caller's own team is used. A
   * team id is never trusted from the request body.
   */
  private async resolveTeamId(userId: string, teamId?: string): Promise<string> {
    if (teamId) {
      const membership = await this.teams.getMembership(teamId, userId);
      if (!membership) {
        throw new ForbiddenException('you are not a member of the requested team');
      }
      return teamId;
    }
    const teams = await this.teams.findTeamsForUser(userId);
    const first = teams[0];
    if (!first) {
      throw new ForbiddenException('you do not belong to any team');
    }
    return first.id;
  }

  /**
   * Create a Stripe Checkout session for a team to subscribe to `tier`.
   * STUB returns a fake URL. Real implementation (Day 2/3):
   *
   *   const session = await this.stripe.checkout.sessions.create({
   *     mode: 'subscription',
   *     customer: subscription.stripeCustomerId,     // create/lookup a Customer for the team
   *     line_items: [{ price: PRICE_ID_BY_TIER[tier], quantity: 1 }],
   *     // Metered-on-profile-count add-on:
   *     //   report usage with stripe.billing.meterEvents.create({ event_name: 'profiles',
   *     //   payload: { value, stripe_customer_id } }) whenever profile count changes.
   *     success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
   *     cancel_url: `${APP_URL}/billing/cancel`,
   *     metadata: { teamId, tier },
   *   });
   *   return { sessionId: session.id, url: session.url! };
   */
  async createCheckoutSession(
    userId: string,
    tier: PlanTier,
    teamId?: string,
  ): Promise<CheckoutSession> {
    const ownerTeamId = await this.resolveTeamId(userId, teamId);
    return {
      sessionId: `cs_stub_${ownerTeamId}_${tier}`,
      url: `https://checkout.stripe.com/stub/${ownerTeamId}?tier=${tier}`,
    };
  }

  /**
   * Handle a Stripe webhook. STUB acknowledges without processing.
   * Real implementation (Day 2/3):
   *
   *   const secret = this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
   *   // `payload` MUST be the raw request body (configure a raw body parser for this route).
   *   const event = this.stripe.webhooks.constructEvent(payload, signature, secret);
   *   switch (event.type) {
   *     case 'checkout.session.completed':      // activate the subscription, set tier + profileLimit
   *     case 'customer.subscription.updated':   // sync status/tier
   *     case 'customer.subscription.deleted':   // downgrade to free
   *   }
   *
   * @param payload   raw request body bytes (required for signature verification)
   * @param signature value of the `Stripe-Signature` header
   */
  async handleWebhook(payload: Buffer, signature: string): Promise<WebhookAck> {
    void payload;
    void signature;
    // TODO(Day 2): verify signature and dispatch on event.type; never trust an unverified body.
    return { received: true, handled: false };
  }
}
