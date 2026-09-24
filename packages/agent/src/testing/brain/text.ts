/** Small deterministic text helpers for the fake brain (no randomness, no clock). */

/** FNV-1a, 32-bit. */
export function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Picks a phrasing: always the first variant with seed 0 (stable text for assertions), otherwise a
 * variant chosen by hashing the seed with `key` (same seed + key → same variant).
 */
export function pick(variants: readonly string[], seed: number, key: string): string {
  if (variants.length === 0) return "";
  if (seed === 0) return variants[0]!;
  return variants[hash32(`${seed}\u0000${key}`) % variants.length]!;
}

export function lowerFirst(text: string): string {
  return text.length > 1 && /^[A-Z][a-z]/.test(text)
    ? text[0]!.toLowerCase() + text.slice(1)
    : text;
}

export function upperFirst(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** One line, at most `max` characters (with an ellipsis). */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function slugify(text: string, max = 48): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "task";
}

/** Rough token count (4 characters per token), like the providers' estimates. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

/** First http(s) URL in the text, without trailing punctuation. */
export function firstUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s<>"'()[\]]+/i.exec(text);
  return match ? match[0].replace(/[.,;:!?]+$/, "") : undefined;
}

export function allUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'()[\]]+/gi)].map((m) =>
    m[0].replace(/[.,;:!?]+$/, ""),
  );
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Parses a JSON string literal starting at `text[start]` (which must be `"`). */
export function readJsonString(text: string, start: number): { value: string; end: number } | null {
  if (text[start] !== '"') return null;
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') {
      try {
        return { value: JSON.parse(text.slice(start, i + 1)) as string, end: i + 1 };
      } catch {
        return null;
      }
    }
    i++;
  }
  return null;
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
