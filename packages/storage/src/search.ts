import { isMarkdownPath, type SearchHit, stem } from "@ddl/core";
import type { FileEntry, StorageProvider } from "./types";

export interface SearchOptions {
  /** Maximum number of hits. Default 50. */
  limit?: number;
  /** Search hidden paths (e.g. the sidecar folder) too. Default false. */
  includeHidden?: boolean;
  /** Skip larger files. Default 1 MB. */
  maxFileBytes?: number;
}

const PREVIEW_CHARS = 160;
const READ_BATCH = 16;
/** Note text kept between searches, per provider, in UTF-16 code units (original + lowercase). */
const CACHE_BUDGET_CHARS = 32 * 1024 * 1024;

interface CachedNote {
  version: string;
  text: string;
  lower: string;
}

interface NoteCache {
  notes: Map<string, CachedNote>;
  chars: number;
}

/** Keyed by provider so the cache lives exactly as long as the vault it mirrors. */
const caches = new WeakMap<StorageProvider, NoteCache>();

/**
 * Case-insensitive search over the vault's markdown files: every whitespace-separated term must
 * appear in the note's name or on one line. File-name matches come first
 * (`kind: "name"`, path as preview); then matching lines (`kind: "content"`, 0-based `line`) from
 * the most recently modified notes, with a ~160-character preview centred on the match. Stops at
 * `limit`.
 *
 * Note contents are cached per provider and validated against the listed version, so repeated
 * searches (search-as-you-type) only read notes that changed.
 */
export async function searchVault(
  provider: StorageProvider,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  const limit = options.limit ?? 50;
  if (needle === "" || limit <= 0) return [];
  // Every whitespace-separated term must appear (in the name, or on the same line).
  const terms = [...new Set(needle.split(/\s+/))];
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;

  const notes = (await provider.list({ includeHidden: options.includeHidden === true }))
    .filter((file) => isMarkdownPath(file.path))
    .sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const cache = cacheFor(provider, notes);

  const hits: SearchHit[] = [];
  // Queries with a slash match the whole path; otherwise just the note's name.
  const matchPath = needle.includes("/");
  for (const note of notes) {
    const name = matchPath ? note.path.slice(0, -".md".length) : stem(note.path);
    const lowerName = name.toLowerCase();
    if (terms.every((term) => lowerName.includes(term))) {
      hits.push({ path: note.path, kind: "name", line: 0, preview: note.path });
      if (hits.length >= limit) return hits;
    }
  }

  const searchable = notes.filter((note) => note.size <= maxFileBytes);
  for (let i = 0; i < searchable.length; i += READ_BATCH) {
    const batch = searchable.slice(i, i + READ_BATCH);
    const loaded = await Promise.all(batch.map((note) => loadNote(provider, cache, note)));
    for (const [index, note] of loaded.entries()) {
      if (!note) continue;
      for (const hit of matchLines(batch[index]!.path, note, terms, limit - hits.length)) {
        hits.push(hit);
      }
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** The provider's cache, minus notes that are no longer listed. */
function cacheFor(provider: StorageProvider, notes: readonly FileEntry[]): NoteCache {
  let cache = caches.get(provider);
  if (!cache) {
    cache = { notes: new Map(), chars: 0 };
    caches.set(provider, cache);
  }
  const listed = new Set(notes.map((note) => note.path));
  for (const [path, note] of cache.notes) {
    if (!listed.has(path)) forget(cache, path, note);
  }
  return cache;
}

async function loadNote(
  provider: StorageProvider,
  cache: NoteCache,
  entry: FileEntry,
): Promise<CachedNote | null> {
  const cached = cache.notes.get(entry.path);
  if (cached?.version === entry.version) return cached;
  if (cached) forget(cache, entry.path, cached);
  const file = await provider.read(entry.path);
  if (!file) return null;
  const note = { version: file.version, text: file.content, lower: file.content.toLowerCase() };
  const size = note.text.length + note.lower.length;
  if (cache.chars + size <= CACHE_BUDGET_CHARS) {
    cache.notes.set(entry.path, note);
    cache.chars += size;
  }
  return note;
}

function forget(cache: NoteCache, path: string, note: CachedNote): void {
  cache.notes.delete(path);
  cache.chars -= note.text.length + note.lower.length;
}

/**
 * One hit per line containing every term. Scans the whole lowercase text for the first term instead
 * of splitting lines, then checks the remaining terms on each candidate line.
 */
function matchLines(
  path: string,
  note: CachedNote,
  terms: readonly string[],
  max: number,
): SearchHit[] {
  const { text, lower } = note;
  // Rare case-mappings change the length (e.g. "İ"), so indexes wouldn't line up: go line by line.
  if (lower.length !== text.length) return matchLinesSlow(path, text, terms, max);
  const [first, ...rest] = terms as [string, ...string[]];
  const hits: SearchHit[] = [];
  let line = 0;
  let lineStart = 0;
  let at = lower.indexOf(first);
  while (at !== -1 && hits.length < max) {
    for (
      let nl = text.indexOf("\n", lineStart);
      nl !== -1 && nl < at;
      nl = text.indexOf("\n", lineStart)
    ) {
      line++;
      lineStart = nl + 1;
    }
    const newline = text.indexOf("\n", at);
    const lineEnd = newline === -1 ? text.length : newline;
    const lowerLine = lower.slice(lineStart, lineEnd);
    if (rest.every((term) => lowerLine.includes(term))) {
      const content = text.slice(lineStart, lineEnd).replace(/\r$/, "");
      hits.push({
        path,
        kind: "content",
        line,
        preview: preview(content, at - lineStart, first.length),
      });
    }
    if (newline === -1) break;
    at = lower.indexOf(first, newline + 1);
  }
  return hits;
}

function matchLinesSlow(
  path: string,
  text: string,
  terms: readonly string[],
  max: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const line = lines[i]!;
    const lowerLine = line.toLowerCase();
    if (!terms.every((term) => lowerLine.includes(term))) continue;
    const at = lowerLine.indexOf(terms[0]!);
    hits.push({ path, kind: "content", line: i, preview: preview(line, at, terms[0]!.length) });
  }
  return hits;
}

/** The line, or a window of it centred on the match with ellipses where it was cut. */
function preview(line: string, matchStart: number, matchLength: number): string {
  if (line.length <= PREVIEW_CHARS) return line.trim();
  const center = matchStart + Math.floor(matchLength / 2);
  const start = Math.max(0, Math.min(center - PREVIEW_CHARS / 2, line.length - PREVIEW_CHARS));
  const end = Math.min(line.length, start + PREVIEW_CHARS);
  const body = line.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < line.length ? "…" : ""}`;
}
