import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PROFILE_OS_TARGETS, ENGINE_KINDS } from '@lobster/shared-types';
import type { EngineKind, FingerprintOverrides, ProfileOsTarget } from '@lobster/shared-types';

import {
  BrowserExtensionRefDto,
  CookieImportMetadataDto,
  MAX_PROFILE_EXTENSIONS,
} from './profile-metadata.dto';

/**
 * Body for PATCH /profiles/:id. Every field is optional (partial update). The desktop editor
 * legitimately re-tunes `engine`, `os`, and `fingerprintOverrides`, so those are editable here.
 *
 * `fingerprintSeed` is intentionally NOT editable: the seed IS the profile's identity, and
 * changing it would silently swap the whole derived fingerprint — create a new profile instead.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn([...ENGINE_KINDS])
  engine?: EngineKind;

  @IsOptional()
  @IsIn([...PROFILE_OS_TARGETS])
  os?: ProfileOsTarget;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  osVersion?: string;

  // User-editable overrides applied on top of the seed-derived fingerprint. Accepted as opaque
  // JSON here; deep coherence validation lives in @lobster/fingerprint.
  @IsOptional()
  @IsObject()
  fingerprintOverrides?: FingerprintOverrides;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  proxyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  templateId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CookieImportMetadataDto)
  cookiesImport?: CookieImportMetadataDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PROFILE_EXTENSIONS)
  @ValidateNested({ each: true })
  @Type(() => BrowserExtensionRefDto)
  extensions?: BrowserExtensionRefDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  folder?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
