import { ConflictError, type StorageProvider, type WriteOptions, type WriteResult } from "./types";

/**
 * Appends with the provider's own `append` when it has one; otherwise reads the file and writes it
 * back with the text added, conditionally, so a concurrent change fails with `ConflictError`
 * instead of being lost.
 */
export async function appendToFile(
  storage: StorageProvider,
  path: string,
  content: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  if (storage.append) return storage.append(path, content, options);
  const current = await storage.read(path);
  const version = current?.version ?? null;
  if (options.ifMatch !== undefined && options.ifMatch !== version) {
    throw new ConflictError(path, version);
  }
  return storage.write(path, (current?.content ?? "") + content, { ifMatch: version });
}
