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
   * Push/pull the CLIENT-encrypted profile blob. Body:
   *   `{ direction?: 'push' | 'pull', payload?: base64, baseVersion?: int }`
   * `direction` defaults to `'push'`; any other value is a 400 from the validation pipe. On push,
   * `payload` (the encrypted blob) is stored opaquely and the version bumps; supplying `baseVersion`
   * turns on conflict detection (a mismatch is a 409). On pull, the latest blob is returned base64.
   */
  @Post(':id/sync')
  async sync(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: SyncProfileDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<SyncResult>> {
    return ok(
      await this.profilesService.sync(
        user.id,
        id,
        { direction: dto.direction ?? 'push', payload: dto.payload, baseVersion: dto.baseVersion },
        teamId,
      ),
    );
  }
}
