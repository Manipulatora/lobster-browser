import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import type { User } from '@lobster/shared-types';

import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { USERS_REPOSITORY, type StoredUser, type UsersRepository } from './users.repository';
import { resolveJwtSecret } from './jwt-secret';

/** bcrypt work factor. 10 is the common default: strong enough, ~tens of ms per hash. */
const BCRYPT_COST = 10;

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
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    const existing = await this.users.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('email already registered');
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      displayName: dto.displayName,
    });
    return { user: this.toPublicUser(user), token: this.signToken(user) };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByEmail(dto.email);
    // Verify even when the user is missing? bcrypt.compare against a real hash only runs
    // when we found a user; the generic message avoids leaking which half was wrong.
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
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

  private signToken(user: StoredUser): string {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return this.jwt.sign(payload, { secret: this.jwtSecret, expiresIn: TOKEN_TTL });
  }

  /** Drop the password hash so it never crosses the wire. */
  private toPublicUser(user: StoredUser): User {
    const { passwordHash: _passwordHash, ...publicUser } = user;
    return publicUser;
  }
}
