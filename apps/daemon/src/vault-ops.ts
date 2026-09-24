/**
 * Multi-file vault operations built from StorageProvider primitives. Deletes are soft: content is
 * moved into the vault's `.trash/` folder (Obsidian's "move to Obsidian trash"), so an accidental
 * delete — by the user or anything else writing through the daemon — is recoverable.
 */
import { ancestorFolders, extname, formatDate, joinPath } from "@ddl/core";
import { ConflictError, NotFoundError, type StorageProvider } from "@ddl/storage";

export const TRASH_DIR = ".trash";
/** File systems cap a single name at 255 bytes (ext4) or 255 UTF-16 units (APFS); bytes fit both. */
const MAX_NAME_BYTES = 255;
const MAX_TRASH_ATTEMPTS = 100;

export interface MovedFile {
  from: string;
  to: string;
  version: string;
}

interface PlannedMove {
  from: string;
  to: string;
}

/**
 * The `attempt`-th candidate under `.trash/` for `path`: the same relative path, then suffixed with
 * a timestamp, then with the timestamp and a counter. Suffixed names are shortened to fit one name.
 */
export function trashCandidate(
  path: string,
  isFolder: boolean,
  now: Date,
  attempt: number,
): string {
  const target = joinPath(TRASH_DIR, path);
  if (attempt === 0) return target;
  const stamp = formatDate(now, "YYYY-MM-DD HHmmss");
  const suffix = attempt === 1 ? ` (${stamp})` : ` (${stamp} ${attempt})`;
  const ext = isFolder ? "" : extname(target);
  const slash = target.lastIndexOf("/");
  const stem = target.slice(slash + 1, target.length - ext.length);
  const budget = MAX_NAME_BYTES - utf8Length(suffix) - utf8Length(ext);
  return `${target.slice(0, slash + 1)}${truncateUtf8(stem, budget)}${suffix}${ext}`;
}

export async function moveNoteToTrash(
  storage: StorageProvider,
  path: string,
  now = new Date(),
): Promise<MovedFile> {
  for (let attempt = 0; attempt < MAX_TRASH_ATTEMPTS; attempt++) {
    const to = trashCandidate(path, false, now, attempt);
    if (await storage.stat(to)) continue;
    try {
      const result = await storage.rename(path, to);
      return { from: path, to: result.path, version: result.version };
    } catch (error) {
      // Taken by something `stat` does not report (a folder) or by a concurrent writer.
      if (!(error instanceof ConflictError)) throw error;
    }
  }
  throw new ConflictError(joinPath(TRASH_DIR, path), null);
}

export async function moveFolderToTrash(
  storage: StorageProvider,
  folder: string,
  now = new Date(),
): Promise<MovedFile[]> {
  if (!(await folderExists(storage, folder))) throw new NotFoundError(folder);
  for (let attempt = 0; attempt < MAX_TRASH_ATTEMPTS; attempt++) {
    const to = trashCandidate(folder, true, now, attempt);
    if ((await storage.list({ prefix: to, includeHidden: true })).length > 0) continue;
    let plan: PlannedMove[];
    try {
      // Providers may leave `.trash` out of listings (local-fs does), so this also checks every
      // destination file.
      plan = await planFolderMove(storage, folder, to);
    } catch (error) {
      if (error instanceof ConflictError) continue;
      throw error;
    }
    return executeFolderMove(storage, folder, to, plan);
  }
  throw new ConflictError(joinPath(TRASH_DIR, folder), null);
}

/**
 * Moves every file under `from` to the same relative path under `to`, then removes `from`.
 * Checks all destinations first so a conflict leaves the vault untouched.
 */
export async function moveFolder(
  storage: StorageProvider,
  from: string,
  to: string,
): Promise<MovedFile[]> {
  return executeFolderMove(storage, from, to, await planFolderMove(storage, from, to));
}

export async function folderExists(storage: StorageProvider, path: string): Promise<boolean> {
  const folders = await storage.listFolders({ prefix: path, includeHidden: true });
  return folders.includes(path);
}

/** Throws `ConflictError`, without side effects, when the move cannot be carried out. */
async function planFolderMove(
  storage: StorageProvider,
  from: string,
  to: string,
): Promise<PlannedMove[]> {
  // Compared case-insensitively: on macOS `projects/x` is inside `Projects`, and removing the
  // source afterwards would delete what was just moved there.
  const fromKey = from.toLowerCase();
  const toKey = to.toLowerCase();
  if (toKey.startsWith(`${fromKey}/`) || to === from) throw new ConflictError(to, null);
  // A case-only rename is a no-op on case-insensitive storage, which reports `to` as existing.
  if (toKey === fromKey && (await folderExists(storage, to))) throw new ConflictError(to, null);
  for (const path of [...ancestorFolders(to), to]) {
    const file = await storage.stat(path);
    if (file) throw new ConflictError(path, file.version);
  }
  const files = await storage.list({ prefix: from, includeHidden: true });
  const plan = files.map((file) => ({
    from: file.path,
    to: `${to}${file.path.slice(from.length)}`,
  }));
  for (const step of plan) {
    const existing = await storage.stat(step.to);
    if (existing) throw new ConflictError(step.to, existing.version);
  }
  return plan;
}

async function executeFolderMove(
  storage: StorageProvider,
  from: string,
  to: string,
  plan: readonly PlannedMove[],
): Promise<MovedFile[]> {
  const moved: MovedFile[] = [];
  for (const step of plan) {
    const result = await storage.rename(step.from, step.to);
    moved.push({ from: step.from, to: result.path, version: result.version });
  }
  await storage.createFolder(to);
  await storage.deleteFolder(from).catch((error: unknown) => {
    if (!(error instanceof NotFoundError)) throw error;
  });
  return moved;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const ch of value) {
    bytes += utf8Length(ch);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
