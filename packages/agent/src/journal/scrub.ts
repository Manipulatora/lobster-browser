import type { JournalSensitiveReason } from './schema.js';

const REDACTED_CREDENTIAL = '[REDACTED_CREDENTIAL]';
const REDACTED_PATH = '[REDACTED_LOCAL_PATH]';
const REDACTED_ENDPOINT = '[REDACTED_PROVIDER_ENDPOINT]';
const REDACTED_IMAGE = '[REDACTED_IMAGE_PAYLOAD]';

export interface ScrubbedJournalText {
  text: string;
  sensitive: boolean;
  reasons: JournalSensitiveReason[];
}

/**
 * Scrub at the persistence boundary, even if an upstream caller claims its data is safe. Encryption
 * limits disclosure after theft; it is not permission to retain replayable credentials or local paths.
 */
export function scrubJournalText(input: string): ScrubbedJournalText {
  let text = input.replace(/\0/g, '');
  const reasons = new Set<JournalSensitiveReason>();
  const replace = (pattern: RegExp, replacement: string, reason: JournalSensitiveReason): void => {
    const before = text;
    text = text.replace(pattern, replacement);
    if (text !== before) reasons.add(reason);
  };

  replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    REDACTED_CREDENTIAL,
    'credential',
  );
  replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi, REDACTED_CREDENTIAL, 'credential');
  replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED_CREDENTIAL,
    'credential',
  );
  replace(
    /\b(?:VENICE_INFERENCE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|LOBEE_MEMORY_KEY|LOBSTER_MEMORY_KEY)[_=: -]+[A-Za-z0-9._~-]{8,}\b/gi,
    REDACTED_CREDENTIAL,
    'credential',
  );
  replace(/\b(?:sk|pk|rk|api|tsk)[-_][A-Za-z0-9_-]{12,}\b/gi, REDACTED_CREDENTIAL, 'credential');
  replace(
    /\b(?:password|passcode|otp|one[- ]?time code|verification code|access token|refresh token|api[-_ ]?key|memory key|encryption key|client secret|secret|cvv|cvc)\b\s*(?:is|=|:)\s*["']?[^\s,;"']{4,}["']?/gi,
    REDACTED_CREDENTIAL,
    'credential',
  );
  replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/gi, REDACTED_CREDENTIAL, 'credential');

  // Provider URLs are configuration, not browser recovery state. Keep model identifiers separately.
  replace(
    /https?:\/\/(?:api\.)?(?:openai\.com|anthropic\.com|venice\.ai|generativelanguage\.googleapis\.com|openrouter\.ai)(?:\/[^\s]*)?/gi,
    REDACTED_ENDPOINT,
    'provider_configuration',
  );
  replace(
    /\b(?:base[_ -]?url|provider[_ -]?endpoint|api[_ -]?endpoint)\b\s*(?:is|=|:)\s*https?:\/\/[^\s]+/gi,
    REDACTED_ENDPOINT,
    'provider_configuration',
  );

  // Only absolute local filesystem forms are removed. Browser URL paths such as /settings stay useful.
  replace(
    /(^|[\s"'(])(?:\/(?:home|Users|root|tmp|var\/tmp|private\/tmp|mnt|media|run\/user|srv|opt)\/[\w@.+~/-]+|[A-Za-z]:\\(?:[^\s"'<>|]+\\)*[^\s"'<>|]*)/g,
    `$1${REDACTED_PATH}`,
    'upload_path',
  );

  replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, REDACTED_IMAGE, 'image_payload');
  replace(
    /\b(?:screenshot|image)\s*(?:data|payload)?\s*(?:is|=|:)\s*[A-Za-z0-9+/]{256,}={0,2}/gi,
    REDACTED_IMAGE,
    'image_payload',
  );

  return { text, sensitive: reasons.size > 0, reasons: [...reasons] };
}
