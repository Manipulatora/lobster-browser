import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Body for POST /api-keys. The only client-supplied field is a human-readable `name` used to
 * tell keys apart in the dashboard (e.g. "CI pipeline", "prod worker"). The secret, prefix, and
 * hash are all derived server-side — the caller never chooses them.
 *
 * `name` must be a non-empty string of 1..80 characters: `@IsNotEmpty` rejects the empty/blank
 * string (the lower bound) and `@MaxLength(80)` caps the upper bound. Anything outside this range
 * is a 400 from the global ValidationPipe before the request ever reaches the service.
 */
export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;
}
