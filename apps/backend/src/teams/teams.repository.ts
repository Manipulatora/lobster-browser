import type { Membership, Role, Team } from '@lobster/shared-types';

/** Outcomes shared by membership mutations that have to re-check their actor inside the write. */
export type MembershipMutationFailure =
  'actor_not_member' | 'actor_not_admin' | 'target_not_member' | 'last_admin';

export type SetRoleResult =
  { outcome: 'updated'; membership: Membership } | { outcome: MembershipMutationFailure };

export type RemoveMemberResult = { outcome: 'removed' } | { outcome: MembershipMutationFailure };

export type LeaveTeamResult = { outcome: 'left' } | { outcome: 'actor_not_member' | 'last_admin' };

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
  /** Create a team and its owner's admin membership atomically. */
  createTeam(ownerUserId: string, name: string): Promise<Team>;
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
