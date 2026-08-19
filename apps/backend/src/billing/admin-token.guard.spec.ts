import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { AdminTokenGuard } from './admin-token.guard';

function guard(token?: string): AdminTokenGuard {
  return new AdminTokenGuard({ get: () => token } as unknown as ConfigService);
}

function requestWith(headers: Record<string, string | string[] | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

test('a deployment with no admin token refuses the endpoint outright', () => {
  // Not "allow anything": these routes charge every due subscription in the database, and a
  // deployment that forgot to configure the secret must not find that out from a stranger.
  assert.throws(
    () => guard(undefined).canActivate(requestWith({ 'x-admin-token': 'anything' })),
    ServiceUnavailableException,
  );
  assert.throws(
    () => guard('   ').canActivate(requestWith({ 'x-admin-token': '   ' })),
    ServiceUnavailableException,
    'whitespace is not a secret',
  );
});

test('the wrong token, and no token at all, are both refused', () => {
  const g = guard('the-real-token');

  assert.throws(
    () => g.canActivate(requestWith({ 'x-admin-token': 'the-real-toke' })),
    UnauthorizedException,
    'a prefix of the secret is not the secret',
  );
  assert.throws(() => g.canActivate(requestWith({})), UnauthorizedException);
});

test('the configured token is accepted, however the proxy presented the header', () => {
  const g = guard('the-real-token');

  assert.equal(g.canActivate(requestWith({ 'x-admin-token': 'the-real-token' })), true);
  // Node reports a repeated header as an array; a cron behind a proxy that duplicates it must not
  // be locked out of the only way it has to run billing.
  assert.equal(g.canActivate(requestWith({ 'x-admin-token': ['the-real-token'] })), true);
});
