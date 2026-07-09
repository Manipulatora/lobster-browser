import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Membership, Role, Team } from '@lobster/shared-types';

import type { TeamsRepository } from './teams.repository';

/**
 * In-memory `TeamsRepository` backed by Maps. The active implementation until a Postgres
 * instance is provisioned — it lets teams run (and be tested) with no DB. State lives for the
 * lifetime of the process only; it is intentionally NOT durable.
 */
@Injectable()
export class InMemoryTeamsRepository implements TeamsRepository {
  private readonly teams = new Map<string, Team>();
  /** Memberships keyed by `${teamId}::${userId}` so a (team, user) pair is unique. */
  private readonly memberships = new Map<string, Membership>();

  async createTeam(ownerUserId: string, name: string): Promise<Team> {
    const team: Team = {
      id: randomUUID(),
      name,
      ownerUserId,
      createdAt: new Date().toISOString(),
    };
    this.teams.set(team.id, team);
    return team;
  }

  async addMember(teamId: string, userId: string, role: Role): Promise<Membership> {
    const membership: Membership = {
      userId,
      teamId,
      role,
      createdAt: new Date().toISOString(),
    };
    this.memberships.set(this.key(teamId, userId), membership);
    return membership;
  }

  async listMembers(teamId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((m) => m.teamId === teamId);
  }

  async setRole(teamId: string, userId: string, role: Role): Promise<Membership> {
    const existing = this.memberships.get(this.key(teamId, userId));
    const membership: Membership = {
      userId,
      teamId,
      role,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.memberships.set(this.key(teamId, userId), membership);
    return membership;
  }

  async findTeamsForUser(userId: string): Promise<Team[]> {
    const teamIds = [...this.memberships.values()]
      .filter((m) => m.userId === userId)
      .map((m) => m.teamId);
    return teamIds.map((id) => this.teams.get(id)).filter((t): t is Team => t !== undefined);
  }

  async getMembership(teamId: string, userId: string): Promise<Membership | null> {
    return this.memberships.get(this.key(teamId, userId)) ?? null;
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    return this.memberships.delete(this.key(teamId, userId));
  }

  private key(teamId: string, userId: string): string {
    return `${teamId}::${userId}`;
  }
}
