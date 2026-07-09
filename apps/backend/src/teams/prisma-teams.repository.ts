import { Injectable } from '@nestjs/common';
import type { Membership, Role, Team } from '@lobster/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import type { TeamsRepository } from './teams.repository';

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

  async createTeam(ownerUserId: string, name: string): Promise<Team> {
    const row = await this.prisma.team.create({ data: { name, ownerUserId } });
    return this.toTeam(row);
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

  async setRole(teamId: string, userId: string, role: Role): Promise<Membership> {
    const row = await this.prisma.membership.update({
      where: { userId_teamId: { userId, teamId } },
      data: { role },
    });
    return this.toMembership(row);
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

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    try {
      await this.prisma.membership.delete({
        where: { userId_teamId: { userId, teamId } },
      });
      return true;
    } catch {
      return false;
    }
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
