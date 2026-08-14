/** Shared credential-shaped text detection for transient events and encrypted durable stores. */

export const REDACTED_SENSITIVE = '[REDACTED: credential-like content]';

/**
 * Credentials do not belong in UI action events, memory facts, learned procedures, or recovery data,
 * even when the durable envelope is encrypted. This deliberately detects credential-shaped values,
 * while leaving harmless phrases such as "open password settings" untouched.
 */
export function redactCredentialLikeText(value: string): { text: string; sensitive: boolean } {
  const sensitive =
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\b(?:VENICE_INFERENCE_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|LOBEE_MEMORY_KEY|LOBSTER_MEMORY_KEY)[_=: -]+[A-Za-z0-9._~-]{8,}\b/i.test(
      value,
    ) ||
    /\b(?:sk|pk|rk|api|tsk)[-_][A-Za-z0-9_-]{12,}\b/i.test(value) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/.test(
      value,
    ) ||
    /\b(?:password|passcode|otp|one[- ]?time code|verification code|token|api[-_ ]?key|secret|cvv|cvc)\b\s*(?:is|=|:)\s*[^\s,;]{4,}/i.test(
      value,
    ) ||
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
    /[?&#](?:sig|signature|access[_-]?key|client[_-]?secret|auth|session|token)=[^&#\s]{8,}/i.test(
      value,
    ) ||
    /\/(?:token|secret|session|auth|api[-_]?key)\/[A-Za-z0-9._~-]{12,}(?:[/?#]|$)/i.test(value);
  return sensitive
    ? { text: REDACTED_SENSITIVE, sensitive: true }
    : { text: value, sensitive: false };
}

/** True when a prompt asks the human to supply a credential even though it contains no value yet. */
export function requestsSensitiveInput(value: string): boolean {
  const credential =
    '(?:pass(?:word|code)?|pin|otp|one[- ]?time(?: code)?|verification code|2fa|mfa|security code|api[-_ ]?key|access token|auth token|secret|cvv|cvc|card number|private key|seed phrase|recovery code)';
  return (
    new RegExp(
      `\\b(?:enter|provide|supply|share|paste|type|submit|reveal|send|give|tell me|what is|what['’]s)\\b.{0,80}\\b${credential}\\b`,
      'i',
    ).test(value) ||
    new RegExp(`\\b${credential}\\b.{0,40}\\b(?:is required|needed|to continue)\\b`, 'i').test(
      value,
    )
  );
}
