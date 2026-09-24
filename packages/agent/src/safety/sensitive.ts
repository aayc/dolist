/**
 * Detection and masking of sensitive values: payment card numbers (Luhn-checked), API keys and
 * other secrets, and US social security numbers. The rules use it to decide ("typing a card
 * number needs approval"); everything that shows or stores tool inputs uses it to mask.
 */

export type SensitiveValueKind = "card" | "secret" | "ssn";

export interface SensitiveMatch {
  kind: SensitiveValueKind;
  label: string;
  index: number;
  length: number;
}

/** 13–19 digits, optionally grouped by single spaces or dashes, not glued to other digits. */
const CARD_CANDIDATE_RE = /(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
/** Issuer prefixes (Visa, Mastercard, Amex, Diners, JCB, Discover, UnionPay, Maestro). */
const CARD_PREFIX_RE = /^(?:4|5[0-8]|2[2-7]|3[04-9]|6)/;

const SSN_RE = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

interface SecretPattern {
  label: string;
  re: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    label: "private key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { label: "API key", re: /\bsk-(?:or-v1-|ant-[a-z0-9]{2,8}-|proj-|svcacct-|admin-)?[\w-]{20,}/g },
  { label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/g },
  { label: "GitLab token", re: /\bglpat-[\w-]{20,}/g },
  { label: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: "Slack webhook", re: /hooks\.slack\.com\/services\/[\w/-]{20,}/g },
  { label: "Discord webhook", re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/g },
  { label: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "Google API key", re: /\bAIza[\w-]{35}/g },
  { label: "Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "JWT", re: /\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g },
  { label: "bearer token", re: /\bBearer\s+[\w.~+/-]{20,}=*/g },
  { label: "URL credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@/gi },
];

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A plausible payment card number: issuer prefix, 13–19 digits, Luhn-valid, not one repeated digit. */
export function isCardNumber(digits: string): boolean {
  return (
    digits.length >= 13 &&
    digits.length <= 19 &&
    CARD_PREFIX_RE.test(digits) &&
    !/^(\d)\1+$/.test(digits) &&
    luhnValid(digits)
  );
}

export function findCardNumbers(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
    if (isCardNumber(m[0].replace(/[ -]/g, ""))) {
      out.push({ kind: "card", label: "card number", index: m.index ?? 0, length: m[0].length });
    }
  }
  return out;
}

export function findSsns(text: string): SensitiveMatch[] {
  return [...text.matchAll(SSN_RE)].map((m) => ({
    kind: "ssn" as const,
    label: "social security number",
    index: m.index ?? 0,
    length: m[0].length,
  }));
}

/** Secrets with a recognizable format (API keys, tokens, private keys, credentials in URLs). */
export function findSecrets(text: string): SensitiveMatch[] {
  const out: SensitiveMatch[] = [];
  for (const { label, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ kind: "secret", label, index: m.index ?? 0, length: m[0].length });
    }
  }
  return out;
}

export function findSensitiveValues(text: string): SensitiveMatch[] {
  return [...findSecrets(text), ...findCardNumbers(text), ...findSsns(text)];
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True for a typed value that is probably a secret: a known token format, or a single long,
 * high-entropy token mixing character classes (how generated passwords and API keys look).
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  if (findSecrets(v).length > 0) return true;
  if (v.length < 20 || v.length > 256 || /\s/.test(v)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes("@") || /^[~/.]/.test(v)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  return classes >= 3 && shannonEntropy(v) >= 3.5;
}

/** Replaces card numbers (keeping the last 4 digits), secrets and SSNs inside free text. */
export function maskSensitiveText(text: string): string {
  let out = text;
  for (const { label, re } of SECRET_PATTERNS) out = out.replace(re, `[hidden ${label}]`);
  out = out.replace(CARD_CANDIDATE_RE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    return isCardNumber(digits) ? `•••• ${digits.slice(-4)}` : m;
  });
  return out.replace(SSN_RE, "•••-••-••••");
}

const SENSITIVE_KEY_RE =
  /^(?:pass(?:word|wd|code|phrase)?|secret|client_?secret|(?:access_?|refresh_?|auth_?|api_?)?token|api_?key|apikey|private_?key|cvv2?|cvc2?|csc|security_?code|ssn|card_?number|cc_?number|pin|otp|mfa_?code|totp)$/i;

export const HIDDEN_VALUE = "[hidden]";

export interface RedactOptions {
  /** Top-level keys whose values are hidden entirely (e.g. `text` when typing into a password field). */
  hideKeys?: ReadonlySet<string>;
  maxStringLength?: number;
}

/**
 * Deep copy of a tool input that is safe to show on approval cards, persist, or send to the LLM
 * judge: sensitive keys and typed secrets are hidden, card numbers/SSNs/secrets inside strings are
 * masked, and oversized values are truncated.
 */
export function redactSensitiveInput(input: unknown, options: RedactOptions = {}): unknown {
  const maxString = options.maxStringLength ?? 20_000;
  const visit = (value: unknown, key: string | undefined, depth: number): unknown => {
    if (typeof value === "string") {
      if (key && (SENSITIVE_KEY_RE.test(key) || (depth === 1 && options.hideKeys?.has(key)))) {
        return HIDDEN_VALUE;
      }
      const masked = maskSensitiveText(value);
      return masked.length > maxString ? `${masked.slice(0, maxString)}… (truncated)` : masked;
    }
    if (typeof value === "number" && key && SENSITIVE_KEY_RE.test(key)) return HIDDEN_VALUE;
    if (value === null || typeof value !== "object") return value;
    if (depth >= 8) return "[nested value omitted]";
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => visit(v, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = visit(v, k, depth + 1);
    return out;
  };
  return visit(input, undefined, 0);
}
