import { constants, type Stats } from "node:fs";
import { type FileHandle, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTempFileName } from "../ignore-rules";
import { errorCode, isMissingError } from "./fs-errors";

/**
 * Writes `content` to a temp file in the target's folder, flushes it, then renames it over the
 * target, so readers (and a crash) only ever see the old or the new content. Returns the stats of
 * the written file (rename preserves mtime and size). `mode` preserves an existing file's
 * permissions.
 */
export async function writeFileAtomic(
  target: string,
  content: string,
  mode?: number,
): Promise<Stats> {
  const temp = join(dirname(target), createTempFileName());
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "wx", 0o666);
    await handle.writeFile(content, "utf8");
    if (mode !== undefined) await handle.chmod(mode);
    await handle.datasync();
    const stats = await handle.stat();
    await handle.close();
    handle = undefined;
    await rename(temp, target);
    return stats;
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export interface LoadedTextFile {
  content: string;
  stats: Stats;
}

/**
 * Reads a regular file as UTF-8 together with the stats of the same open file, so the pair is
 * consistent even if an atomic writer replaces the file meanwhile. Returns null when it is gone.
 */
export async function readTextFile(path: string): Promise<LoadedTextFile | null> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK: never hang on a FIFO that slipped past the caller's isFile() check.
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (isMissingError(error) || errorCode(error) === "EISDIR") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    return { content: await handle.readFile("utf8"), stats };
  } finally {
    await handle.close();
  }
}
