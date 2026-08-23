import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Membership, Role, Team } from '@lobster/shared-types';

import { USERS_REPOSITORY, type UsersRepository } from '../auth/users.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from './teams.repository';

/**
 * Team + membership business logic. Identity always comes from the authenticated caller
 * (`actorUserId`, derived from the JWT) — never from the request body. Storage is abstracted
 * behind `TeamsRepository` (in-memory today, Prisma once Postgres is provisioned), so this
 * service runs and is tested without a database.
 *
 * Authorization rules:
 *   - listing members requires membership,
 *   - inviting members and changing roles require the `admin` role.
 */
@Injectable()
export class TeamsService {
  constructor(
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
  ) {}

  /** Create a team; the caller becomes its owner and first admin. */
  async createTeam(ownerUserId: string, name: string): Promise<Team> {
    return this.teams.createTeam(ownerUserId, name);
  }

  /** Every team the caller belongs to. */
  async listTeams(userId: string): Promise<Team[]> {
    return this.teams.findTeamsForUser(userId);
  }

  /** Invite an existing user (by email) to a team as `role`. Admin-only. */
  async inviteMember(
    teamId: string,
    actorUserId: string,
    email: string,
    role: Role,
  ): Promise<Membership> {
    await this.assertAdmin(teamId, actorUserId);
    const invitee = await this.users.findByEmail(email);
    if (!invitee) {
      throw new NotFoundException('no registered user with that email');
    }
    const existing = await this.teams.getMembership(teamId, invitee.id);
    if (existing) {
      throw new ConflictException('user is already a member of this team');
    }
    return this.teams.addMember(teamId, invitee.id, role);
  }

  /** List a team's members. Requires the caller to be a member. */
  async listMembers(teamId: string, actorUserId: string): Promise<Membership[]> {
    await this.assertMember(teamId, actorUserId);
    return this.teams.listMembers(teamId);
  }

  /** Change a member's role. Admin-only. */
  async setRole(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
    role: Role,
  ): Promise<Membership> {
    const result = await this.teams.setRoleAsAdmin(teamId, actorUserId, targetUserId, role);
    if (result.outcome === 'updated') return result.membership;
    if (result.outcome === 'target_not_member') {
      throw new NotFoundException('target user is not a member of this team');
    }
    if (result.outcome === 'last_admin') {
      throw new ForbiddenException('a team must have at least one admin');
    }
    this.throwActorFailure(result.outcome);
  }

  /**
   * Remove a member (admin-only). Cannot remove the last admin.
   * TODO(SEC-2): after removal, re-wrap a fresh Team Data Key to remaining members so the
   * departed member cannot decrypt future blob versions (forward secrecy).
   */
  async removeMember(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ teamId: string; userId: string; removed: true }> {
    const result = await this.teams.removeMemberAsAdmin(teamId, actorUserId, targetUserId);
    if (result.outcome === 'target_not_member') {
      throw new NotFoundException('target user is not a member of this team');
    }
    if (result.outcome === 'last_admin') {
      throw new ForbiddenException('a team must have at least one admin');
    }
    if (result.outcome !== 'removed') this.throwActorFailure(result.outcome);
    return { teamId, userId: targetUserId, removed: true };
  }

  /**
   * Leave a team (self-removal). Cannot leave as the last admin — transfer admin first.
   * TODO(SEC-2): same TDK re-wrap as {@link removeMember}.
   */
  async leaveTeam(
    teamId: string,
    actorUserId: string,
  ): Promise<{ teamId: string; userId: string; left: true }> {
    const result = await this.teams.leaveTeam(teamId, actorUserId);
    if (result.outcome === 'actor_not_member') {
      throw new ForbiddenException('you are not a member of this team');
    }
    if (result.outcome === 'last_admin') {
      throw new ForbiddenException(
        'the last admin cannot leave; promote another admin or delete the team',
      );
    }
    return { teamId, userId: actorUserId, left: true };
  }

  /** Throw unless the caller is a member of the team; returns the membership when they are. */
  private async assertMember(teamId: string, userId: string): Promise<Membership> {
    const membership = await this.teams.getMembership(teamId, userId);
    if (!membership) {
      throw new ForbiddenException('you are not a member of this team');
    }
    return membership;
  }

  /** Throw unless the caller is an admin of the team. */
  private async assertAdmin(teamId: string, userId: string): Promise<void> {
    const membership = await this.assertMember(teamId, userId);
    if (membership.role !== 'admin') {
      throw new ForbiddenException('this action requires the admin role');
    }
  }

  /** Map repository-level atomic authorization outcomes onto the public API's existing errors. */
  private throwActorFailure(outcome: 'actor_not_member' | 'actor_not_admin'): never {
    if (outcome === 'actor_not_member') {
      throw new ForbiddenException('you are not a member of this team');
    }
    throw new ForbiddenException('this action requires the admin role');
  }
}
