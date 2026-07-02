import type { EngineKind, FingerprintOverrides, OsFamily, Profile } from '@lobster/shared-types';

/**
 * Fields required to create a profile row. The repository owns `id`, `status`, and the
 * `createdAt`/`updatedAt` timestamps. `fingerprintSeed` is always supplied by the service
 * (it generates a fresh random seed when the caller omits one).
 */
export interface CreateProfileRecord {
  ownerTeamId: string;
  name: string;
  engine: EngineKind;
  os: OsFamily;
  fingerprintSeed: string;
  fingerprintOverrides?: FingerprintOverrides;
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
  os?: OsFamily;
  fingerprintOverrides?: FingerprintOverrides;
  tags?: string[];
  folder?: string;
  notes?: string;
}

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
  create(input: CreateProfileRecord): Promise<Profile>;
  findById(teamId: string, id: string): Promise<Profile | null>;
  findAllByTeam(teamId: string): Promise<Profile[]>;
  /** Returns the updated profile, or null when it does not exist / belongs to another team. */
  update(teamId: string, id: string, patch: UpdateProfileRecord): Promise<Profile | null>;
  /** Returns true when a row was deleted, false when nothing matched the (team, id). */
  remove(teamId: string, id: string): Promise<boolean>;
  /**
   * The team's plan profile limit from its Subscription, or null when no subscription exists
   * (the service then applies the default free-tier limit).
   */
  getProfileLimit(teamId: string): Promise<number | null>;
}

/**
 * Nest DI token for the active `ProfilesRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const PROFILES_REPOSITORY = Symbol('ProfilesRepository');
