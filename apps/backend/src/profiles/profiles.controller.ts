import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Profile, User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SyncProfileDto } from './dto/sync-profile.dto';
import { ProfilesService, type SyncResult } from './profiles.service';

/**
 * Profile CRUD + encrypted-blob sync. Every route requires a valid JWT; the owning team is
 * resolved from the authenticated caller's membership (or an explicit `?teamId=` they belong to),
 * never a stub. All responses use the shared `{ code, data, msg }` envelope.
 */
@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateProfileDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile>> {
    return ok(await this.profilesService.create(user.id, dto, teamId));
  }

  @Get()
  async findAll(
    @CurrentUser() user: User,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile[]>> {
    return ok(await this.profilesService.findAll(user.id, teamId));
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile>> {
    return ok(await this.profilesService.findOne(user.id, id, teamId));
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile>> {
    return ok(await this.profilesService.update(user.id, id, dto, teamId));
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<{ id: string; deleted: true }>> {
    return ok(await this.profilesService.remove(user.id, id, teamId));
  }

  /**
   * Push/pull the encrypted profile blob. Body: `{ direction?: 'push' | 'pull' }` (defaults to
   * `'push'`); any other `direction` is rejected with a 400 by the validation pipe.
   * STUB — see ProfilesService.sync for the real S3 wiring planned for Day 2.
   */
  @Post(':id/sync')
  async sync(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SyncProfileDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<SyncResult>> {
    return ok(await this.profilesService.sync(user.id, id, dto.direction ?? 'push', teamId));
  }
}
