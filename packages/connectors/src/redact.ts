/**
 * Masking for anything shown in approval cards, status errors or logs: values under credential-like
 * keys, and well-known token formats inside free text.
 *
 * Adapted from Hermes Agent (MIT): tools/mcp_tool_common.py (`_CREDENTIAL_PATTERN`).
 */

export const MASK = "•••";

const SENSITIVE_KEY_RE =
  /passw(or)?d|passphrase|^pwd$|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|auth$|cookie|credential|session[-_]?(id|key)|^(pin|cvv|cvc|otp|ssn)$/i;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bya29\.[0-9A-Za-z_-]{20,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|auth)=[^&\s"']+/gi, `$1=${MASK}`],
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
