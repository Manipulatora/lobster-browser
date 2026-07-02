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
    const team = await this.teams.createTeam(ownerUserId, name);
    await this.teams.addMember(team.id, ownerUserId, 'admin');
    return team;
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
    await this.assertAdmin(teamId, actorUserId);
    const target = await this.teams.getMembership(teamId, targetUserId);
    if (!target) {
      throw new NotFoundException('target user is not a member of this team');
    }
    // Last-admin safety: never let the change leave a team with zero admins. This only bites when
    // the target is currently the sole admin and is being demoted to member.
    if (role === 'member' && target.role === 'admin') {
      const members = await this.teams.listMembers(teamId);
      const adminCount = members.filter((m) => m.role === 'admin').length;
      if (adminCount <= 1) {
        throw new ForbiddenException('a team must have at least one admin');
      }
    }
    return this.teams.setRole(teamId, targetUserId, role);
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
}
