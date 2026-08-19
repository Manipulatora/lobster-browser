import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConfigService } from '@nestjs/config';

import type { UsersRepository } from '../auth/users.repository';
import type { MailService } from '../mail/mail.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { BillingService } from './billing.service';
import { DepositReconciliationService } from './deposit-reconciliation.service';
import { InMemoryBillingRepository } from './in-memory-billing.repository';
import type { CreatedDeposit, ParsedWebhook, PaymentProvider } from './payments/payment-provider';

const TEAM = 'team-1';
const USER = 'user-1';

/** A processor whose IPNs NEVER verify, which is the outage this service exists to survive. */
interface SilentProvider extends PaymentProvider {
  /** Answers keyed by the processor's own (un-namespaced) payment id. */
  states: Map<string, ParsedWebhook>;
  lookups: string[];
}

function silentProvider(): SilentProvider {
  const states = new Map<string, ParsedWebhook>();
  const lookups: string[] = [];
  let n = 0;
  return {
    states,
    lookups,
    name: 'stub',
    isConfigured: () => true,
    supportsCurrency: () => true,
    createDeposit: async (): Promise<CreatedDeposit> => {
      n += 1;
      return {
        providerPaymentId: `pay-${n}`,
        address: '0xabc',
        amountCrypto: '10.0',
        asset: 'USDT',
        chain: 'usdtbsc',
      };
    },
    // Every callback is rejected — a re-serialisation mismatch looks exactly like this.
    verifyWebhook: () => null,
    fetchPayment: async (id: string) => {
      lookups.push(id);
      return states.get(id) ?? null;
    },
  };
}

function makeService(): {
  reconcile: DepositReconciliationService;
  billing: BillingService;
  repo: InMemoryBillingRepository;
  payments: SilentProvider;
} {
  const repo = new InMemoryBillingRepository();
  const payments = silentProvider();
  const teams = {
    getMembership: async (teamId: string, userId: string) =>
      teamId === TEAM && userId === USER
        ? { teamId, userId, role: 'admin' as const, createdAt: '' }
        : null,
    findTeamsForUser: async () => [{ id: TEAM, name: 'T', ownerUserId: USER, createdAt: '' }],
    listMembers: async () => [],
  } as unknown as TeamsRepository;
  const users = { findById: async () => null } as unknown as UsersRepository;
  const mail = { sendDepositReceipt: async () => true } as unknown as MailService;
  const billing = new BillingService(repo, teams, payments, users, mail);
  // '0' keeps the interval unstarted; the tests drive `sweep` directly.
  const config = { get: () => '0' } as unknown as ConfigService;
  return {
    reconcile: new DepositReconciliationService(repo, payments, billing, config),
    billing,
    repo,
    payments,
  };
}

const HOUR = 60 * 60 * 1000;

test('a deposit whose callbacks all failed verification is still credited', async () => {
  const { reconcile, billing, repo, payments } = makeService();
  await billing.createDeposit(USER, 5_000, 'usdtbsc');
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'nothing lands from the webhook path');

  payments.states.set('pay-1', {
    providerPaymentId: 'pay-1',
    status: 'confirmed',
    creditCents: 5_000,
    raw: {},
  });

  const result = await reconcile.sweep(new Date(Date.now() + HOUR));
  assert.equal(result.examined, 1);
  assert.equal(result.settled, 1);
  assert.equal(await repo.getBalanceCents(TEAM), 5_000);

  // The same exactly-once guard the webhook path uses, so a later callback or a second sweep is
  // a no-op rather than a second credit.
  const again = await reconcile.sweep(new Date(Date.now() + HOUR));
  assert.equal(again.examined, 0, 'a settled deposit is no longer unsettled');
  assert.equal(await repo.getBalanceCents(TEAM), 5_000);
});

test('a deposit nobody has paid yet is left alone', async () => {
  const { reconcile, billing, repo, payments } = makeService();
  await billing.createDeposit(USER, 5_000, 'usdtbsc');

  payments.states.set('pay-1', { providerPaymentId: 'pay-1', status: 'pending', raw: {} });

  const result = await reconcile.sweep(new Date(Date.now() + HOUR));
  assert.equal(result.settled, 0);
  assert.equal(result.unchanged, 1);
  assert.equal(await repo.getBalanceCents(TEAM), 0);
});

test('a freshly issued address is not polled about', async () => {
  const { reconcile, billing, payments } = makeService();
  await billing.createDeposit(USER, 5_000, 'usdtbsc');

  // A payment gets its own window to arrive before we start asking after it — otherwise every
  // deposit page opened is an outbound request within minutes.
  const result = await reconcile.sweep(new Date());
  assert.equal(result.examined, 0);
  assert.deepEqual(payments.lookups, []);
});

test('an unconfigured processor is not polled at all', async () => {
  const { reconcile, billing, payments } = makeService();
  await billing.createDeposit(USER, 5_000, 'usdtbsc');
  payments.isConfigured = () => false;

  const result = await reconcile.sweep(new Date(Date.now() + HOUR));
  assert.deepEqual(result, { examined: 0, settled: 0, unchanged: 0 });
  assert.deepEqual(payments.lookups, []);
});
