/**
 * The decode pipeline shared by every persisted sidecar format: BOM → JSON → object → `version` →
 * migrations → schema validation, with per-entry salvage of lists. Pure and isomorphic (runs in the
 * daemon, the web app and future native shells); nothing here ever includes file contents in the
 * problems it reports, so they are safe to log.
 */
import { z } from "zod";

/** Where a problem was found (`messages[3]`, `specs.tsk_1`) and what it is. Never holds content. */
export interface PersistedIssue {
  path: string;
  message: string;
}

export type PersistedDecodeResult<T> =
  | {
      ok: true;
      value: T;
      /** Version the file was written with; `null` for a legacy file without `version`. */
      fromVersion: number | null;
      /** Invalid list entries that were dropped. Non-empty means the file needs a repair. */
      issues: PersistedIssue[];
    }
  | { ok: false; kind: "corrupt"; reason: string }
  | { ok: false; kind: "newer"; version: number };

export type PersistedDocument = Record<string, unknown>;

export interface PersistedFormatSpec<T> {
  /** Current version: what this build writes. */
  version: number;
  /** Upgrades a legacy document that has no `version` field. Omit if the format never had one. */
  migrateUnversioned?: (doc: PersistedDocument) => PersistedDocument;
  /** One step per older version: `migrations[n]` turns a version-`n` document into `n + 1`. */
  migrations?: Readonly<Record<number, (doc: PersistedDocument) => PersistedDocument>>;
  /** Validates a current-version document; list entries that fail are dropped into `issues`. */
  read(doc: PersistedDocument, issues: PersistedIssue[]): T | PersistedCorruption;
}

/** Returned by `read` when the document as a whole is unusable. */
export class PersistedCorruption {
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

export type PersistedJsonResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** JSON.parse that tolerates a UTF-8 byte order mark and never echoes the text in its errors. */
export function parsePersistedJson(text: string): PersistedJsonResult {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return { ok: false, reason: "empty file" };
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, reason: `not valid JSON (${body.length} characters; truncated?)` };
  }
}

export function isPersistedObject(value: unknown): value is PersistedDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePersisted<T>(
  spec: PersistedFormatSpec<T>,
  text: string,
): PersistedDecodeResult<T> {
  const parsed = parsePersistedJson(text);
  if (!parsed.ok) return corrupt(parsed.reason);
  if (!isPersistedObject(parsed.value)) return corrupt("top level is not a JSON object");
  let doc = parsed.value;
  let fromVersion: number | null;
  let version: number;
  if (!Object.hasOwn(doc, "version")) {
    if (!spec.migrateUnversioned) return corrupt("missing `version`");
    // A legacy document becomes version 1, then climbs the numbered steps like any v1 file.
    doc = spec.migrateUnversioned(doc);
    fromVersion = null;
    version = 1;
  } else {
    const declared = doc.version;
    if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared < 1) {
      return corrupt("`version` is not a positive integer");
    }
    if (declared > spec.version) return { ok: false, kind: "newer", version: declared };
    fromVersion = declared;
    version = declared;
  }
  for (let from = version; from < spec.version; from++) {
    const step = spec.migrations?.[from];
    if (!step) return corrupt(`no migration from version ${from}`);
    doc = step(doc);
  }
  const issues: PersistedIssue[] = [];
  const value = spec.read(doc, issues);
  if (value instanceof PersistedCorruption) return corrupt(value.reason);
  return { ok: true, value, fromVersion, issues };
}

function corrupt(reason: string): { ok: false; kind: "corrupt"; reason: string } {
  return { ok: false, kind: "corrupt", reason };
}

/** Compact, content-free description of a zod error (paths and expectations only). */
export function describeZodError(error: z.ZodError, max = 3): string {
  const parts = error.issues.slice(0, max).map((issue) => {
    const at = issue.path.map(String).join(".");
    return at ? `${at}: ${issue.message}` : issue.message;
  });
  const more = error.issues.length > max ? ` (+${error.issues.length - max} more)` : "";
  return `${parts.join("; ")}${more}`;
}

/** Validates the non-list part of a document; failure makes the whole file corrupt. */
export function readEnvelope<S extends z.ZodType>(
  schema: S,
  doc: PersistedDocument,
): z.output<S> | PersistedCorruption {
  const result = schema.safeParse(doc);
  return result.success ? result.data : new PersistedCorruption(describeZodError(result.error));
}

/**
 * Validates each entry of a list on its own and drops the invalid ones. With `keyOf`, the list is
 * replayed as a sequence of upserts: a duplicate key keeps the first position and the last value.
 */
export function salvageList<S extends z.ZodType>(
  items: readonly unknown[],
  schema: S,
  label: string,
  issues: PersistedIssue[],
  keyOf?: (item: z.output<S>) => string,
): z.output<S>[] {
  const out: z.output<S>[] = [];
  const indexByKey = new Map<string, number>();
  items.forEach((item, i) => {
    const result = schema.safeParse(item);
    if (!result.success) {
      issues.push({ path: `${label}[${i}]`, message: describeZodError(result.error) });
      return;
    }
    if (!keyOf) {
      out.push(result.data);
      return;
    }
    const key = keyOf(result.data);
    const existing = indexByKey.get(key);
    if (existing === undefined) {
      indexByKey.set(key, out.length);
      out.push(result.data);
      return;
    }
    out[existing] = result.data;
    issues.push({ path: `${label}[${i}]`, message: `duplicate id "${key}" (the last entry wins)` });
  });
  return out;
}

/** Validates each value of a keyed object on its own; `keyMatches` rejects mismatched keys. */
export function salvageRecord<S extends z.ZodType>(
  entries: Readonly<Record<string, unknown>>,
  schema: S,
  label: string,
  issues: PersistedIssue[],
  keyMatches?: (key: string, value: z.output<S>) => boolean,
): Record<string, z.output<S>> {
  const out: Record<string, z.output<S>> = {};
  for (const [key, value] of Object.entries(entries)) {
    const result = schema.safeParse(value);
    if (!result.success) {
      issues.push({ path: `${label}.${key}`, message: describeZodError(result.error) });
      continue;
    }
    if (keyMatches && !keyMatches(key, result.data)) {
      issues.push({ path: `${label}.${key}`, message: "key does not match the entry's id" });
      continue;
    }
    out[key] = result.data;
  }
  return out;
}

/** A JSON array of anything (entries are validated one by one). */
export const PersistedListSchema = z.array(z.unknown());
/** A JSON object of anything (values are validated one by one). */
export const PersistedMapSchema = z.record(z.string(), z.unknown());
