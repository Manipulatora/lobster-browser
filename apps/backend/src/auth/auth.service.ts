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
import {
  USERS_REPOSITORY,
  type PendingRegistrationInput,
  type StoredUser,
  type UsersRepository,
} from './users.repository';
import { resolveJwtSecret } from './jwt-secret';
import { MailService } from '../mail/mail.service';

/** bcrypt work factor. 10 is the common default: strong enough, ~tens of ms per hash. */
const BCRYPT_COST = 10;

/**
 * How long a mailed code stays usable. Fifteen minutes — much shorter than the 24 hours a link
 * could afford: a six-digit code is a 1-in-a-million guess, so the window it stays guessable in is
 * the control that matters. Shared by every code this service mails (sign-up, re-verification,
 * password reset), because it is the same secret shape defending against the same guesser.
 */
const VERIFICATION_TTL_MS = 15 * 60 * 1000;
const VERIFICATION_TTL_MINUTES = VERIFICATION_TTL_MS / 60000;

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

/** Whole minutes, rounded up and never zero — a person reads "expires in 3 minutes", not "in 170 s". */
function minutesUntil(when: Date, now: Date): number {
  return Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 60000));
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
 * only by this user account, cleared on sign-out and on any 401. A token that has to die sooner
 * than this is what {@link AuthService.logoutAll} is for: every session token carries the
 * account's session version, and a bump refuses all of them — see {@link AuthService.authenticate}.
 * No TTL substitutes for that, which is why the year is affordable at all.
 */
const DESKTOP_TOKEN_TTL = '365d';

/**
 * How long a Lobee agent token lasts, in seconds.
 *
 * Minutes, not days, and that asymmetry with {@link DESKTOP_TOKEN_TTL} is the point. This token
 * authorises spend against the operator's model key on behalf of one team, and it travels to a
 * sidecar process rather than living in the OS keychain. Renewing it costs one call the desktop
 * already holds a session for, so there is no user-visible price for keeping the window short.
 *
 * It is also why agent tokens carry no session version: the window is short enough that ending
 * them early buys nothing worth a users-table read on every metered step, and the guard that
 * accepts them opens no account endpoint.
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

/** The audiences that ARE sessions: the two kinds of token that open the account API. */
export type SessionAudience = Exclude<TokenAudience, 'agent'>;

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
  /**
   * The session version the token was minted under (`StoredUser.sessionVersion`). Absent on tokens
   * issued before revocation existed; those count as version 0, so the first bump revokes them like
   * any other rather than leaving a class of tokens that can never be signed out.
   */
  sv?: number;
}

/** An agent token plus what the caller needs to renew it before it expires. */
export interface AgentTokenResult {
  token: string;
  teamId: string;
  expiresInSeconds: number;
}

/** What a session token is minted from: the user, at the session version that is current NOW. */
type SessionIdentity = Pick<StoredUser, 'id' | 'email' | 'sessionVersion'>;

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

    const now = new Date();
    const code = sixDigitCode();
    const pending: PendingRegistrationInput = {
      email,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST),
      fullName: dto.fullName.trim(),
      company: dto.company?.trim() || undefined,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    };
    const acknowledgement: PendingRegistrationResult = {
      pending: true,
      email,
      expiresInMinutes: VERIFICATION_TTL_MINUTES,
    };

    if (await this.users.claimPendingRegistration(pending, now)) {
      await this.mail.sendVerification(email, code, VERIFICATION_TTL_MINUTES);
      return acknowledgement;
    }

    // A live sign-up already holds the address. WHAT MUST NOT HAPPEN is what used to: replacing
    // its credentials with this caller's. The mailbox owner enters whichever code reaches them, so
    // whoever wrote the row last chose the password of the account the owner then proved — a
    // takeover for the price of one POST inside a fifteen-minute window.
    const current = await this.users.findPendingRegistration(email);
    if (current && (await bcrypt.compare(dto.password, current.passwordHash))) {
      // The same person, back again — a closed tab, a mail that never came, a corrected name.
      // Knowing the pending password is proof enough of that, so this is a re-send carrying the
      // form's newer details rather than a fifteen-minute wait.
      await this.users.upsertPendingRegistration(pending);
      await this.mail.sendVerification(email, code, VERIFICATION_TTL_MINUTES);
      return acknowledgement;
    }

    // Different credentials: the row stands untouched, and the acknowledgement is the same one a
    // fresh sign-up gets — a refusal here would say which addresses are mid-registration. The one
    // party entitled to know is the mailbox owner, who is told by mail instead, so that a sign-up
    // they did not start is something they notice rather than something they complete.
    if (current) {
      await this.mail.sendRegistrationAlreadyPending(email, minutesUntil(current.expiresAt, now));
    }
    return acknowledgement;
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
    const result = await this.users.completePendingRegistration(
      email,
      hashVerificationCode(code),
      new Date(),
    );
    // Wrong, expired, exhausted or unknown — all one message, so this cannot be used to discover
    // which addresses have a sign-up in flight.
    if (result.outcome === 'invalid') {
      throw new BadRequestException('that code is incorrect or has expired');
    }
    if (result.outcome === 'email_conflict') {
      throw new ConflictException('email already registered');
    }

    return { user: this.toPublicUser(result.user), token: this.signToken(result.user) };
  }

  /**
   * Re-send the code for a sign-up in flight.
   *
   * Reports success regardless of whether a pending sign-up exists, so this cannot be used to
   * enumerate which addresses are mid-registration.
   */
  async resendRegistrationCode(emailInput: string): Promise<void> {
    const email = this.normalizeEmail(emailInput);
    const now = new Date();
    const pending = await this.users.findPendingRegistration(email);
    // An expired sign-up is over, not dormant. Re-sending would revive whatever credentials it
    // held, for whoever asks — and the address is already free to be claimed afresh by whoever
    // actually wants it.
    if (!pending || pending.expiresAt.getTime() <= now.getTime()) return;

    const code = sixDigitCode();
    await this.users.upsertPendingRegistration({
      email: pending.email,
      passwordHash: pending.passwordHash,
      fullName: pending.fullName,
      company: pending.company,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS),
    });
    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MINUTES);
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

  /**
   * Resolve the user behind a verified token, and refuse it if it predates the last revocation.
   *
   * THE VERSION CHECK IS WHAT MAKES SIGN-OUT REAL. A JWT is valid until it expires — a year, for
   * the launcher — and no TTL substitutes for being able to end a session before then. Every token
   * carries the version it was minted under; sign-out-everywhere, a password change and a password
   * reset each bump the account's version, and from that instant every older token fails here. One
   * read, on the row the guard already needs to confirm the user still exists.
   *
   * Equality, not "at least": a token claiming a version the account has not reached cannot have
   * been minted by this server for the account as it stands, and there is no reading of it that
   * should open anything.
   */
  async authenticate(payload: JwtPayload): Promise<User> {
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }
    if ((payload.sv ?? 0) !== user.sessionVersion) {
      throw new UnauthorizedException('session revoked; sign in again');
    }
    return this.toPublicUser(user);
  }

  /** JWT signing/verification secret. Hard-fails in production when `JWT_SECRET` is unset. */
  get jwtSecret(): string {
    return resolveJwtSecret(this.config);
  }

  /**
   * Mint a session for an identity established out of band — the desktop loopback handoff, where
   * the website authenticated the user and the launcher holds only a redeemed code.
   *
   * Reads the account so the token carries the version that is current NOW. Minting from a copy
   * read earlier would produce either a token that is dead on arrival or, worse, one that outlives
   * a revocation issued in between. It performs NO authentication of its own: callers must have
   * established the identity first.
   */
  async issueSessionFor(userId: string, audience: SessionAudience): Promise<AuthResult> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }
    return { user: this.toPublicUser(user), token: this.issueTokenFor(user, audience) };
  }

  /**
   * Sign a session token for a user already in hand.
   *
   * The identity must carry the user's CURRENT session version — the one just read or just
   * written — because that number is what the guard will compare against for the life of the
   * token. Callers holding only an id use {@link issueSessionFor}, which reads it.
   */
  issueTokenFor(user: SessionIdentity, audience: SessionAudience = 'web'): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      aud: audience,
      sv: user.sessionVersion,
    };
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

  // --- Ending sessions -------------------------------------------------------
  //
  // Three doors, one mechanism: each bumps the account's session version, and `authenticate`
  // refuses every token minted under the old one. Sign-out-everywhere is the bump alone; the two
  // password paths get it as part of the same write that sets the new hash, so there is no instant
  // at which the old password is gone but a token minted under it still works.

  /**
   * Sign out everywhere: every token this account holds — web, desktop, this one included — stops
   * working at once. The only remedy for a token that has left the machine it was issued to, and
   * the reason `DESKTOP_TOKEN_TTL` can afford to be a year.
   */
  async logoutAll(userId: string): Promise<void> {
    const user = await this.users.revokeSessions(userId);
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }
  }

  /**
   * Change the password of a signed-in user who can still prove the current one.
   *
   * PROVING THE CURRENT PASSWORD is what keeps a stolen token from becoming a stolen account: a
   * token alone can read; only the password can change the password. A wrong guess counts against
   * the same backoff as a wrong sign-in — it is the same secret being guessed, through another
   * door — and is answered as a bad request rather than a 401, because the web client treats a 401
   * as "signed out" and a typo here must not end the session.
   *
   * Every other session dies with the old password; the caller gets a replacement token for the
   * screen they are on, minted for the same audience they arrived with.
   */
  async changePassword(args: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    audience: SessionAudience;
  }): Promise<AuthResult> {
    const now = new Date();
    const user = await this.users.findById(args.userId);
    if (!user) {
      throw new UnauthorizedException('user no longer exists');
    }

    const matches = await bcrypt.compare(args.currentPassword, user.passwordHash);
    if (user.lockedUntil && new Date(user.lockedUntil) > now) {
      throw new BadRequestException('current password is incorrect');
    }
    if (!matches) {
      await this.users.registerFailedLogin(user.id, now);
      throw new BadRequestException('current password is incorrect');
    }

    const updated = await this.users.changePassword(
      user.id,
      await bcrypt.hash(args.newPassword, BCRYPT_COST),
    );
    if (!updated) {
      throw new UnauthorizedException('user no longer exists');
    }
    return { user: this.toPublicUser(updated), token: this.issueTokenFor(updated, args.audience) };
  }

  /**
   * Start a password reset: mail a code to the address, if an account has it.
   *
   * ANSWERS THE SAME WAY FOR EVERY ADDRESS. Whether an account exists is not the caller's to learn
   * here, so nothing about the outcome depends on it — including the response time. The mail is
   * not awaited: an SMTP round-trip taken only for real accounts would say in milliseconds what
   * the body refuses to say in words. MailService never throws, and a send that fails is
   * recoverable by asking again; nothing here depends on it.
   */
  async requestPasswordReset(emailInput: string): Promise<void> {
    const email = this.normalizeEmail(emailInput);
    const user = await this.users.findByEmail(email);
    if (!user) return;

    const code = sixDigitCode();
    await this.users.createPasswordReset(
      user.id,
      hashVerificationCode(code),
      new Date(Date.now() + VERIFICATION_TTL_MS),
    );
    // Detached on purpose (see above). MailService answers false rather than throwing, but a
    // detached promise that ever did reject would take the whole process down, so the net stays.
    void this.mail.sendPasswordReset(email, code, VERIFICATION_TTL_MINUTES).catch(() => undefined);
  }

  /**
   * Finish a reset: the code proves the mailbox, and the mailbox is the account.
   *
   * Public by necessity — the person has, by definition, no session and no password — so the code
   * carries the whole burden, bounded by the attempt counter on the reset row. Sets the password,
   * ends every existing session (a reset is the answer to "someone else may have my password",
   * and their sessions have to go with it) and returns a fresh one, exactly as completing a
   * sign-up does: mailbox control is what both flows rest on.
   *
   * The new hash is computed BEFORE the account is looked up, so an unknown address costs the same
   * bcrypt work as a known one, and every failure is the one sentence `completeRegistration` uses.
   */
  async resetPassword(emailInput: string, code: string, newPassword: string): Promise<AuthResult> {
    const email = this.normalizeEmail(emailInput);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const user = await this.users.findByEmail(email);
    const updated =
      user &&
      (await this.users.resetPasswordWithCode(
        user.id,
        hashVerificationCode(code),
        passwordHash,
        new Date(),
      ));
    if (!updated) {
      throw new BadRequestException('that code is incorrect or has expired');
    }
    return { user: this.toPublicUser(updated), token: this.issueTokenFor(updated) };
  }

  private signToken(user: StoredUser): string {
    return this.issueTokenFor(user);
  }

  /** Canonical email form: trimmed + lowercased. The single normalization point for auth. */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * The wire `User`, and nothing else. An explicit projection rather than a spread-minus-hash: the
   * stored record also carries the backoff state and the session version, and a spread would send
   * whatever the next server-only field turns out to be too.
   */
  private toPublicUser(user: StoredUser): User {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      company: user.company,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
    };
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
    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MINUTES);
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
