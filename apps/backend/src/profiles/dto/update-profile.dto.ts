import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ENGINE_KINDS, OS_FAMILIES } from '@lobster/shared-types';
import type { EngineKind, FingerprintOverrides, OsFamily } from '@lobster/shared-types';

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
  @IsIn([...OS_FAMILIES])
  os?: OsFamily;

  // User-editable overrides applied on top of the seed-derived fingerprint. Accepted as opaque
  // JSON here; deep coherence validation lives in @lobster/fingerprint.
  @IsOptional()
  @IsObject()
  fingerprintOverrides?: FingerprintOverrides;

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
