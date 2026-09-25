/**
 * `.daily-do-list/import/obsidian.json` — what an import copied from an Obsidian vault, so
 * "Update from Obsidian" can tell which files changed there, here, or on both sides. Written by
 * the daemon's importer (apps/daemon/src/import/manifest.ts), compact JSON with a trailing newline.
 * `source` is a folder on this machine, so the sync engine never syncs the file.
 *
 * v1: `{ version, source, importedAt, updatedAt?, previousVault?, files: { <vault path>: entry } }`.
 * The format was versioned from the start: a file without `version` is corrupt.
 */
import { z } from "zod";
import {
  decodePersisted,
  describeZodError,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedFormatSpec,
  PersistedMapSchema,
  readEnvelope,
} from "./common";
import { PersistedCountSchema, PersistedTimestampSchema } from "./primitives";

export const PERSISTED_IMPORT_MANIFEST_VERSION = 1;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "not a SHA-256 hex digest");

export const PersistedImportFileSchema = z.object({
  /** SHA-256 of the source file when it was last copied or seen. */
  sha256: Sha256Schema,
  /** The source file's size and mtime then: equal ones mean unchanged without hashing. */
  size: PersistedCountSchema,
  mtimeMs: PersistedTimestampSchema,
  /**
   * SHA-256 of what this vault last got from the source, when it differs from `sha256` (a daily
   * note merged at import, or a conflict kept here). A file that no longer matches it (or
   * `sha256` without it) was changed here.
   */
  base: Sha256Schema.optional(),
});
export type PersistedImportFile = z.infer<typeof PersistedImportFileSchema>;

export const PersistedImportManifestFileSchema = z.object({
  version: z.literal(PERSISTED_IMPORT_MANIFEST_VERSION),
  /** The Obsidian vault's folder (absolute). */
  source: z.string().min(1),
  importedAt: PersistedTimestampSchema,
  /** The last "Update from Obsidian". */
  updatedAt: PersistedTimestampSchema.optional(),
  /** The vault that was current at the import (absolute), left untouched; added later in v1. */
  previousVault: z.string().min(1).optional(),
  /** Keyed by vault path. */
  files: z.record(z.string(), PersistedImportFileSchema),
});
export type PersistedImportManifestFile = z.infer<typeof PersistedImportManifestFileSchema>;

/** The manifest without `version`; `files` is a Map so any path (even `__proto__`) is a key. */
export interface PersistedImportManifest {
  source: string;
  importedAt: number;
  updatedAt?: number;
  previousVault?: string;
  files: Map<string, PersistedImportFile>;
}

const ManifestEnvelopeSchema = z.object({
  source: z.string().min(1),
  importedAt: PersistedTimestampSchema,
  updatedAt: PersistedTimestampSchema.optional(),
  previousVault: z.string().min(1).optional(),
  files: PersistedMapSchema,
});

const manifestSpec: PersistedFormatSpec<PersistedImportManifest> = {
  version: PERSISTED_IMPORT_MANIFEST_VERSION,
  read(doc, issues) {
    const envelope = readEnvelope(ManifestEnvelopeSchema, doc);
    if (envelope instanceof PersistedCorruption) return envelope;
    const files = new Map<string, PersistedImportFile>();
    // The raw object, not the parsed copy: rebuilding it drops a path named `__proto__`.
    for (const [path, value] of Object.entries(doc.files as Record<string, unknown>)) {
      const entry = PersistedImportFileSchema.safeParse(value);
      if (entry.success) files.set(path, entry.data);
      else issues.push({ path: `files.${path}`, message: describeZodError(entry.error) });
    }
    return {
      source: envelope.source,
      importedAt: envelope.importedAt,
      ...(envelope.updatedAt === undefined ? {} : { updatedAt: envelope.updatedAt }),
      ...(envelope.previousVault === undefined ? {} : { previousVault: envelope.previousVault }),
      files,
    };
  },
};

export function decodePersistedImportManifest(
  text: string,
): PersistedDecodeResult<PersistedImportManifest> {
  return decodePersisted(manifestSpec, text);
}

/** Files sorted by path, so the file is stable. */
export function encodePersistedImportManifest(manifest: PersistedImportManifest): string {
  const paths = [...manifest.files.keys()].sort();
  const file: PersistedImportManifestFile = {
    version: PERSISTED_IMPORT_MANIFEST_VERSION,
    source: manifest.source,
    importedAt: manifest.importedAt,
    ...(manifest.updatedAt === undefined ? {} : { updatedAt: manifest.updatedAt }),
    ...(manifest.previousVault === undefined ? {} : { previousVault: manifest.previousVault }),
    files: Object.fromEntries(paths.map((path) => [path, manifest.files.get(path)!])),
  };
  return `${JSON.stringify(file)}\n`;
}
