import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ARGON2ID_SALT_LEN } from '@lobster/crypto';

import { AuditService } from '../audit/audit.service';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import {
  VAULT_REPOSITORY,
  type UpsertVaultEnrollment,
  type VaultEnrollmentRecord,
  type VaultRepository,
} from './vault.repository';

/**
 * Wrapped key material, stored so a user can decrypt their own snapshots on a new machine.
 *
 * EVERY BYTE HERE IS OPAQUE TO THIS SERVICE. It validates shapes and sizes and stores blobs; it never
 * derives a key, never unwraps one, and has no code path that could. The client does all crypto,
 * which is what makes "the server cannot read your profile data" a structural property rather than a
 * promise.
 *
 * The one thing it does judge is that the two salts DIFFER. A client that sent the same salt twice
 * would produce two related wrapping keys and a recovery code that a password change invalidates —
 * an error worth catching at the boundary rather than discovering during someone's recovery.
 */
@Injectable()
export class VaultService {
  /** A key wrap is `LKw1 | nonce(12) | ct(32) + tag(16)` = 64 bytes. Nothing else is a valid wrap. */
  private static readonly WRAP_LEN = 4 + 12 + 32 + 16;

  constructor(
    @Inject(VAULT_REPOSITORY) private readonly repo: VaultRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * The team an audit row is attributed to. Mirrors `AuditService.resolveTeamId`: an explicit team is
   * checked for membership, otherwise the caller's first team — every user gets a personal team at
   * register time, so "no team" is a real fault rather than a normal state.
   */
  private async resolveTeamId(userId: string): Promise<string> {
    const teams = await this.teams.findTeamsForUser(userId);
    const first = teams[0];
    if (!first) throw new ForbiddenException('you do not belong to any team');
    return first.id;
  }

  /** The blobs a client needs to attempt an unlock. Null when the user has never enrolled. */
  async get(userId: string): Promise<VaultEnrollmentRecord | null> {
    return this.repo.find(userId);
  }

  async enroll(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord> {
    this.assertShape(input);
    const teamId = await this.resolveTeamId(input.userId);
    if (await this.repo.find(input.userId)) {
      // Refused rather than overwritten: replacing the wraps destroys the only way back to the key
      // every existing snapshot was sealed under.
      throw new ConflictException(
        'this account already has vault key material; use rotate to re-wrap the existing key',
      );
    }
    const record = await this.repo.create(input);
    await this.audit.record({
      teamId,
      actorUserId: input.userId,
      action: 'vault.enroll',
      targetType: 'vault',
      targetId: input.userId,
      // The fingerprint is non-secret and is what lets support confirm a user is unlocking the vault
      // their snapshots belong to. No salt, wrap or key ever enters an audit row.
      metadata: { keyFingerprint: record.keyFingerprint },
    });
    return record;
  }

  /**
   * Re-wrap the SAME key under new material, after a password change or a regenerated code.
   *
   * The Team Data Key does not change, so previously sealed snapshots stay readable — which is why
   * the client must send the fingerprint of the key it re-wrapped, and why a mismatch is refused. A
   * client that generated a NEW key here and rotated it in would silently orphan every snapshot the
   * user already had.
   */
  async rotate(input: UpsertVaultEnrollment): Promise<VaultEnrollmentRecord> {
    this.assertShape(input);
    const teamId = await this.resolveTeamId(input.userId);
    const existing = await this.repo.find(input.userId);
    if (!existing) {
      throw new NotFoundException('this account has no vault key material to rotate');
    }
    if (existing.keyFingerprint !== input.keyFingerprint) {
      throw new BadRequestException(
        'the re-wrapped key is not the key currently enrolled — rotating it would orphan every ' +
          'snapshot sealed under the existing key',
      );
    }
    const record = await this.repo.rotate(input);
    if (!record) throw new NotFoundException('this account has no vault key material to rotate');
    await this.audit.record({
      teamId,
      actorUserId: input.userId,
      action: 'vault.rotate',
      targetType: 'vault',
      targetId: input.userId,
      metadata: { keyFingerprint: record.keyFingerprint },
    });
    return record;
  }

  /**
   * Record that the recovery code was used.
   *
   * The server cannot verify the code — it cannot unwrap anything — so this is the client reporting a
   * successful recovery. That is fine for what it is for: support and the UI need to know the code has
   * left the paper it was printed on. It is NOT an authorisation signal and nothing gates on it.
   */
  async noteRecoveryUsed(userId: string): Promise<void> {
    const teamId = await this.resolveTeamId(userId);
    if (!(await this.repo.find(userId))) {
      throw new NotFoundException('this account has no vault key material');
    }
    await this.repo.markRecoveryCodeUsed(userId);
    await this.audit.record({
      teamId,
      actorUserId: userId,
      action: 'vault.recovery_code_used',
      targetType: 'vault',
      targetId: userId,
    });
  }

  private assertShape(input: UpsertVaultEnrollment): void {
    for (const [label, salt] of [
      ['passwordSalt', input.passwordSalt],
      ['recoverySalt', input.recoverySalt],
    ] as const) {
      if (salt.length !== ARGON2ID_SALT_LEN) {
        throw new BadRequestException(`${label} must be ${ARGON2ID_SALT_LEN} bytes`);
      }
    }
    if (input.passwordSalt.equals(input.recoverySalt)) {
      throw new BadRequestException(
        'passwordSalt and recoverySalt must differ, or a password change invalidates the recovery code',
      );
    }
    for (const [label, wrap] of [
      ['wrappedByPassword', input.wrappedByPassword],
      ['wrappedByRecovery', input.wrappedByRecovery],
    ] as const) {
      if (wrap.length !== VaultService.WRAP_LEN) {
        throw new BadRequestException(`${label} must be ${VaultService.WRAP_LEN} bytes`);
      }
      if (wrap.subarray(0, 4).toString('ascii') !== 'LKw1') {
        throw new BadRequestException(`${label} is not an LKw1 key wrap`);
      }
    }
    if (input.wrappedByPassword.equals(input.wrappedByRecovery)) {
      // Identical wraps of the same key under different keys is cryptographically impossible, so this
      // means the client wrapped once and sent the same blob twice — leaving one recovery path that
      // only appears to be two.
      throw new BadRequestException('the two wraps are identical; they must wrap under distinct keys');
    }
    if (!/^[0-9a-f]{16,64}$/.test(input.keyFingerprint)) {
      throw new BadRequestException('keyFingerprint must be 16-64 lowercase hex characters');
    }
    const { memoryKiB, iterations, parallelism } = input.argon;
    if (memoryKiB < 8 * 1024 || iterations < 2 || parallelism < 1) {
      // A client that enrolled with a trivial cost would have a password-derived wrap that is cheap
      // to attack offline, and the server is the only place that can refuse it.
      throw new BadRequestException(
        'argon cost is below the minimum accepted (memoryKiB >= 8192, iterations >= 2, parallelism >= 1)',
      );
    }
  }
}
