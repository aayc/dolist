import { join } from "node:path";
import {
  decodePersistedImportManifest,
  encodePersistedImportManifest,
  PERSISTED_PATHS,
  type PersistedImportManifest,
} from "@ddl/contract";
import { readRegularFile, writeFileAtomic } from "./files";

/** Vault path of the manifest (`.daily-do-list/import/obsidian.json`). */
export const MANIFEST_PATH = PERSISTED_PATHS.importManifest;

const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

export type ManifestRead =
  | { status: "loaded"; manifest: PersistedImportManifest }
  | { status: "missing" }
  | { status: "unusable"; reason: string };

export async function readManifest(vault: string): Promise<ManifestRead> {
  const bytes = await readRegularFile(join(vault, MANIFEST_PATH), MAX_MANIFEST_BYTES);
  if (!bytes) return { status: "missing" };
  const decoded = decodePersistedImportManifest(bytes.toString("utf8"));
  if (decoded.ok) return { status: "loaded", manifest: decoded.value };
  return {
    status: "unusable",
    reason:
      decoded.kind === "newer"
        ? "it was written by a newer version of Daily Do List"
        : `it can't be read (${decoded.reason})`,
  };
}

export async function writeManifest(
  vault: string,
  manifest: PersistedImportManifest,
  options: { durable?: boolean } = {},
): Promise<void> {
  await writeFileAtomic(
    join(vault, MANIFEST_PATH),
    encodePersistedImportManifest(manifest),
    options,
  );
}
