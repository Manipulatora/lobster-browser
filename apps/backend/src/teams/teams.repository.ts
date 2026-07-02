import type { Membership, Role, Team } from '@lobster/shared-types';

/**
 * Persistence boundary for teams + memberships. TeamsService (and AuthService, for the
 * personal-team-on-register flow) depend on this interface via the `TEAMS_REPOSITORY` DI
 * token rather than a concrete class, so the storage backend can be swapped without touching
 * the business logic.
 *
 * Implementations:
 *   - InMemoryTeamsRepository — Maps; the active provider until Postgres is available.
 *   - PrismaTeamsRepository   — production persistence via the generated Prisma client.
 */
export interface TeamsRepository {
  /** Create a team owned by `ownerUserId`. Does NOT create the owner membership — the caller does. */
  createTeam(ownerUserId: string, name: string): Promise<Team>;
  /** Add (or overwrite) a membership. */
  addMember(teamId: string, userId: string, role: Role): Promise<Membership>;
  listMembers(teamId: string): Promise<Membership[]>;
  /** Update an existing membership's role. Assumes the membership exists (caller checks first). */
  setRole(teamId: string, userId: string, role: Role): Promise<Membership>;
  /** Every team the user belongs to (via a membership). */
  findTeamsForUser(userId: string): Promise<Team[]>;
  getMembership(teamId: string, userId: string): Promise<Membership | null>;
}

/**
 * Nest DI token for the active `TeamsRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const TEAMS_REPOSITORY = Symbol('TeamsRepository');
