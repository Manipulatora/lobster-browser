import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Membership, Role, Team } from '@lobster/shared-types';

import type {
  LeaveTeamResult,
  RemoveMemberResult,
  SetRoleResult,
  TeamsRepository,
} from './teams.repository';

/** Staged write used to compose registration across the two in-memory repository instances. */
export interface PreparedTeamWithOwner {
  team: Team;
  commit(): Team;
  rollback(): void;
}

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
    // No await: team + first admin become visible in the same JavaScript turn.
    return this.prepareTeamWithOwner(ownerUserId, name).commit();
  }

  /**
   * Prepare, but do not expose, a team and its owner membership.
   *
   * Auth's in-memory registration path uses this two-phase hook to commit its User and this graph
   * together, and to compensate both stores if a synchronous write unexpectedly throws.
   */
  prepareTeamWithOwner(ownerUserId: string, name: string): PreparedTeamWithOwner {
    const createdAt = new Date().toISOString();
    const team: Team = {
      id: randomUUID(),
      name,
      ownerUserId,
      createdAt,
    };
    const membership: Membership = {
      userId: ownerUserId,
      teamId: team.id,
      role: 'admin',
      createdAt,
    };
    let committed = false;

    return {
      team,
      commit: () => {
        if (committed) return team;
        try {
          this.teams.set(team.id, team);
          this.memberships.set(this.key(team.id, ownerUserId), membership);
          committed = true;
          return team;
        } catch (error) {
          if (this.teams.get(team.id) === team) this.teams.delete(team.id);
          if (this.memberships.get(this.key(team.id, ownerUserId)) === membership) {
            this.memberships.delete(this.key(team.id, ownerUserId));
          }
          throw error;
        }
      },
      rollback: () => {
        if (this.teams.get(team.id) === team) this.teams.delete(team.id);
        if (this.memberships.get(this.key(team.id, ownerUserId)) === membership) {
          this.memberships.delete(this.key(team.id, ownerUserId));
        }
        committed = false;
      },
    };
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

  async findTeamsForUser(userId: string): Promise<Team[]> {
    const teamIds = [...this.memberships.values()]
      .filter((m) => m.userId === userId)
      .map((m) => m.teamId);
    return teamIds.map((id) => this.teams.get(id)).filter((t): t is Team => t !== undefined);
  }

  async getMembership(teamId: string, userId: string): Promise<Membership | null> {
    return this.memberships.get(this.key(teamId, userId)) ?? null;
  }

  /** Synchronous authorization probe for another in-memory repository's one-turn mutation. */
  isAdmin(teamId: string, userId: string): boolean {
    return this.memberships.get(this.key(teamId, userId))?.role === 'admin';
  }

  async setRoleAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
    role: Role,
  ): Promise<SetRoleResult> {
    // There is deliberately no await in this method. In the process-local development store, the
    // checks and mutation execute in one JavaScript turn, mirroring the atomic repository contract.
    const actor = this.memberships.get(this.key(teamId, actorUserId));
    if (!actor) return { outcome: 'actor_not_member' };
    if (actor.role !== 'admin') return { outcome: 'actor_not_admin' };

    const target = this.memberships.get(this.key(teamId, targetUserId));
    if (!target) return { outcome: 'target_not_member' };
    if (role === 'member' && target.role === 'admin' && this.adminCount(teamId) <= 1) {
      return { outcome: 'last_admin' };
    }

    const membership: Membership = { ...target, role };
    this.memberships.set(this.key(teamId, targetUserId), membership);
    return { outcome: 'updated', membership };
  }

  async removeMemberAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<RemoveMemberResult> {
    const actor = this.memberships.get(this.key(teamId, actorUserId));
    if (!actor) return { outcome: 'actor_not_member' };
    if (actor.role !== 'admin') return { outcome: 'actor_not_admin' };

    const target = this.memberships.get(this.key(teamId, targetUserId));
    if (!target) return { outcome: 'target_not_member' };
    if (target.role === 'admin' && this.adminCount(teamId) <= 1) {
      return { outcome: 'last_admin' };
    }

    this.memberships.delete(this.key(teamId, targetUserId));
    return { outcome: 'removed' };
  }

  async leaveTeam(teamId: string, actorUserId: string): Promise<LeaveTeamResult> {
    const actor = this.memberships.get(this.key(teamId, actorUserId));
    if (!actor) return { outcome: 'actor_not_member' };
    if (actor.role === 'admin' && this.adminCount(teamId) <= 1) {
      return { outcome: 'last_admin' };
    }

    this.memberships.delete(this.key(teamId, actorUserId));
    return { outcome: 'left' };
  }

  private adminCount(teamId: string): number {
    return [...this.memberships.values()].filter(
      (membership) => membership.teamId === teamId && membership.role === 'admin',
    ).length;
  }

  private key(teamId: string, userId: string): string {
    return `${teamId}::${userId}`;
  }
}
