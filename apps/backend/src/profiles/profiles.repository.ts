import type {
  BrowserExtensionRef,
  CookieImportMetadata,
  EngineKind,
  FingerprintOverrides,
  Profile,
  ProfileOsTarget,
} from '@lobster/shared-types';

/** Persistable cookie import metadata; raw cookie text is never accepted by cloud storage. */
export type SafeCookieImportMetadata = CookieImportMetadata;

/**
 * Fields required to create a profile row. The repository owns `id`, `status`, and the
 * `createdAt`/`updatedAt` timestamps. `fingerprintSeed` is always supplied by the service
 * (it generates a fresh random seed when the caller omits one).
 */
export interface CreateProfileRecord {
  ownerTeamId: string;
  name: string;
  engine: EngineKind;
  os: ProfileOsTarget;
  osVersion?: string;
  fingerprintSeed: string;
  fingerprintOverrides?: FingerprintOverrides;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: SafeCookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags: string[];
  folder?: string;
  notes?: string;
}

/**
 * Mutable subset of a profile. `engine`, `os`, and `fingerprintOverrides` are editable (the
 * desktop editor re-tunes them); only `fingerprintSeed` — the profile's identity — is immutable.
 */
export interface UpdateProfileRecord {
  name?: string;
  engine?: EngineKind;
  os?: ProfileOsTarget;
  osVersion?: string;
  fingerprintOverrides?: FingerprintOverrides;
  proxyId?: string;
  templateId?: string;
  cookiesImport?: SafeCookieImportMetadata;
  extensions?: BrowserExtensionRef[];
  tags?: string[];
  folder?: string;
  notes?: string;
}

/**
 * Capacity rejection raised by the repository's atomic count-and-create operation. Keeping the
 * measured values on the error lets the service preserve its existing 403 message without moving
 * the race-prone count back above the transaction boundary.
 */
export class ProfileLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly currentCount: number,
    readonly requestedCount: number,
  ) {
    super(
      `profile limit (${limit}) reached: ${currentCount} in use, cannot add ${requestedCount} more`,
    );
    this.name = 'ProfileLimitExceededError';
  }
}

/** Result of an admin-guarded profile tombstone. */
export type RemoveProfileAsAdminResult =
  { outcome: 'removed' } | { outcome: 'forbidden' } | { outcome: 'not_found' };

/**
 * Persistence boundary for profiles. ProfilesService depends on this interface via the
 * `PROFILES_REPOSITORY` DI token. EVERY read/write is scoped by `ownerTeamId` so one team can
 * never see or mutate another team's profiles.
 *
 * Implementations:
 *   - InMemoryProfilesRepository — a Map; the active provider until Postgres is available.
 *   - PrismaProfilesRepository   — production persistence via the generated Prisma client.
 */
export interface ProfilesRepository {
  /**
   * Create an entire same-team batch under the team's current profile allowance.
   *
   * This is the ONLY creation primitive: implementations must make entitlement lookup, live-row
   * count, limit check, and every insert one atomic operation. Concurrent calls for the same team
   * must serialize, and any insert failure must roll the whole batch back.
   */
  createManyWithinLimit(inputs: readonly CreateProfileRecord[]): Promise<Profile[]>;
  findById(teamId: string, id: string): Promise<Profile | null>;
  findAllByTeam(teamId: string): Promise<Profile[]>;
  /** Returns the updated profile, or null when it does not exist / belongs to another team. */
  update(teamId: string, id: string, patch: UpdateProfileRecord): Promise<Profile | null>;
  /**
   * Tombstone the profile only while `actorUserId` is an admin of its owning team.
   *
   * Authorization and the tombstone must be one atomic persistence operation. Checking the role in
   * the service and writing later lets a concurrent demotion race through the destructive write.
   */
  removeAsAdmin(
    teamId: string,
    id: string,
    actorUserId: string,
  ): Promise<RemoveProfileAsAdminResult>;
  /**
   * The profile limit the team's Subscription currently entitles it to, or null when no
   * subscription exists. The atomic creation primitive applies the default free-tier entitlement.
   *
   * ENTITLED, not purchased: a package whose period has ended, or whose last renewal failed, is
   * worth the free allowance however large a limit is stored on the row.
   */
  getProfileLimit(teamId: string): Promise<number | null>;
}

/**
 * Nest DI token for the active `ProfilesRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const PROFILES_REPOSITORY = Symbol('ProfilesRepository');
