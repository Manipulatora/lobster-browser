/**
 * Backend-side surface of the universal `{ code, data, msg }` response envelope.
 *
 * The canonical definitions live in `@lobster/shared-types` so the desktop UI, the local
 * automation API, and this cloud API all speak one wire contract (mirrors AdsPower/Octo,
 * where `code === 0` means success). We re-export the shared `ok`/`err` helpers from a
 * single local module so every feature module imports the envelope from one place.
 *
 * Usage in a controller:
 *   return ok(user);            // { code: 0, data: user, msg: 'success' }
 *   return err('not found');    // { code: 1, data: null, msg: 'not found' }
 */
import { API_ERR, API_OK, err, ok, type ApiResponse } from '@lobster/shared-types';

export { API_ERR, API_OK, err, ok };
export type { ApiResponse };
