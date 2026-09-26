/** Lowercases, trims and collapses internal whitespace. */
export function normalizeText(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Sørensen–Dice coefficient over character bigrams (0..1). Linear time, robust to typos and
 * small edits, which is what we need for tracking a to-do item while it is being rewritten.
 */
export function diceSimilarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** True when one normalized string extends the other (e.g. the user is still typing). */
export function isPrefixExtension(a: string, b: string, minLength = 3): boolean {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (x.length < minLength || y.length < minLength) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** At most `max` UTF-16 units, ending in `…` when cut. Never splits a surrogate pair. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  if (max < 1) return "";
  let end = max - 1;
  const last = input.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${input.slice(0, end).trimEnd()}…`;
}

/** Fast non-cryptographic 53-bit hash (cyrb53) rendered as hex. For change detection only. */
export function hashString(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Splits text into lines, tolerating CRLF. */
export function splitLines(input: string): string[] {
  return input.split(/\r?\n/);
}

/** "1 file", "2 files"; pass `plural` for irregular nouns. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Orders by UTF-16 code units, like `sort()` without a comparator: stable across locales. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
