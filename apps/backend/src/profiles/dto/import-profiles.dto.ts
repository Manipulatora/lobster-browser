import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PROFILE_OS_TARGETS, ENGINE_KINDS } from '@lobster/shared-types';
import type { EngineKind, FingerprintOverrides, ProfileOsTarget } from '@lobster/shared-types';

import {
  BrowserExtensionRefDto,
  CookieImportMetadataDto,
  MAX_PROFILE_EXTENSIONS,
} from './profile-metadata.dto';

/** Upper bound on a single import bundle. */
export const MAX_IMPORT_PROFILES = 200;

/**
 * One profile inside an import bundle — a SECRET-FREE snapshot (no encrypted blob, no ids). The
 * `fingerprintSeed` carries the identity, so importing re-materialises the same coherent fingerprint.
 */
export class ProfileImportItemDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn([...ENGINE_KINDS])
  engine!: EngineKind;

  @IsIn([...PROFILE_OS_TARGETS])
  os!: ProfileOsTarget;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  osVersion?: string;

  @IsString()
  @Matches(/^[0-9a-f]{8,256}$/, {
    message: 'fingerprintSeed must be 8 to 256 lowercase hexadecimal characters',
  })
  fingerprintSeed!: string;

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

  // Lenient on import: a bundle from another tool may omit tags; the service defaults to [].
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

/**
 * Body for POST /profiles/import — a versioned bundle of exported profiles (the export/transfer wire
 * format, `ProfileExportBundle`). The full batch is plan-limit-checked before anything is created.
 */
export class ImportProfilesDto {
  @IsIn([1])
  version!: 1;

  @IsOptional()
  @IsString()
  exportedAt?: string;

  @IsArray()
  @ArrayMaxSize(MAX_IMPORT_PROFILES)
  @ValidateNested({ each: true })
  @Type(() => ProfileImportItemDto)
  profiles!: ProfileImportItemDto[];
}
