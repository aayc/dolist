/**
 * Multi-file vault operations built from StorageProvider primitives. Deletes are soft: content is
 * moved into the vault's `.trash/` folder (Obsidian's "move to Obsidian trash"), so an accidental
 * delete — by the user or anything else writing through the daemon — is recoverable.
 */
import { extname, formatDate, joinPath } from "@ddl/core";
import { ConflictError, NotFoundError, type StorageProvider } from "@ddl/storage";

export const TRASH_DIR = ".trash";

export interface MovedFile {
  from: string;
  to: string;
  version: string;
}

/** A free path under `.trash/` for `path`, suffixed with a timestamp if taken. */
export async function trashTarget(
  storage: StorageProvider,
  path: string,
  isFolder: boolean,
  now = new Date(),
): Promise<string> {
  const target = joinPath(TRASH_DIR, path);
  const taken = isFolder
    ? (await storage.list({ prefix: target, includeHidden: true })).length > 0
    : (await storage.stat(target)) !== null;
  if (!taken) return target;
  const stamp = formatDate(now, "YYYY-MM-DD HHmmss");
  const ext = isFolder ? "" : extname(target);
  return `${target.slice(0, target.length - ext.length)} (${stamp})${ext}`;
}

export async function moveNoteToTrash(storage: StorageProvider, path: string): Promise<MovedFile> {
  const to = await trashTarget(storage, path, false);
  const result = await storage.rename(path, to);
  return { from: path, to: result.path, version: result.version };
}

export async function moveFolderToTrash(
  storage: StorageProvider,
  folder: string,
): Promise<MovedFile[]> {
  if (!(await folderExists(storage, folder))) throw new NotFoundError(folder);
  return moveFolder(storage, folder, await trashTarget(storage, folder, true));
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
  if (to === from || to.startsWith(`${from}/`)) {
    throw new ConflictError(to, null);
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

export async function folderExists(storage: StorageProvider, path: string): Promise<boolean> {
  const folders = await storage.listFolders({ prefix: path, includeHidden: true });
  return folders.includes(path);
}
