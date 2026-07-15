import type { CookieImportDraft } from '@lobster/shared-types';

import type { SafeCookieImportMetadata } from './profiles.repository';

/**
 * Copy only the explicitly non-secret cookie-import diagnostics.
 *
 * This is a defence-in-depth boundary for legacy rows and direct repository callers: `rawText`
 * and any unknown future fields are discarded even if they bypass HTTP DTO validation.
 */
export function sanitizeCookieImportMetadata(
  draft: CookieImportDraft | undefined,
): SafeCookieImportMetadata | undefined {
  if (!draft) {
    return undefined;
  }
  return {
    mode: draft.mode,
    ...(draft.source !== undefined ? { source: draft.source } : {}),
    ...(draft.fileName !== undefined ? { fileName: draft.fileName } : {}),
    ...(draft.parsedCount !== undefined ? { parsedCount: draft.parsedCount } : {}),
    ...(draft.errors !== undefined
      ? {
          errors: draft.errors.map((error) => ({
            ...(error.line !== undefined ? { line: error.line } : {}),
            message: error.message,
          })),
        }
      : {}),
  };
}
