import { MemoryStorageProvider } from "@ddl/storage";

export { recordingLogger } from "@ddl/core";
export { readFixture } from "../../../contract/test/persisted/fixtures";

/** Fixed clock for quarantine names: 2026-09-23T12:00:00.000Z. */
export const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
export const STAMP = "20260923T120000000Z";

export function vault(files: Record<string, string> = {}): MemoryStorageProvider {
  return new MemoryStorageProvider({ initialFiles: files, now: () => NOW });
}

/** Every sidecar file with its content, for exact assertions. */
export async function sidecar(storage: MemoryStorageProvider): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await storage.list({ prefix: ".daily-do-list", includeHidden: true })) {
    out[entry.path] = (await storage.read(entry.path))!.content;
  }
  return out;
}

export async function paths(storage: MemoryStorageProvider, prefix = ".daily-do-list") {
  return (await storage.list({ prefix, includeHidden: true })).map((entry) => entry.path);
}
