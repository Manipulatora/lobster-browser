import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ENGINE_KINDS, OS_FAMILIES } from '@lobster/shared-types';
import type {
  CreateProfileInput,
  EngineKind,
  FingerprintOverrides,
  OsFamily,
} from '@lobster/shared-types';

/**
 * Body for POST /profiles. Implements the shared `CreateProfileInput` contract so the
 * cloud API accepts exactly what the desktop UI produces.
 *
 * `engine`/`os` validate against the runtime `ENGINE_KINDS`/`OS_FAMILIES` arrays from
 * @lobster/shared-types — the single source of truth — so the accepted set never drifts
 * (notably `lobium` is a first-class engine, not a 400).
 *
 * NOTE: `fingerprintOverrides` and `proxy` are part of `CreateProfileInput` but are
 * accepted as opaque JSON here (deep validation lives in `@lobster/fingerprint` /
 * `@lobster/proxy`); we `Pick` the flat, class-validator-friendly fields for now.
 */
export class CreateProfileDto implements Pick<
  CreateProfileInput,
  | 'name'
  | 'engine'
  | 'os'
  | 'fingerprintSeed'
  | 'fingerprintOverrides'
  | 'tags'
  | 'folder'
  | 'notes'
> {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn([...ENGINE_KINDS])
  engine!: EngineKind;

  @IsIn([...OS_FAMILIES])
  os!: OsFamily;

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
