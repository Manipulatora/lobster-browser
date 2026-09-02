import type { Membership, Role, Team } from '@lobster/shared-types';

/** Outcomes shared by membership mutations that have to re-check their actor inside the write. */
export type MembershipMutationFailure =
  'actor_not_member' | 'actor_not_admin' | 'target_not_member' | 'last_admin';

export type SetRoleResult =
  { outcome: 'updated'; membership: Membership } | { outcome: MembershipMutationFailure };

export type RemoveMemberResult = { outcome: 'removed' } | { outcome: MembershipMutationFailure };

export type LeaveTeamResult = { outcome: 'left' } | { outcome: 'actor_not_member' | 'last_admin' };

/**
 * Capacity rejection raised by the repository's atomic count-and-create of a team.
 *
 * Teams used to be free and unlimited, and every team carried its own profile allowance — so a
 * free account could script `POST /teams` fifty times and run a hundred and fifty profiles for
 * nothing. The allowance now belongs to the billing account (see
 * `ProfilesRepository.createManyWithinLimit`), which removes the payoff; this cap removes the
 * remaining cost, which is a row, a membership, a blob directory and an audit stream per team,
 * created by anyone holding a JWT.
 *
 * The counts ride on the error so the service can name them in its 403 without re-reading state
 * that may already have moved.
 */
export class OwnedTeamLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly ownedCount: number,
  ) {
    super(`team limit (${limit}) reached: ${ownedCount} teams already owned`);
    this.name = 'OwnedTeamLimitExceededError';
  }
}

/**
 * Persistence boundary for teams + memberships. TeamsService depends on this interface via the
 * `TEAMS_REPOSITORY` DI token, so the storage backend can be swapped without touching business
 * logic.
 *
 * Implementations:
 *   - InMemoryTeamsRepository — Maps; the active provider until Postgres is available.
 *   - PrismaTeamsRepository   — production persistence via the generated Prisma client.
 */
export interface TeamsRepository {
  /**
   * Create a team and its owner's admin membership atomically — but only while the owner owns
   * fewer than `maxOwnedTeams` teams, the personal team registration created included.
   *
   * Count and insert must be ONE atomic operation, for the same reason profile creation is: a
   * read-count-write sequence in the service lets two concurrent requests both observe room for
   * one more. Rejects with {@link OwnedTeamLimitExceededError}. Membership in other people's teams
   * never counts — an invitation is not a resource the invitee created.
   */
  createTeam(ownerUserId: string, name: string, maxOwnedTeams: number): Promise<Team>;
  /** Add (or overwrite) a membership. */
  addMember(teamId: string, userId: string, role: Role): Promise<Membership>;
  listMembers(teamId: string): Promise<Membership[]>;
  /** Every team the user belongs to (via a membership). */
  findTeamsForUser(userId: string): Promise<Team[]>;
  getMembership(teamId: string, userId: string): Promise<Membership | null>;

  /**
   * Change a role as an admin, re-checking authorization and the last-admin invariant atomically.
   *
   * A read/count/write sequence in the service is unsafe: two app instances can both observe two
   * admins and demote one each. The production repository therefore performs this whole operation
   * in one serializable database transaction (and retries serialization conflicts).
   */
  setRoleAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
    role: Role,
  ): Promise<SetRoleResult>;

  /** Remove a member as an admin, with the same atomic authorization/last-admin guarantee. */
  removeMemberAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<RemoveMemberResult>;

  /** Self-remove, atomically refusing to remove the team's last admin. */
  leaveTeam(teamId: string, actorUserId: string): Promise<LeaveTeamResult>;
}

/**
 * Nest DI token for the active `TeamsRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const TEAMS_REPOSITORY = Symbol('TeamsRepository');
