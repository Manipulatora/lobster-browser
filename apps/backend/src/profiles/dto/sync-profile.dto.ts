import { IsBase64, IsDefined, IsIn, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import type { SyncDirection } from '../profiles.service';

/**
 * Body for POST /profiles/:id/sync.
 *
 * `direction` selects push (upload a new encrypted blob) or pull (fetch the latest); it is
 * validated so only the two known modes are accepted — anything else is a 400 at the boundary.
 * When omitted the service defaults to `'push'` (see ProfilesController.sync).
 *
 * `payload` is the CLIENT-encrypted blob, base64-encoded — the server stores it opaquely and never
 * decrypts it. Required for a push; ignored on a pull.
 *
 * `baseVersion` is the version the client believes is current. It is mandatory on a push (`0` for
 * a profile that has never been uploaded) so every write is optimistic-concurrency checked; a
 * mismatch with the stored version is a 409. Pulls do not require it.
 */
export class SyncProfileDto {
  @IsOptional()
  @IsIn(['push', 'pull'] satisfies SyncDirection[])
  direction?: SyncDirection;

  @IsOptional()
  @IsBase64()
  payload?: string;

  @ValidateIf((dto: SyncProfileDto) => dto.direction !== 'pull' || dto.baseVersion !== undefined)
  @IsDefined()
  @IsInt()
  @Min(0)
  baseVersion?: number;
}
