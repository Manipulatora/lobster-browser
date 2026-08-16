import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { User } from '@lobster/shared-types';

import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { USERS_REPOSITORY, type StoredUser, type UsersRepository } from './users.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { resolveJwtSecret } from './jwt-secret';

/** bcrypt work factor. 10 is the common default: strong enough, ~tens of ms per hash. */
const BCRYPT_COST = 10;

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
}
