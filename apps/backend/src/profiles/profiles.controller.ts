import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Profile, ProfileExportBundle, User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';

import { BulkCreateProfilesDto } from './dto/bulk-create-profiles.dto';
import { CreateProfileDto } from './dto/create-profile.dto';
import { ImportProfilesDto } from './dto/import-profiles.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SyncProfileDto } from './dto/sync-profile.dto';
import { ProfilesService, type SyncResult } from './profiles.service';

/**
 * Profile CRUD + encrypted-blob sync. Every route requires a valid JWT; the owning team is
 * resolved from the authenticated caller's membership (or an explicit `?teamId=` they belong to),
 * never a stub. All responses use the shared `{ code, data, msg }` envelope.
 */
@Controller('profiles')
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

  /** Create many profiles at once (each with its own unique seed). Batch plan-limit-checked. */
  @Post('bulk')
  async bulkCreate(
    @CurrentUser() user: User,
    @Body() dto: BulkCreateProfilesDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile[]>> {
    return ok(await this.profilesService.bulkCreate(user.id, dto, teamId));
  }

  // NOTE: declared BEFORE `@Get(':id')` so the literal path is not captured as an :id.
  /** Export every team profile as a portable, secret-free bundle (the transfer format). */
  @Get('export')
  async exportAll(
    @CurrentUser() user: User,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<ProfileExportBundle>> {
    return ok(await this.profilesService.exportAll(user.id, teamId));
  }

  /** Import a bundle: re-create each profile under the caller's team, preserving its seed identity. */
  @Post('import')
  async importBundle(
    @CurrentUser() user: User,
    @Body() dto: ImportProfilesDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Profile[]>> {
    return ok(await this.profilesService.importBundle(user.id, dto, teamId));
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
   * Push/pull the CLIENT-encrypted profile blob. Body:
   *   `{ direction?: 'push' | 'pull', payload?: base64, baseVersion?: int }`
   * `direction` defaults to `'push'`; any other value is a 400 from the validation pipe. On push,
   * `payload` (the encrypted blob) and `baseVersion` are required; every write is conflict-checked
   * (a mismatch is a 409). On pull, the latest blob is returned base64 and no version is required.
   */
  @Post(':id/sync')
  async sync(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SyncProfileDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<SyncResult>> {
    const direction = dto.direction ?? 'push';
    return ok(
      await this.profilesService.sync(
        user.id,
        id,
        direction === 'push'
          ? { direction, payload: dto.payload, baseVersion: dto.baseVersion! }
          : { direction, payload: dto.payload, baseVersion: dto.baseVersion },
        teamId,
      ),
    );
  }
}
