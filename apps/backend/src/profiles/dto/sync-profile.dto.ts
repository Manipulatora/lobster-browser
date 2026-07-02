import { IsBase64, IsIn, IsInt, IsOptional, Min } from 'class-validator';
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
 * `baseVersion` is the version the client believes is current. When provided on a push it enables
 * optimistic-concurrency conflict detection: a mismatch with the stored version is a 409.
 */
export class SyncProfileDto {
  @IsOptional()
  @IsIn(['push', 'pull'] satisfies SyncDirection[])
  direction?: SyncDirection;

  @IsOptional()
  @IsBase64()
  payload?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseVersion?: number;
}
