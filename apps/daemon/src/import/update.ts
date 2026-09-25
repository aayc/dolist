/**
 * "Update from Obsidian": copies what changed in the Obsidian vault since the manifest into the
 * vault it was imported into, and never deletes anything.
 *
 * - Changed there, unchanged here (still what the import or the last update wrote): replaced.
 * - Changed on both sides: kept here, and the Obsidian version saved next to it as
 *   `Name (Obsidian).md`. A daily note merged at import counts as changed here.
 * - New there: copied; if this vault has a different file at that path, as a conflict copy.
 * - Changed there after being deleted here: written back. Deleted there: kept here.
 *
 * A file whose size and mtime match the manifest is taken as unchanged without reading it. Writes
 * are atomic and synced (the vault is in use), and never go through a link leading out of it.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PersistedImportFile, PersistedImportManifest } from "@ddl/contract";
import type { ImportMove, ImportSkipped, ObsidianUpdateReport } from "@ddl/core";
import { copyFileAtomic, hashFile, UnreadableSourceError } from "./files";
import type { JobRun } from "./jobs";
import { writeManifest } from "./manifest";
import { pathKey, withLabel } from "./places";
import { BoundedList, moveList, pathList, skippedList } from "./report-lists";
import { isSourceSidecar } from "./source-scan";
import { isInside, walkVault } from "./walk";

export const CONFLICT_LABEL = "Obsidian";

export interface UpdateInput {
  /** The vault being updated (real path). */
  vault: string;
  manifest: PersistedImportManifest;
  /** The Obsidian vault (real path, checked like an import's source). */
  source: string;
  run: JobRun;
  now: number;
}

interface Candidate {
  path: string;
  absolute: string;
  size: number;
  mtimeMs: number;
  entry: PersistedImportFile | undefined;
}

type Local = { kind: "missing" } | { kind: "file"; sha256: string } | { kind: "other" };

export async function updateFromSource(input: UpdateInput): Promise<ObsidianUpdateReport> {
  const { vault, manifest, source, run } = input;
  const added = new BoundedList<string>();
  const updated = new BoundedList<string>();
  const restored = new BoundedList<string>();
  const conflicts = new BoundedList<ImportMove>();
  const deletedInSource = new BoundedList<string>();
  const skipped = new BoundedList<ImportSkipped>();
  const files = new Map(manifest.files);
  const reserved = new Set<string>();
  const seen = new Set<string>();
  let unchanged = 0;

  const candidates: Candidate[] = [];
  const walk = walkVault(source, {
    signal: run.signal,
    prune: (path) => {
      if (!isSourceSidecar(path)) return false;
      skipped.add({ path, reason: "sidecar" });
      return true;
    },
  });
  for await (const entry of walk) {
    if (entry.kind === "skipped") skipped.add({ path: entry.path, reason: entry.reason });
    if (entry.kind !== "file") continue;
    seen.add(entry.path);
    const known = manifest.files.get(entry.path);
    if (known && known.size === entry.size && known.mtimeMs === entry.mtimeMs) {
      unchanged++;
      continue;
    }
    candidates.push({ ...entry, entry: known });
  }
  run.totals(
    candidates.length,
    candidates.reduce((sum, candidate) => sum + candidate.size, 0),
  );

  run.phase("copying");
  for (const candidate of candidates) {
    run.signal.throwIfAborted();
    const { path, entry } = candidate;
    const seenNow = { size: candidate.size, mtimeMs: candidate.mtimeMs };
    let sha256: string;
    try {
      sha256 = await hashFile(candidate.absolute, run.signal);
    } catch (error) {
      if (run.signal.aborted) throw error;
      skipped.add({ path, reason: "unreadable" });
      run.file();
      continue;
    }
    if (entry?.sha256 === sha256) {
      files.set(path, { ...entry, ...seenNow });
      unchanged++;
      run.file();
      continue;
    }
    if (!(await staysInside(vault, path))) {
      skipped.add({ path, reason: "symlink_outside" });
      run.file();
      continue;
    }
    const local = await localState(join(vault, path), run.signal);
    const baseline = entry ? (entry.base ?? entry.sha256) : null;
    const copy = async (to: string) => {
      await copyFileAtomic(candidate.absolute, join(vault, to), {
        signal: run.signal,
        onBytes: (bytes) => run.bytes(bytes),
        durable: true,
      });
    };
    try {
      if (local.kind === "missing") {
        await copy(path);
        (entry ? restored : added).add(path);
        files.set(path, { sha256, ...seenNow });
      } else if (local.kind === "file" && local.sha256 === sha256) {
        files.set(path, { sha256, ...seenNow });
        unchanged++;
      } else if (local.kind === "file" && local.sha256 === baseline) {
        await copy(path);
        updated.add(path);
        files.set(path, { sha256, ...seenNow });
      } else {
        const to = await conflictName(vault, path, reserved);
        await copy(to);
        conflicts.add({ from: path, to });
        files.set(path, { sha256, ...seenNow, ...(baseline ? { base: baseline } : {}) });
      }
    } catch (error) {
      if (!(error instanceof UnreadableSourceError)) throw error;
      skipped.add({ path, reason: error.reason });
    }
    run.file();
  }

  for (const path of manifest.files.keys()) {
    if (!seen.has(path)) deletedInSource.add(path);
  }
  run.phase("finishing");
  await writeManifest(vault, { ...manifest, updatedAt: input.now, files }, { durable: true });
  return {
    added: pathList(added),
    updated: pathList(updated),
    restored: pathList(restored),
    conflicts: moveList(conflicts),
    deletedInSource: pathList(deletedInSource),
    unchanged,
    skipped: skippedList(skipped),
  };
}

async function localState(absolute: string, signal: AbortSignal): Promise<Local> {
  const info = await lstat(absolute).catch(() => null);
  if (!info) return { kind: "missing" };
  if (!info.isFile()) return { kind: "other" };
  try {
    return { kind: "file", sha256: await hashFile(absolute, signal) };
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "other" };
  }
}

/** The nearest existing folder above `path` in the vault is really inside it. */
async function staysInside(vault: string, path: string): Promise<boolean> {
  let folder = dirname(join(vault, path));
  for (;;) {
    const real = await realpath(folder).catch(() => null);
    if (real !== null) return isInside(real, vault);
    const parent = dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
}

async function conflictName(vault: string, path: string, reserved: Set<string>): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = withLabel(path, CONFLICT_LABEL, n);
    const key = pathKey(candidate);
    if (reserved.has(key)) continue;
    if (await lstat(join(vault, candidate)).catch(() => null)) continue;
    reserved.add(key);
    return candidate;
  }
}
