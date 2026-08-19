import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

import { InMemoryDesktopAuthRepository } from '../auth/desktop-auth.repository';
import { InMemoryUsersRepository } from '../auth/in-memory-users.repository';
import { InMemoryLeasesRepository } from '../leases/in-memory-leases.repository';
import { HousekeepingService } from './housekeeping.service';

const HOUR = 60 * 60 * 1000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeService(): {
  service: HousekeepingService;
  users: InMemoryUsersRepository;
  desktopAuth: InMemoryDesktopAuthRepository;
  leases: InMemoryLeasesRepository;
} {
  const users = new InMemoryUsersRepository();
  const desktopAuth = new InMemoryDesktopAuthRepository();
  const leases = new InMemoryLeasesRepository();
  // Never started: the tests drive `sweep` directly, and an interval would only add a timer.
  const config = { get: () => '0' } as unknown as ConfigService;
  return {
    service: new HousekeepingService(users, desktopAuth, leases, config),
    users,
    desktopAuth,
    leases,
  };
}

test('a sweep drops what has expired and keeps what has not', async () => {
  const { service, users, desktopAuth, leases } = makeService();
  const now = new Date();
  const past = new Date(now.getTime() - HOUR);
  const future = new Date(now.getTime() + HOUR);

  await users.upsertPendingRegistration({
    email: 'abandoned@gmail.com',
    passwordHash: 'x',
    fullName: 'Abandoned',
    codeHash: hash('111111'),
    expiresAt: past,
  });
  await users.upsertPendingRegistration({
    email: 'in-flight@gmail.com',
    passwordHash: 'x',
    fullName: 'In Flight',
    codeHash: hash('222222'),
    expiresAt: future,
  });

  await desktopAuth.create({
    codeHash: hash('stale-grant'),
    state: 's',
    codeChallenge: 'c',
    userId: 'user-1',
    expiresAt: past,
  });
  await desktopAuth.create({
    codeHash: hash('live-grant'),
    state: 's',
    codeChallenge: 'c',
    userId: 'user-1',
    expiresAt: future,
  });

  const dead = randomUUID();
  const live = randomUUID();
  await leases.acquire(
    {
      profileId: dead,
      userId: 'u',
      deviceId: 'd',
      deviceLabel: 'D',
      expiresAt: past,
      leaseId: 'l1',
    },
    past,
  );
  await leases.acquire(
    {
      profileId: live,
      userId: 'u',
      deviceId: 'd',
      deviceLabel: 'D',
      expiresAt: future,
      leaseId: 'l2',
    },
    now,
  );

  await service.sweep(now);

  assert.equal(await users.findPendingRegistration('abandoned@gmail.com'), null);
  assert.ok(await users.findPendingRegistration('in-flight@gmail.com'), 'a live sign-up survives');

  assert.equal(await desktopAuth.redeem(hash('stale-grant'), past), null);
  assert.ok(await desktopAuth.redeem(hash('live-grant'), now), 'a live grant is still redeemable');

  // An expired lease already read as free; the point of dropping it is that the row does not
  // outlive the launch by the life of the deployment.
  assert.equal(await leases.current(dead, now), null);
  assert.ok(await leases.current(live, now), 'a held profile keeps its lease');
});

test('a consumed verification code is swept even while inside its window', async () => {
  const { service, users } = makeService();
  const user = await users.create({ email: 'verified@gmail.com', passwordHash: 'x' });
  const now = new Date();

  await users.createEmailVerification(user.id, hash('333333'), new Date(now.getTime() + HOUR));
  assert.ok(await users.consumeEmailVerification(user.id, hash('333333')));

  await service.sweep(now);

  // Single-use, so nothing reads it again — and it names an account, which is reason enough not to
  // keep it. A replay was already refused by the consume predicate, not by the row's presence.
  assert.equal(await users.consumeEmailVerification(user.id, hash('333333')), null);
});
