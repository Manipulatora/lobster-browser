import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomInt } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { User } from '@lobster/shared-types';

import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { USERS_REPOSITORY, type StoredUser, type UsersRepository } from './users.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { resolveJwtSecret } from './jwt-secret';
import { MailService } from '../mail/mail.service';

/** bcrypt work factor. 10 is the common default: strong enough, ~tens of ms per hash. */
const BCRYPT_COST = 10;

/** How long a verification link stays usable. Long enough for a mail delay, short enough that a
 *  leaked inbox weeks later is not a live credential. */
/**
 * Fifteen minutes. Much shorter than the 24 hours a link could afford: a six-digit code is a
 * 1-in-a-million guess, so the window it stays guessable in is the control that matters.
 */
const VERIFICATION_TTL_MS = 15 * 60 * 1000;

/** A uniformly random 6-digit code, zero-padded so every code is the same length. */
function sixDigitCode(): string {
  // randomInt is rejection-sampled by Node, so this has no modulo bias.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Only what is stored, ever. Whitespace is stripped first so a pasted code with stray spaces or a
 * line break still matches what was mailed.
 */
function hashVerificationCode(code: string): string {
  return createHash('sha256').update(code.replace(/\s+/g, '')).digest('hex');
}

/**
 * Mail providers accepted at sign-up.
 *
 * A product decision, not a technical one: sign-ups are restricted to Google and Microsoft consumer
 * mail. Both aliases of each are included because an "Outlook account" is just as often a hotmail
 * or live address, and rejecting those would read as a bug to the person holding one.
 *
 * ENFORCED SERVER-SIDE, which is the point. The same rule in the sign-up form is a courtesy that
 * saves a round-trip; a client-side check alone is bypassed by anyone posting to the endpoint
 * directly.
 */
const ALLOWED_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
]);

function assertAllowedEmailProvider(email: string): void {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!ALLOWED_EMAIL_DOMAINS.has(domain)) {
    throw new BadRequestException('sign-up is currently limited to Gmail and Outlook addresses');
  }
}

/**
 * What `register` returns now: an acknowledgement, not a session.
 *
 * Deliberately carries no user and no token — there is no account yet. A caller that expected
 * `AuthResult` here fails to compile rather than quietly treating a pending sign-up as a signed-in
 * one, which is the mistake this shape exists to prevent.
 */
export interface PendingRegistrationResult {
  pending: true;
  email: string;
  expiresInMinutes: number;
}

/**
 * A real bcrypt hash (of a throwaway password) compared against when the email is unknown, so an
 * unknown-email login costs the same as a wrong-password login. Without it, skipping the compare
 * for a missing user is a user-enumeration timing oracle ("no such user" returns much faster than
 * "wrong password"). Precomputed once at module load; the plaintext never matches a real password.
 */
const DUMMY_HASH = bcrypt.hashSync('lobster:auth:timing-safe-dummy', BCRYPT_COST);

/** How long an issued token stays valid before the client must log in again. */
const TOKEN_TTL = '7d';

/**
 * How long a DESKTOP LAUNCHER token lasts.
 *
 * Much longer than the web's 7 days, deliberately. A web session lives in `localStorage` on a
 * machine that may be shared, and re-authenticating there costs a password field that is already
 * on screen. The launcher's token lives in the OS keychain, and re-authenticating costs an entire
 * browser round-trip — open a browser, sign in, redirect back — for someone who is trying to open
 * a browser profile. Making a user do that every week is the difference between an app they leave
 * running and an app they resent.
 *
 * The exposure this accepts is bounded by where the token is: the OS credential store, readable
 * only by this user account, cleared on sign-out and on any 401. If a token has to be revoked
 * sooner than this, that needs server-side revocation, which no TTL substitutes for.
 */
const DESKTOP_TOKEN_TTL = '365d';

/**
 * How long a Lobee agent token lasts, in seconds.
 *
 * Minutes, not days, and that asymmetry with {@link DESKTOP_TOKEN_TTL} is the point. This token
 * authorises spend against the operator's model key on behalf of one team, and it travels to a
 * sidecar process rather than living in the OS keychain. Renewing it costs one call the desktop
 * already holds a session for, so there is no user-visible price for keeping the window short.
 */
export const AGENT_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * Who a token was minted for.
 *
 * A SCOPE, not a label. An `agent` token carries a team and buys model time; it is deliberately
 * NOT a session, and {@link JwtAuthGuard} refuses it on the ordinary API — otherwise the
 * short-lived, narrow credential handed to a sidecar would open every account endpoint.
 */
export type TokenAudience = 'web' | 'desktop' | 'agent';

/** What the auth endpoints hand back to a client: the public user + a bearer token. */
export interface AuthResult {
  user: User;
  /** Bearer token the client sends as `Authorization: Bearer <token>`. */
  token: string;
}

/** Claims carried by the signed JWT. `sub` is the user id. */
export interface JwtPayload {
  sub: string;
  email: string;
  /** Absent on tokens issued before scoping existed; those are ordinary sessions. */
  aud?: TokenAudience;
  /** The team an `agent` token spends for. Never present on a session token. */
  teamId?: string;
}

/** An agent token plus what the caller needs to renew it before it expires. */
export interface AgentTokenResult {
  token: string;
  teamId: string;
  expiresInSeconds: number;
}

/**
 * Auth business logic: register/login with hashed passwords and signed JWTs.
 *
 * Storage is abstracted behind `UsersRepository` (in-memory today, Prisma once Postgres
 * is provisioned), so this service runs and is unit-tested without a database.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /**
   * Begin a sign-up. Creates NO account, NO team and NO token.
   *
   * The credentials are held as a pending registration and a code is emailed. Only
   * {@link completeRegistration} turns that into a real account.
   *
   * WHY IT WORKS THIS WAY. Registering used to create the User, the personal Team and a signed
   * token immediately, and mail the code afterwards. Abandoning the form at the code step therefore
   * left a real, signed-in, unverified account behind — and because `users.email` is unique, anyone
   * could register an address they did not control and permanently deny it to its owner. Nothing is
   * created here now, so an abandoned sign-up expires and leaves no trace.
   *
   * The mail is awaited rather than fired and forgotten: there is no account to fall back on, so a
   * failure to send has to surface as a failure to register instead of a silent dead end.
   */
  async register(dto: RegisterDto): Promise<PendingRegistrationResult> {
    // Normalize the email centrally so BOTH the in-memory and Prisma stores behave identically
    // (Postgres lookups are case-sensitive; the in-memory map is not). One canonical form avoids
    // duplicate accounts and login mismatches across backends.
    const email = this.normalizeEmail(dto.email);
    assertAllowedEmailProvider(email);

    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const code = sixDigitCode();

    await this.users.upsertPendingRegistration({
      email,
      passwordHash,
      fullName: dto.fullName.trim(),
      company: dto.company?.trim() || undefined,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    });

    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MS / 60000);

    return { pending: true, email, expiresInMinutes: VERIFICATION_TTL_MS / 60000 };
  }

  /**
   * Finish a sign-up by proving the emailed code. THIS is what creates the account.
   *
   * Public by necessity — there is no session yet, which is exactly what is being established — so
   * the code carries the whole burden. Brute force is bounded in the repository by an attempt
   * counter on the pending row, not here.
   */
  async completeRegistration(emailInput: string, code: string): Promise<AuthResult> {
    const email = this.normalizeEmail(emailInput);
    const pending = await this.users.consumePendingRegistration(
      email,
      hashVerificationCode(code),
      new Date(),
    );
    // Wrong, expired, exhausted or unknown — all one message, so this cannot be used to discover
    // which addresses have a sign-up in flight.
    if (!pending) throw new BadRequestException('that code is incorrect or has expired');

    // Re-check between consuming the code and creating the row: the address could have been
    // registered by another flow while this sign-up sat waiting.
    const existing = await this.users.findByEmail(email);
    if (existing) throw new ConflictException('email already registered');

    const user = await this.users.create({
      email: pending.email,
      passwordHash: pending.passwordHash,
      displayName: pending.fullName,
      company: pending.company,
    });
    // Every user gets a personal team + an admin membership so they always have a place to own
    // profiles the moment the account exists (no separate "create your first team" step).
    const team = await this.teams.createTeam(user.id, this.personalTeamName(user));
    await this.teams.addMember(team.id, user.id, 'admin');

    return { user: this.toPublicUser(user), token: this.signToken(user) };
  }

  /**
   * Re-send the code for a sign-up in flight.
   *
   * Reports success regardless of whether a pending sign-up exists, so this cannot be used to
   * enumerate which addresses are mid-registration.
   */
  async resendRegistrationCode(emailInput: string): Promise<void> {
    const email = this.normalizeEmail(emailInput);
    const pending = await this.users.findPendingRegistration(email);
    if (!pending) return;

    const code = sixDigitCode();
    await this.users.upsertPendingRegistration({
      email: pending.email,
      passwordHash: pending.passwordHash,
      fullName: pending.fullName,
      company: pending.company,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    });
    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MS / 60000);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const now = new Date();
    const user = await this.users.findByEmail(this.normalizeEmail(dto.email));
    // ALWAYS run one bcrypt.compare of the same cost, even when the email is unknown (against a
    // precomputed DUMMY_HASH), so an unknown email is indistinguishable in time from a wrong
    // password. The generic message avoids leaking which half was wrong.
    const passwordMatches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);

    // A run of wrong passwords slows the account down — see `loginBackoffUntil`. Checked AFTER the
    // compare and answered with the same sentence as a wrong password, because a distinct
    // "too many attempts" would turn sign-in into an oracle for which addresses have accounts.
    // The correct password during a backoff window is still refused: otherwise the delay bounds
    // nothing, since a guesser only ever needs the one attempt that happens to be right.
    if (user?.lockedUntil && new Date(user.lockedUntil) > now) {
      throw new UnauthorizedException('invalid email or password');
    }

    if (!user || !passwordMatches) {
      if (user) await this.users.registerFailedLogin(user.id, now);
      throw new UnauthorizedException('invalid email or password');
    }

    await this.users.clearFailedLogins(user.id);
    return { user: this.toPublicUser(user), token: this.signToken(user) };
  }

  /** Resolve the current user for the guard; throws if the id no longer maps to a user. */
  async validateUser(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }
    return this.toPublicUser(user);
  }

  /** JWT signing/verification secret. Hard-fails in production when `JWT_SECRET` is unset. */
  get jwtSecret(): string {
    return resolveJwtSecret(this.config);
  }

  /**
   * Issue a bearer token for an already-authenticated identity.
   *
   * Public so the desktop loopback handoff can mint a token after redeeming an authorisation code
   * — at that point the user has been authenticated by the website, but there is no `StoredUser`
   * in hand and no password to re-verify. It performs NO authentication of its own: callers must
   * have established the identity first.
   */
  issueTokenFor(userId: string, email: string, audience: 'web' | 'desktop' = 'web'): string {
    const payload: JwtPayload = { sub: userId, email, aud: audience };
    return this.jwt.sign(payload, {
      secret: this.jwtSecret,
      expiresIn: audience === 'desktop' ? DESKTOP_TOKEN_TTL : TOKEN_TTL,
    });
  }

  /**
   * Mint a short-lived token scoped to ONE team's agent spend.
   *
   * Exchanged for by a desktop that already holds a session, so it authenticates nothing itself —
   * the caller must have resolved the user and verified their membership of `teamId` first. The
   * team is baked into the claims rather than read from a request body at spend time: a body-borne
   * team id on a metered endpoint is a way to charge someone else's wallet.
   */
  issueAgentToken(args: { userId: string; email: string; teamId: string }): AgentTokenResult {
    const payload: JwtPayload = {
      sub: args.userId,
      email: args.email,
      aud: 'agent',
      teamId: args.teamId,
    };
    return {
      token: this.jwt.sign(payload, {
        secret: this.jwtSecret,
        expiresIn: AGENT_TOKEN_TTL_SECONDS,
      }),
      teamId: args.teamId,
      expiresInSeconds: AGENT_TOKEN_TTL_SECONDS,
    };
  }

  private signToken(user: StoredUser): string {
    return this.issueTokenFor(user.id, user.email);
  }

  /** Canonical email form: trimmed + lowercased. The single normalization point for auth. */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Drop the password hash so it never crosses the wire. */
  private toPublicUser(user: StoredUser): User {
    const { passwordHash: _passwordHash, ...publicUser } = user;
    return publicUser;
  }

  /** Friendly default name for the auto-created personal team. */
  private personalTeamName(user: StoredUser): string {
    return `${user.displayName ?? user.email}'s Team`;
  }

  // --- Verifying an EXISTING account's address --------------------------------
  //
  // Separate from the sign-up flow above, and needed because of it. New accounts are verified the
  // instant they exist — the code is proven before the User row is written — but every account
  // created BEFORE that change is sitting unverified, and the deposit path is closed to them
  // (`EmailVerifiedGuard`). Without this they would have a permanently dead "Enter your code"
  // button and no way to pay.
  //
  // These are the authenticated counterparts of `completeRegistration` / `resendRegistrationCode`:
  // the account already exists, so the session identifies it and the code is checked against that
  // user alone. They use the retained `EmailVerification` table rather than pending registrations.

  /** Mint and mail a code for the signed-in user's own address. */
  async issueVerificationForUser(userId: string, email: string): Promise<void> {
    const code = sixDigitCode();
    await this.users.createEmailVerification(
      userId,
      hashVerificationCode(code),
      new Date(Date.now() + VERIFICATION_TTL_MS),
    );
    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MS / 60000);
  }

  /**
   * Prove the signed-in user's address.
   *
   * Scoped to that user by construction: six digits collide across accounts, so a global lookup by
   * hash would let one person's code match another's pending row.
   */
  async verifyExistingEmail(userId: string, code: string): Promise<User> {
    const user = await this.users.consumeEmailVerification(userId, hashVerificationCode(code));
    if (!user) throw new BadRequestException('that code is incorrect or has expired');
    return this.toPublicUser(user);
  }

  /**
   * Re-send a code to the signed-in user. Silent if they are already verified — there is nothing to
   * prove, and saying so would be noise on a button they should not have been shown.
   */
  async resendVerificationForUser(userId: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.emailVerifiedAt) return;
    await this.issueVerificationForUser(user.id, user.email);
  }
}
