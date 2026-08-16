import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { AuthService, type AuthResult } from './auth.service';
import {
  DESKTOP_AUTH_REPOSITORY,
  type DesktopAuthRepository,
} from './desktop-auth.repository';

/**
 * How long a code stays redeemable.
 *
 * Short on purpose. The launcher is already listening when the browser redirects, so the gap
 * between issue and redemption is milliseconds; five minutes is generous headroom for a slow
 * machine, and every second beyond that is time a leaked code stays useful.
 */
const CODE_TTL_MS = 5 * 60 * 1000;

/** Only loopback ports above the privileged range are accepted as a callback target. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/**
 * Desktop launcher authorisation — the loopback handoff (RFC 8252).
 *
 * THE FLOW, end to end:
 *
 *   1. The launcher picks a random `state` and a random `verifier`, derives
 *      `challenge = base64url(SHA256(verifier))`, and starts an HTTP listener on 127.0.0.1:<port>.
 *   2. It opens the system browser at
 *      `lobrowser.com/login?desktop=1&state=…&port=…&challenge=…`.
 *   3. The user signs up or logs in on the website as normal, producing a web session.
 *   4. The website calls `issueGrant` with that session and the parameters from the URL, and gets
 *      back a one-time `code`.
 *   5. The website redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`, then shows the
 *      "you can close this tab" page.
 *   6. The launcher checks `state`, then calls `exchange` over HTTPS with the code AND the
 *      verifier, and receives the real token.
 *
 * WHAT EACH PIECE DEFENDS AGAINST, since a loopback redirect has several distinct weaknesses and
 * one mitigation does not cover them all:
 *
 *   `state`     — a code minted for one launcher instance being replayed into another, and CSRF
 *                 on the callback endpoint.
 *   PKCE        — a hostile local process binding the callback port and stealing the code. It
 *                 cannot redeem it: the verifier never travels through the browser.
 *   single-use  — replay of a code captured from browser history or a proxy log.
 *   short TTL   — the window in which any of the above is worth attempting.
 *
 * The bearer token itself never appears in a URL, a redirect, or the browser at all.
 */
@Injectable()
export class DesktopAuthService {
  constructor(
    @Inject(DESKTOP_AUTH_REPOSITORY) private readonly repo: DesktopAuthRepository,
    private readonly auth: AuthService,
  ) {}

  /**
   * Mint a one-time code for an already-authenticated web user.
   *
   * Called by the WEBSITE with the user's web session, never by the launcher — the launcher has no
   * credentials at this point, which is the entire reason this dance exists.
   */
  async issueGrant(args: {
    userId: string;
    state: string;
    codeChallenge: string;
    port: number;
  }): Promise<{ code: string; redirectUrl: string }> {
    const { userId, state, codeChallenge, port } = args;

    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new BadRequestException('invalid callback port');
    }
    // Length floors, not format checks: these are opaque to us, but a short `state` or a truncated
    // challenge would silently weaken the binding they exist to provide.
    if (state.length < 16 || state.length > 256) {
      throw new BadRequestException('invalid state');
    }
    if (codeChallenge.length < 43 || codeChallenge.length > 256) {
      throw new BadRequestException('invalid code challenge');
    }

    const code = randomBytes(32).toString('base64url');

    await this.repo.create({
      // Stored hashed. A read of this table — a backup, a log, a compromised replica — must not
      // yield anything redeemable. SHA-256 without a salt is right here and bcrypt would be wrong:
      // the input is 256 bits of CSPRNG output, so there is no dictionary to attack, and the
      // lookup has to be a fast exact match by hash.
      codeHash: sha256(code),
      state,
      codeChallenge,
      userId,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    // Built here rather than by the caller, so the redirect target can only ever be loopback. A
    // caller-supplied URL would be an open redirect on an endpoint that hands out session codes.
    const redirectUrl = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(
      code,
    )}&state=${encodeURIComponent(state)}`;

    return { code, redirectUrl };
  }

  /**
   * Redeem a code for a real session. Called by the LAUNCHER over HTTPS.
   *
   * Every failure returns the same message. Distinguishing "expired" from "already used" from
   * "wrong verifier" would tell someone probing with a captured code exactly which part of their
   * attempt was wrong.
   */
  async exchange(args: {
    code: string;
    state: string;
    codeVerifier: string;
  }): Promise<AuthResult> {
    const invalid = (): never => {
      throw new UnauthorizedException('invalid or expired authorization code');
    };

    const grant = await this.repo.redeem(sha256(args.code), new Date());
    // The claim already enforced existence, expiry and single-use atomically. Anything else is
    // checked below against the row it returned.
    if (!grant) return invalid();

    if (!constantTimeEquals(grant.state, args.state)) return invalid();

    // PKCE proof: the caller must present the preimage of the challenge submitted at issue time.
    if (!constantTimeEquals(grant.codeChallenge, sha256Base64Url(args.codeVerifier))) {
      return invalid();
    }

    // Re-resolve the user rather than trusting the stored id: an account deleted between issue and
    // redemption must not yield a working token.
    const user = await this.auth.validateUser(grant.userId);
    return { user, token: this.auth.issueTokenFor(user.id, user.email) };
  }
}

/** Hex SHA-256, for the code lookup key. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** base64url SHA-256, the PKCE challenge encoding (RFC 7636 S4.2). */
function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('base64url');
}

/**
 * Constant-time string comparison. A plain `===` short-circuits on the first differing byte, which
 * leaks through timing how much of a guess was correct — enough to reconstruct a secret one byte
 * at a time. Length is compared first because `timingSafeEqual` throws on mismatched lengths, and
 * length is not the secret.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
