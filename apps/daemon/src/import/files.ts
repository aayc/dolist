/**
 * Byte-exact file copies and writes for importing. Every write goes to a temporary file in the
 * target's folder and is renamed over it, so a reader never sees half a file. Sources are opened
 * without following a symlink and without blocking (a FIFO swapped in after the walk can't hang
 * the import), and must still be regular files once open. Copies keep the source's times but
 * never its execute bits.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const CHUNK_BYTES = 256 * 1024;

export class NotAFileError extends Error {
  constructor() {
    super("Not a regular file");
    this.name = "NotAFileError";
  }
}

export interface CopyOptions {
  signal?: AbortSignal;
  /** Called with each chunk's size as it is copied. */
  onBytes?: (bytes: number) => void;
  /** fsync before the rename (files in a vault that's in use). */
  durable?: boolean;
}

export interface CopyResult {
  size: number;
  sha256: string;
}

/** Copies `from` to `to` (creating its folders), atomically, and hashes what was copied. */
export async function copyFileAtomic(
  from: string,
  to: string,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const source = await openRegularFile(from);
  try {
    const info = await source.stat();
    const hash = createHash("sha256");
    let size = 0;
    await writeAtomic(
      to,
      async (target) => {
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        for (;;) {
          options.signal?.throwIfAborted();
          const { bytesRead } = await source.read(buffer, 0, CHUNK_BYTES, null);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          await target.write(chunk);
          size += bytesRead;
          options.onBytes?.(bytesRead);
        }
      },
      { mode: info.mode & 0o666, times: [info.atime, info.mtime], durable: options.durable },
    );
    return { size, sha256: hash.digest("hex") };
  } finally {
    await source.close();
  }
}

/** Writes `data` to `path` (creating its folders), atomically. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { durable?: boolean } = {},
): Promise<void> {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  await writeAtomic(
    path,
    async (target) => {
      await target.write(bytes);
    },
    { mode: 0o644, durable: options.durable },
  );
}

/** SHA-256 of a regular file's bytes. */
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const file = await openRegularFile(path);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A regular file's bytes, refusing symlinks, special files and anything over `maxBytes`. */
export async function readRegularFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let file: FileHandle;
  try {
    file = await openRegularFile(path);
  } catch {
    return null;
  }
  try {
    const { size } = await file.stat();
    if (size > maxBytes) return null;
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function openRegularFile(path: string): Promise<FileHandle> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  const info = await file.stat().catch(() => null);
  if (!info?.isFile()) {
    await file.close();
    throw new NotAFileError();
  }
  return file;
}

async function writeAtomic(
  path: string,
  fill: (target: FileHandle) => Promise<void>,
  options: { mode: number; times?: [Date, Date]; durable?: boolean | undefined },
): Promise<void> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString("hex")}.ddl-tmp`);
  const target = await open(temp, "wx", options.mode);
  try {
    try {
      await fill(target);
      if (options.durable) await target.sync();
    } finally {
      await target.close();
    }
    if (options.times) await utimes(temp, options.times[0], options.times[1]);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
