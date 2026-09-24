import type { Logger } from "@ddl/core";
import { LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import { S3StorageProvider } from "./s3";
import type { StorageConfig, StorageProvider, SyncTargetConfig } from "./types";

export interface ProviderDeps {
  logger?: Logger;
}

/**
 * Provider registry: the single place that maps a config `kind` to an implementation.
 * Adding a backend = implement StorageProvider + add a case here (and in `createSyncTarget`).
 */
export async function createStorageProvider(
  config: StorageConfig,
  deps: ProviderDeps = {},
): Promise<StorageProvider> {
  switch (config.kind) {
    case "memory":
      return new MemoryStorageProvider({
        ...(config.id ? { id: config.id } : {}),
        ...(config.initialFiles ? { initialFiles: config.initialFiles } : {}),
      });
    case "local":
      return openLocal(config.root, config.ignore, deps);
    case "s3":
      return new S3StorageProvider(config);
  }
}

/** The provider the vault syncs with, or null when sync is off. */
export async function createSyncTarget(
  config: SyncTargetConfig,
  deps: ProviderDeps = {},
): Promise<StorageProvider | null> {
  switch (config.kind) {
    case "none":
      return null;
    case "local":
      return openLocal(config.root, undefined, deps);
    case "s3":
      return new S3StorageProvider(config);
  }
}

async function openLocal(
  root: string,
  ignore: string[] | undefined,
  deps: ProviderDeps,
): Promise<LocalFsStorageProvider> {
  const provider = new LocalFsStorageProvider({
    root,
    ...(ignore ? { ignore } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  await provider.init();
  return provider;
}
