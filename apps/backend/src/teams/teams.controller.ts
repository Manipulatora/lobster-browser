import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { IsEmail, IsIn, IsString, MaxLength } from 'class-validator';
import type { Membership, Role, Team } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { TeamsService } from './teams.service';

// --- Inline DTOs (kept next to the controller since they are small) ---

class CreateTeamDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  // TODO(Day 2): derive ownerUserId from the authenticated JWT instead of the body.
  @IsString()
  ownerUserId!: string;
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
 * Team management endpoints. All responses use the shared `{ code, data, msg }` envelope.
 * TODO(Day 2): protect every route with the JwtAuthGuard + an admin-role check.
 */
@Controller('teams')
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

  @Post()
  async createTeam(@Body() dto: CreateTeamDto): Promise<ApiResponse<Team>> {
    return ok(await this.teamsService.createTeam(dto.name, dto.ownerUserId));
  }

  @Post(':teamId/members')
  async inviteMember(
    @Param('teamId') teamId: string,
    @Body() dto: InviteMemberDto,
  ): Promise<ApiResponse<Membership>> {
    return ok(await this.teamsService.inviteMember(teamId, dto.email, dto.role));
  }

  @Get(':teamId/members')
  async listMembers(@Param('teamId') teamId: string): Promise<ApiResponse<Membership[]>> {
    return ok(await this.teamsService.listMembers(teamId));
  }

  @Patch(':teamId/members/:userId/role')
  async setRole(
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() dto: SetRoleDto,
  ): Promise<ApiResponse<Membership>> {
    return ok(await this.teamsService.setRole(teamId, userId, dto.role));
  }
}
