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
import type {
  CreateProfileInput,
  EngineKind,
  FingerprintOverrides,
  ProfileOsTarget,
} from '@lobster/shared-types';

import {
  BrowserExtensionRefDto,
  CookieImportMetadataDto,
  MAX_PROFILE_EXTENSIONS,
} from './profile-metadata.dto';

/**
 * Body for POST /profiles. Implements the shared `CreateProfileInput` contract so the
 * cloud API accepts exactly what the desktop UI produces.
 *
 * `engine`/`os` validate against the runtime `ENGINE_KINDS`/`DESKTOP_PROFILE_OS_TARGETS` arrays from
 * @lobster/shared-types — the single source of truth — so the accepted set never drifts
 * (notably `lobium` is a first-class engine, not a 400).
 *
 * Inline `proxy` is intentionally excluded: cloud profiles persist only the non-secret proxy id.
 * Cookie import metadata is accepted, but the raw cookie text is deliberately not part of its
 * nested DTO and is rejected by the global whitelist validation pipe.
 */
export class CreateProfileDto implements Pick<
  CreateProfileInput,
  | 'name'
  | 'engine'
  | 'os'
  | 'osVersion'
  | 'fingerprintSeed'
  | 'fingerprintOverrides'
  | 'proxyId'
  | 'templateId'
  | 'cookiesImport'
  | 'extensions'
  | 'tags'
  | 'folder'
  | 'notes'
> {
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

  // Optional — if omitted the server generates a random seed (deterministic fingerprint source).
  @IsOptional()
  @IsString()
  fingerprintSeed?: string;

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
