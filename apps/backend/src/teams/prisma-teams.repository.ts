import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Membership, Role, Team } from '@lobster/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import {
  OwnedTeamLimitExceededError,
  type LeaveTeamResult,
  type RemoveMemberResult,
  type SetRoleResult,
  type TeamsRepository,
} from './teams.repository';

/** Prisma reports a serializable write conflict/deadlock as P2034 and explicitly requires retry. */
const SERIALIZABLE_ATTEMPTS = 5;

/** The subset of a Prisma `teams` row this repository maps to a `Team`. */
interface TeamRow {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
}

/** The subset of a Prisma `memberships` row this repository maps to a `Membership`. */
interface MembershipRow {
  userId: string;
  teamId: string;
  role: Role;
  createdAt: Date;
}

/**
 * Production `TeamsRepository` backed by Postgres via the shared {@link PrismaService}.
 *
 * The wiring module selects this as the active provider whenever `DATABASE_URL` is set; without
 * a DB (local dev / tests) the in-memory repository is used instead.
 */
@Injectable()
export class PrismaTeamsRepository implements TeamsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createTeam(ownerUserId: string, name: string, maxOwnedTeams: number): Promise<Team> {
    return this.prisma.$transaction(
      async (tx) => {
        // The owner's user row is the lock for "how many teams does this account own". Under READ
        // COMMITTED every statement takes a fresh snapshot, so without it two concurrent creates
        // both count N-1 and both insert; queued on the row, the second one counts the first.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "users" WHERE "id" = ${ownerUserId} FOR UPDATE
        `;
        if (locked.length !== 1) {
          throw new Error('team owner does not exist');
        }
        const ownedCount = await tx.team.count({ where: { ownerUserId } });
        if (ownedCount + 1 > maxOwnedTeams) {
          throw new OwnedTeamLimitExceededError(maxOwnedTeams, ownedCount);
        }
        const row = await tx.team.create({ data: { name, ownerUserId } });
        await tx.membership.create({
          data: { teamId: row.id, userId: ownerUserId, role: 'admin' },
        });
        return this.toTeam(row);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async addMember(teamId: string, userId: string, role: Role): Promise<Membership> {
    const row = await this.prisma.membership.create({ data: { teamId, userId, role } });
    return this.toMembership(row);
  }

  async listMembers(teamId: string): Promise<Membership[]> {
    const rows = await this.prisma.membership.findMany({
      where: { teamId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toMembership(row));
  }

  async findTeamsForUser(userId: string): Promise<Team[]> {
    const rows = await this.prisma.team.findMany({
      where: { memberships: { some: { userId } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toTeam(row));
  }

  async getMembership(teamId: string, userId: string): Promise<Membership | null> {
    const row = await this.prisma.membership.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    return row ? this.toMembership(row) : null;
  }

  async setRoleAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
    role: Role,
  ): Promise<SetRoleResult> {
    return this.runSerializable(async (tx) => {
      const actor = await tx.membership.findUnique({
        where: { userId_teamId: { userId: actorUserId, teamId } },
      });
      if (!actor) return { outcome: 'actor_not_member' };
      if (actor.role !== 'admin') return { outcome: 'actor_not_admin' };

      const target = await tx.membership.findUnique({
        where: { userId_teamId: { userId: targetUserId, teamId } },
      });
      if (!target) return { outcome: 'target_not_member' };

      if (role === 'member' && target.role === 'admin') {
        const adminCount = await tx.membership.count({ where: { teamId, role: 'admin' } });
        if (adminCount <= 1) return { outcome: 'last_admin' };
      }

      const row = await tx.membership.update({
        where: { userId_teamId: { userId: targetUserId, teamId } },
        data: { role },
      });
      return { outcome: 'updated', membership: this.toMembership(row) };
    });
  }

  async removeMemberAsAdmin(
    teamId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<RemoveMemberResult> {
    return this.runSerializable(async (tx) => {
      const actor = await tx.membership.findUnique({
        where: { userId_teamId: { userId: actorUserId, teamId } },
      });
      if (!actor) return { outcome: 'actor_not_member' };
      if (actor.role !== 'admin') return { outcome: 'actor_not_admin' };

      const target = await tx.membership.findUnique({
        where: { userId_teamId: { userId: targetUserId, teamId } },
      });
      if (!target) return { outcome: 'target_not_member' };

      if (target.role === 'admin') {
        const adminCount = await tx.membership.count({ where: { teamId, role: 'admin' } });
        if (adminCount <= 1) return { outcome: 'last_admin' };
      }

      await tx.membership.delete({
        where: { userId_teamId: { userId: targetUserId, teamId } },
      });
      return { outcome: 'removed' };
    });
  }

  async leaveTeam(teamId: string, actorUserId: string): Promise<LeaveTeamResult> {
    return this.runSerializable(async (tx) => {
      const actor = await tx.membership.findUnique({
        where: { userId_teamId: { userId: actorUserId, teamId } },
      });
      if (!actor) return { outcome: 'actor_not_member' };

      if (actor.role === 'admin') {
        const adminCount = await tx.membership.count({ where: { teamId, role: 'admin' } });
        if (adminCount <= 1) return { outcome: 'last_admin' };
      }

      await tx.membership.delete({
        where: { userId_teamId: { userId: actorUserId, teamId } },
      });
      return { outcome: 'left' };
    });
  }

  /**
   * Serializable isolation is what turns the admin-count predicate into an invariant across rows.
   * Under the default READ COMMITTED isolation, two transactions can each count two admins and
   * update/delete a different row. PostgreSQL SSI aborts one of those transactions; retrying it
   * observes the winner and returns `last_admin` (or an authorization failure) instead.
   */
  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!this.isSerializationConflict(error) || attempt === SERIALIZABLE_ATTEMPTS) throw error;
      }
    }
    throw new Error('unreachable: serializable membership transaction exhausted without throwing');
  }

  private isSerializationConflict(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2034'
    );
  }

  private toTeam(row: TeamRow): Team {
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.ownerUserId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toMembership(row: MembershipRow): Membership {
    return {
      userId: row.userId,
      teamId: row.teamId,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
