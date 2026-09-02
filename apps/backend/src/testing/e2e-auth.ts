import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import type { MailService } from '../mail/mail.service';

/**
 * Test scaffolding for signing a user up over HTTP.
 *
 * WHY THIS EXISTS. Sign-up is now two steps: `POST /auth/register` creates nothing and emails a
 * code, and `POST /auth/verify-email` is what creates the account and returns a session. Every e2e
 * spec that needs "a user with a token" therefore needs the emailed code, which means every one of
 * them needs a MailService it can read. That was previously eight copies of a two-line helper; it
 * is one helper here so the next change to the flow is one edit.
 */

/** A MailService stand-in that records the codes it was asked to send. */
export interface MailCapture extends MailService {
  /** Every code mailed — sign-up and password reset alike — oldest first. */
  codes: string[];
  lastCode(): string;
  /** Addresses told that a sign-up was already in progress (`sendRegistrationAlreadyPending`). */
  alreadyPendingNotices: string[];
}

/**
 * A capturing MailService, for `.overrideProvider(MailService).useValue(...)`.
 *
 * Reports itself as configured so the service behaves as it would in production; the codes go into
 * an array instead of an inbox. Note the real MailService is also *deliberately* inert in tests
 * (SMTP_HOST is blanked in every spec's `before`), which is what stopped the suite mailing real
 * addresses from the production mailbox — but inert also means the code is unreadable, hence this.
 */
export function createMailCapture(): MailCapture {
  const codes: string[] = [];
  const alreadyPendingNotices: string[] = [];
  return {
    codes,
    alreadyPendingNotices,
    lastCode: () => codes[codes.length - 1] ?? '',
    isConfigured: () => true,
    send: async () => true,
    sendVerification: async (_to: string, code: string) => {
      codes.push(code);
      return true;
    },
    sendPasswordReset: async (_to: string, code: string) => {
      codes.push(code);
      return true;
    },
    sendRegistrationAlreadyPending: async (to: string) => {
      alreadyPendingNotices.push(to);
      return true;
    },
    sendDepositReceipt: async () => true,
  } as unknown as MailCapture;
}

/**
 * Mail providers the API accepts at sign-up. Mirrors `ALLOWED_EMAIL_DOMAINS` in AuthService.
 */
const ALLOWED_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
];

/**
 * Force an address onto an accepted provider, keeping its local part.
 *
 * The specs use distinct local parts (`profiles-bulk@…`, `audit-a@…`) to keep accounts isolated,
 * and none of them is testing the provider rule — that has its own tests in auth.service.spec.ts.
 * Rewriting the domain here keeps those local parts meaningful without rewriting several dozen
 * string literals, and without any spec silently depending on a provider restriction it never
 * mentions.
 */
export function acceptableEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return `${email}@gmail.com`;
  const domain = email.slice(at + 1).toLowerCase();
  return ALLOWED_DOMAINS.includes(domain)
    ? email.toLowerCase()
    : `${email.slice(0, at).toLowerCase()}@gmail.com`;
}

export interface SignedUpUser {
  token: string;
  userId: string;
  email: string;
}

/**
 * Register and verify in one call, returning a usable session.
 *
 * Asserts at both steps rather than returning a partial result: a spec that silently proceeded with
 * an empty token would fail later with a confusing 401 instead of at the line that broke.
 */
export async function signUpOverHttp(
  app: INestApplication,
  mail: MailCapture,
  rawEmail: string,
  password = 'supersecret1',
): Promise<SignedUpUser> {
  const email = acceptableEmail(rawEmail);

  const reg = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password, fullName: 'Test User' });
  assert.ok(
    [200, 201].includes(reg.status),
    `register status ${reg.status}: ${JSON.stringify(reg.body)}`,
  );
  assert.equal(reg.body.data?.pending, true, 'register must return a pending acknowledgement');
  assert.equal(reg.body.data?.token, undefined, 'register must NOT return a session');

  const code = mail.lastCode();
  assert.match(code, /^\d{6}$/, 'a six-digit code should have been mailed');

  const verify = await request(app.getHttpServer())
    .post('/auth/verify-email')
    .send({ email, code });
  assert.ok(
    [200, 201].includes(verify.status),
    `verify status ${verify.status}: ${JSON.stringify(verify.body)}`,
  );

  const token = verify.body.data?.token as string;
  const userId = verify.body.data?.user?.id as string;
  assert.ok(token, 'verify must return a token');
  assert.ok(userId, 'verify must return the created user');

  return { token, userId, email };
}
