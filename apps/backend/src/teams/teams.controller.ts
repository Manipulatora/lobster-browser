import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsString, MaxLength } from 'class-validator';
import type { Membership, Role, Team, User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TeamsService } from './teams.service';

// --- Inline DTOs (kept next to the controller since they are small) ---

class CreateTeamDto {
  @IsString()
  @MaxLength(80)
  name!: string;
}

class InviteMemberDto {
  @IsEmail()
  email!: string;

  @IsIn(['admin', 'member'] satisfies Role[])
  role!: Role;
}

class SetRoleDto {
  @IsIn(['admin', 'member'] satisfies Role[])
  role!: Role;
}

/**
 * Team management endpoints. All routes require a valid JWT; identity comes from the token
 * (`@CurrentUser()`), never the body. Membership/role are enforced in TeamsService. All
 * responses use the shared `{ code, data, msg }` envelope.
 */
@Controller('teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  /** Create a team; the caller becomes its admin. */
  @Post()
  async createTeam(
    @CurrentUser() user: User,
    @Body() dto: CreateTeamDto,
  ): Promise<ApiResponse<Team>> {
    return ok(await this.teamsService.createTeam(user.id, dto.name));
  }

  /** Teams the caller belongs to. */
  @Get()
  async listTeams(@CurrentUser() user: User): Promise<ApiResponse<Team[]>> {
    return ok(await this.teamsService.listTeams(user.id));
  }

  /** Invite an existing user by email (admin-only). */
  @Post(':teamId/members')
  async inviteMember(
    @CurrentUser() user: User,
    @Param('teamId') teamId: string,
    @Body() dto: InviteMemberDto,
  ): Promise<ApiResponse<Membership>> {
    return ok(await this.teamsService.inviteMember(teamId, user.id, dto.email, dto.role));
  }

  /** List members (members-only). */
  @Get(':teamId/members')
  async listMembers(
    @CurrentUser() user: User,
    @Param('teamId') teamId: string,
  ): Promise<ApiResponse<Membership[]>> {
    return ok(await this.teamsService.listMembers(teamId, user.id));
  }

  /** Change a member's role (admin-only). */
  @Patch(':teamId/members/:userId/role')
  async setRole(
    @CurrentUser() user: User,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() dto: SetRoleDto,
  ): Promise<ApiResponse<Membership>> {
    return ok(await this.teamsService.setRole(teamId, user.id, userId, dto.role));
  }
}
