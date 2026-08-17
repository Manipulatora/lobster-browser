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
 * A real bcrypt hash (of a throwaway password) compared against when the email is unknown, so an
 * unknown-email login costs the same as a wrong-password login. Without it, skipping the compare
 * for a missing user is a user-enumeration timing oracle ("no such user" returns much faster than
 * "wrong password"). Precomputed once at module load; the plaintext never matches a real password.
 */
const DUMMY_HASH = bcrypt.hashSync('lobster:auth:timing-safe-dummy', BCRYPT_COST);

/** How long an issued token stays valid before the client must log in again. */
const TOKEN_TTL = '7d';

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

  async register(dto: RegisterDto): Promise<AuthResult> {
    // Normalize the email centrally so BOTH the in-memory and Prisma stores behave identically
    // (Postgres lookups are case-sensitive; the in-memory map is not). One canonical form avoids
    // duplicate accounts and login mismatches across backends.
    const email = this.normalizeEmail(dto.email);
    const existing = await this.users.findByEmail(email);
    if (existing) {
      throw new ConflictException('email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const user = await this.users.create({
      email,
      passwordHash,
      displayName: dto.displayName,
    });
    // Every user gets a personal team + an admin membership so they always have a place to own
    // profiles the moment they register (no separate "create your first team" step).
    const team = await this.teams.createTeam(user.id, this.personalTeamName(user));
    await this.teams.addMember(team.id, user.id, 'admin');

    // Best-effort. The account exists and is usable; an unsent verification mail is recoverable
    // through `resendVerification`, whereas failing the request here would leave a registered user
    // staring at an error for a side effect that already succeeded.
    void this.issueVerification(user.id, user.email);

    return { user: this.toPublicUser(user), token: this.signToken(user) };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(this.normalizeEmail(dto.email));
    // ALWAYS run one bcrypt.compare of the same cost, even when the email is unknown (against a
    // precomputed DUMMY_HASH), so an unknown email is indistinguishable in time from a wrong
    // password. The generic message avoids leaking which half was wrong.
    const passwordMatches = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('invalid email or password');
    }
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
  issueTokenFor(userId: string, email: string): string {
    const payload: JwtPayload = { sub: userId, email };
    return this.jwt.sign(payload, { secret: this.jwtSecret, expiresIn: TOKEN_TTL });
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

  // --- Email verification ---------------------------------------------------

  /**
   * Mint a verification token, store only its digest, and mail the link.
   *
   * The token is 32 random bytes. It is returned to the caller ONLY so tests can assert on it;
   * nothing in the request path echoes it back, because the whole point is that possession of the
   * mailbox is what proves the address.
   */
  async issueVerification(userId: string, email: string): Promise<string> {
    const code = sixDigitCode();
    // The stored value is a hash, exactly as for a password. A six-digit space is small enough to
    // enumerate offline in moments, so the hash is not what protects it — the 15-minute expiry,
    // single use, and the fact that a guess must be aimed at one already-authenticated account do.
    const codeHash = createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
    await this.users.createEmailVerification(userId, codeHash, expiresAt);

    await this.mail.sendVerification(email, code, VERIFICATION_TTL_MS / 60000);
    return code;
  }

  /** Consume a link. Unknown, expired and already-used all look identical to the caller. */
  async verifyEmail(userId: string, code: string): Promise<User> {
    // Normalised before hashing so a pasted code with stray spaces still matches what was mailed.
    const codeHash = createHash('sha256').update(code.replace(/\s+/g, '')).digest('hex');
    const user = await this.users.consumeEmailVerification(userId, codeHash);
    if (!user) throw new BadRequestException('that code is incorrect or has expired');
    return this.toPublicUser(user);
  }

  /**
   * Re-send a link.
   *
   * Always resolves, whether or not the address exists and whether or not it is already verified.
   * Reporting the truth would turn this endpoint into an account-existence oracle, which is worth
   * more to an attacker than the convenience is to a user.
   */
  async resendVerification(rawEmail: string): Promise<void> {
    const email = this.normalizeEmail(rawEmail);
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerifiedAt) return;
    await this.issueVerification(user.id, user.email);
  }
}
