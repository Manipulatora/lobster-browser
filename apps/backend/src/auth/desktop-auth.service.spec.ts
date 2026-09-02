import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { UnauthorizedException } from '@nestjs/common';
import type { User } from '@lobster/shared-types';

import type { AuthService } from './auth.service';
import { InMemoryDesktopAuthRepository } from './desktop-auth.repository';
import { DesktopAuthService } from './desktop-auth.service';

const USER: User = {
  id: 'user-desktop',
  email: 'desktop@gmail.com',
  createdAt: '2026-08-23T00:00:00.000Z',
};
const STATE = 'state-for-one-launcher-instance';
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function makeService(): DesktopAuthService {
  const auth = {
    // The exchange must mint from the account as it stands at redemption (the current session
    // version), so it hands the id back to AuthService rather than signing from a stale copy.
    issueSessionFor: async (id: string, audience: string) => {
      assert.equal(id, USER.id);
      assert.equal(audience, 'desktop');
      return { user: USER, token: 'desktop-token' };
    },
  } as unknown as AuthService;
  return new DesktopAuthService(new InMemoryDesktopAuthRepository(), auth);
}

async function issue(service: DesktopAuthService): Promise<string> {
  return (
    await service.issueGrant({
      userId: USER.id,
      state: STATE,
      codeChallenge: CHALLENGE,
      port: 43125,
    })
  ).code;
}

test('an invalid PKCE or state attempt cannot burn a desktop authorization code', async () => {
  const service = makeService();
  const code = await issue(service);

  await assert.rejects(
    service.exchange({ code, state: STATE, codeVerifier: 'x'.repeat(43) }),
    UnauthorizedException,
  );
  await assert.rejects(
    service.exchange({ code, state: 'wrong-launcher-state', codeVerifier: VERIFIER }),
    UnauthorizedException,
  );

  const result = await service.exchange({ code, state: STATE, codeVerifier: VERIFIER });
  assert.equal(result.token, 'desktop-token');
  assert.equal(result.user.id, USER.id);
});

test('a valid desktop authorization code is still single-use under a race', async () => {
  const service = makeService();
  const code = await issue(service);
  const attempts = await Promise.allSettled([
    service.exchange({ code, state: STATE, codeVerifier: VERIFIER }),
    service.exchange({ code, state: STATE, codeVerifier: VERIFIER }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
});
