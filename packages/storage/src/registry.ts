import { MemoryStorageProvider } from "./memory";
import { NotImplementedError, type StorageConfig, type StorageProvider } from "./types";

/**
 * Provider registry: the single place that maps a config `kind` to an implementation.
 * Adding a backend = implement StorageProvider + add a case here.
 */
export async function createStorageProvider(config: StorageConfig): Promise<StorageProvider> {
  switch (config.kind) {
    case "memory":
      return new MemoryStorageProvider({
        ...(config.id ? { id: config.id } : {}),
        ...(config.initialFiles ? { initialFiles: config.initialFiles } : {}),
      });
    case "local":
      throw new NotImplementedError("local storage provider (in progress)");
    case "s3":
      throw new NotImplementedError("S3 storage provider");
  }
}
