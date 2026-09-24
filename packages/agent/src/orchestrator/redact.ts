import { truncate } from "@ddl/core";

/** Patterns for credentials that must never reach the UI or thread files. */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-(?:or-v1-|ant-[a-z]+\d*-|proj-)?[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, "gh_…[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, "github_pat_…[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA…[redacted]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox…[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza…[redacted]"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g, "sk_live_…[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted jwt]"],
  [
    /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE KEY-{5}|$)/g,
    "[redacted key]",
  ],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi,
    "$1[redacted]",
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** One-line, redacted, length-capped preview for UI surfaces (tool results, badges). */
export function previewText(text: string, max: number): string {
  return truncate(redactSecrets(text).replace(/\s+/g, " ").trim(), max);
}

const MAX_DEPTH = 6;
const MAX_STRING = 2_000;
const MAX_ITEMS = 50;

/** A display-safe copy of tool input: secrets redacted, long strings and collections capped. */
export function sanitizeForDisplay(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncate(redactSecrets(value), MAX_STRING);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return "…";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeForDisplay(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`… ${value.length - MAX_ITEMS} more`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (count++ >= MAX_ITEMS) break;
      if (item === undefined || typeof item === "function") continue;
      out[key] = /^(password|passwd|secret|token|api[_-]?key)$/i.test(key)
        ? "[redacted]"
        : sanitizeForDisplay(item, depth + 1);
    }
    return out;
  }
  return undefined;
}
