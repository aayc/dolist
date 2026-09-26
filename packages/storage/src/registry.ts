import type { Logger } from "@ddl/core";
import { type LocalFsStorageOptions, LocalFsStorageProvider } from "./local-fs";
import { MemoryStorageProvider } from "./memory";
import { RemoteStorageProvider } from "./remote";
import type { StorageConfig, StorageProvider, SyncTargetConfig } from "./types";

export interface ProviderDeps {
  logger?: Logger;
  /** The sync service only: the agent lease epoch this device holds (see `RemoteStorageOptions`). */
  leaseEpoch?: () => number | null;
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
      return openLocal(config, deps);
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
      return openLocal({ root: config.root }, deps);
    case "remote": {
      const { kind: _kind, ...options } = config;
      return new RemoteStorageProvider({
        ...options,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(deps.leaseEpoch ? { leaseEpoch: deps.leaseEpoch } : {}),
      });
    }
  }
}

async function openLocal(
  options: LocalFsStorageOptions,
  deps: ProviderDeps,
): Promise<LocalFsStorageProvider> {
  const provider = new LocalFsStorageProvider({
    ...options,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  await provider.init();
  return provider;
}
