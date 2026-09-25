/**
 * Copies the Obsidian vault byte for byte into the new vault, which is built in a hidden staging
 * folder next to the destination and renamed into place only once it's complete: the destination
 * never holds half an import, and a failed or cancelled one leaves nothing behind.
 */
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { PersistedImportFile } from "@ddl/contract";
import type { ImportSkipped } from "@ddl/core";
import { copyFileAtomic, UnreadableSourceError } from "./files";
import type { JobRun } from "./jobs";
import { BoundedList } from "./report-lists";
import { isSourceSidecar } from "./source-scan";
import { walkVault } from "./walk";

/** Files Finder may leave in a folder the user just created; the destination still counts as empty. */
const IGNORABLE = new Set([".DS_Store"]);

export interface SourceCopy {
  files: Map<string, PersistedImportFile>;
  copied: { files: number; bytes: number };
  skipped: BoundedList<ImportSkipped>;
}

/** The staging folder for `destination`, created empty. */
export async function createStaging(destination: string, jobId: string): Promise<string> {
  const staging = join(dirname(destination), `.${basename(destination)}.importing-${jobId}`);
  await mkdir(staging, { mode: 0o755 });
  return staging;
}

export async function copySource(
  source: string,
  staging: string,
  run: JobRun,
): Promise<SourceCopy> {
  const result: SourceCopy = {
    files: new Map(),
    copied: { files: 0, bytes: 0 },
    skipped: new BoundedList(),
  };
  const walk = walkVault(source, {
    signal: run.signal,
    prune: (path) => {
      if (!isSourceSidecar(path)) return false;
      result.skipped.add({ path, reason: "sidecar" });
      return true;
    },
  });
  for await (const entry of walk) {
    run.signal.throwIfAborted();
    if (entry.kind === "skipped") {
      result.skipped.add({ path: entry.path, reason: entry.reason });
    } else if (entry.kind === "folder") {
      await mkdir(join(staging, entry.path), { recursive: true });
    } else {
      try {
        const copy = await copyFileAtomic(entry.absolute, join(staging, entry.path), {
          signal: run.signal,
          onBytes: (bytes) => run.bytes(bytes),
        });
        result.files.set(entry.path, {
          sha256: copy.sha256,
          size: copy.size,
          mtimeMs: entry.mtimeMs,
        });
        result.copied.files++;
        result.copied.bytes += copy.size;
      } catch (error) {
        if (!(error instanceof UnreadableSourceError)) throw error;
        result.skipped.add({ path: entry.path, reason: error.reason });
      }
      run.file();
    }
  }
  return result;
}

/** Moves the finished staging folder to `destination` (which must still be absent or empty). */
export async function publish(staging: string, destination: string): Promise<void> {
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    const names = existing.isDirectory() ? await readdir(destination) : null;
    if (!names || names.some((name) => !IGNORABLE.has(name))) {
      throw new Error(`${destination} isn't empty any more`);
    }
    for (const name of names) await rm(join(destination, name), { force: true });
    await rmdir(destination);
  }
  await rename(staging, destination);
}

export async function removeStaging(staging: string): Promise<void> {
  await rm(staging, { recursive: true, force: true, maxRetries: 3 });
}
