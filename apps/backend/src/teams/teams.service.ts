import { Injectable } from '@nestjs/common';
import type { Membership, Role, Team } from '@lobster/shared-types';

/**
 * Team + membership business logic.
 *
 * Day 0 STUB — returns typed shapes but does not touch the database. TODO(Day 2):
 *   - persist Team / Membership rows via Prisma,
 *   - auto-create an owner Membership (role: 'admin') when a team is created,
 *   - guard `inviteMember` / `setRole` behind an admin-only authorization check,
 *   - send real invite emails (accept flow issues the Membership).
 */
@Injectable()
export class TeamsService {
  async createTeam(name: string, ownerUserId: string): Promise<Team> {
    // TODO(Day 2): INSERT team + owner membership in a transaction.
    return {
      id: this.stubId('team'),
      name,
      ownerUserId,
      createdAt: new Date().toISOString(),
    };
  }

  async inviteMember(teamId: string, _email: string, role: Role): Promise<Membership> {
    // TODO(Day 2): look up or provision the invitee User by email, then create the Membership.
    return {
      userId: this.stubId('usr'),
      teamId,
      role,
      createdAt: new Date().toISOString(),
    };
  }

  async listMembers(teamId: string): Promise<Membership[]> {
    // TODO(Day 2): SELECT memberships WHERE teamId = $1.
    return [
      {
        userId: this.stubId('usr'),
        teamId,
        role: 'admin',
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async setRole(teamId: string, userId: string, role: Role): Promise<Membership> {
    // TODO(Day 2): UPDATE membership SET role; forbid demoting the last admin.
    return {
      userId,
      teamId,
      role,
      createdAt: new Date().toISOString(),
    };
  }

  private stubId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
