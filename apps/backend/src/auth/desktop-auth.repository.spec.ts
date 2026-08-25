import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import {
  constantTimeEquals,
  InMemoryDesktopAuthRepository,
  PrismaDesktopAuthRepository,
  type StoredGrant,
} from './desktop-auth.repository';

const CODE_HASH = 'code-hash';
const STATE = 'state-for-one-launcher-instance';
const CHALLENGE = 'c'.repeat(43);

test('constantTimeEquals has exact byte semantics for equal and unequal-length OAuth proofs', () => {
  assert.equal(constantTimeEquals(STATE, STATE), true);
  assert.equal(constantTimeEquals(`${STATE.slice(0, -1)}x`, STATE), false);
  assert.equal(constantTimeEquals(STATE.slice(0, -1), STATE), false);
  assert.equal(constantTimeEquals(`${STATE}x`, STATE), false);
  assert.equal(
    constantTimeEquals('caf\u00e9', 'cafe\u0301'),
    false,
    'Unicode is compared as UTF-8 bytes',
  );
});

test('wrong state and PKCE proofs do not claim an in-memory desktop grant', async () => {
  const repository = new InMemoryDesktopAuthRepository();
  await repository.create({
    codeHash: CODE_HASH,
    state: STATE,
    codeChallenge: CHALLENGE,
    userId: 'user-desktop',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
  });

  const now = new Date('2029-01-01T00:00:00.000Z');
  assert.equal(await repository.redeem(CODE_HASH, `${STATE}x`, CHALLENGE, now), null);
  assert.equal(await repository.redeem(CODE_HASH, STATE, `${CHALLENGE}x`, now), null);
  assert.equal(await repository.redeem(CODE_HASH, `${STATE.slice(0, -1)}x`, CHALLENGE, now), null);
  assert.equal(await repository.redeem(CODE_HASH, STATE, `${CHALLENGE.slice(0, -1)}x`, now), null);

  const claimed = await repository.redeem(CODE_HASH, STATE, CHALLENGE, now);
  assert.equal(claimed?.userId, 'user-desktop', 'failed proofs must not burn the valid grant');
  assert.equal(
    await repository.redeem(CODE_HASH, STATE, CHALLENGE, now),
    null,
    'claim stays single-use',
  );
});

test('the Prisma repository verifies proofs before its atomic single-use claim', async () => {
  const grant: StoredGrant = {
    id: 'grant-1',
    codeHash: CODE_HASH,
    state: STATE,
    codeChallenge: CHALLENGE,
    userId: 'user-desktop',
    expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    redeemedAt: null,
  };
  const claims: unknown[] = [];
  const tx = {
    desktopAuthGrant: {
      findUnique: async (args: unknown) => {
        assert.deepEqual(args, { where: { codeHash: CODE_HASH } });
        return grant;
      },
      updateMany: async (args: unknown) => {
        claims.push(args);
        return { count: 1 };
      },
    },
  };
  const prisma = {
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx),
  } as unknown as PrismaService;
  const repository = new PrismaDesktopAuthRepository(prisma);
  const now = new Date('2029-01-01T00:00:00.000Z');

  assert.equal(await repository.redeem(CODE_HASH, `${STATE}x`, CHALLENGE, now), null);
  assert.equal(await repository.redeem(CODE_HASH, STATE, `${CHALLENGE}x`, now), null);
  assert.equal(claims.length, 0, 'a bad launcher proof must never reach the claiming write');

  const claimed = await repository.redeem(CODE_HASH, STATE, CHALLENGE, now);
  assert.equal(claimed?.redeemedAt, now);
  assert.deepEqual(claims, [
    {
      where: { id: grant.id, redeemedAt: null, expiresAt: { gt: now } },
      data: { redeemedAt: now },
    },
  ]);
});
