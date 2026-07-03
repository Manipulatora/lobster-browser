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
import { Type } from 'class-transformer';
import { ENGINE_KINDS, OS_FAMILIES } from '@lobster/shared-types';
import type { EngineKind, FingerprintOverrides, OsFamily } from '@lobster/shared-types';

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

  @IsIn([...OS_FAMILIES])
  os!: OsFamily;

  @IsString()
  @MaxLength(256)
  fingerprintSeed!: string;

  @IsOptional()
  @IsObject()
  fingerprintOverrides?: FingerprintOverrides;

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
