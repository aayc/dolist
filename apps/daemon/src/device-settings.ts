/**
 * This daemon's device-local settings (`GET`/`PATCH /api/device`, `PUT`/`DELETE /api/device/sync`):
 * its name (`device.json`), where its agent runs and the names it answers to (`config.json`
 * `agent.placement` and `remote.hosts`), and its link to the sync service (`config.json` `sync`,
 * the vault token in `sync-token`). None of it syncs. Fields set by environment variables can't be
 * changed here (409 `locked_by_env`). The sync token is written, never returned or logged.
 */
import {
  type AgentPlacement,
  type DeviceSettingsPatch,
  type DeviceSettingsResponse,
  type DeviceSyncSetupRequest,
  type Logger,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import {
  type DaemonConfig,
  type DaemonSyncConfig,
  type EnvLockedField,
  validRemoteSync,
} from "./config";
import { ApiError } from "./errors";
import {
  atomicWriteFile,
  type JsonObjectFile,
  jsonObjectFile,
  memoryJsonObjectFile,
  memorySecretFile,
  type SecretFile,
  secretFile,
} from "./home-files";
import { createRemoteHosts, type RemoteHosts } from "./remote-hosts";
import { type DeviceIdentity, isValidSyncToken } from "./sync-setup";

export interface DeviceSettingsFiles {
  /** `$DDL_HOME/config.json`, edited in place. */
  config: JsonObjectFile;
  /** Writes `$DDL_HOME/device.json`. */
  saveDevice(device: DeviceIdentity): Promise<void>;
  /** `$DDL_HOME/sync-token`. */
  syncToken: SecretFile;
}

export function deviceSettingsFiles(
  config: Pick<DaemonConfig, "configPath" | "devicePath" | "syncTokenPath">,
): DeviceSettingsFiles {
  return {
    config: jsonObjectFile(config.configPath),
    saveDevice: (device) =>
      atomicWriteFile(
        config.devicePath,
        `${JSON.stringify({ id: device.id, name: device.name }, null, 2)}\n`,
      ),
    syncToken: secretFile(config.syncTokenPath),
  };
}

export interface DeviceSettingsOptions {
  device: DeviceIdentity;
  placement: AgentPlacement;
  sync: DaemonSyncConfig;
  lockedByEnv: readonly EnvLockedField[];
  remoteHosts: RemoteHosts;
  files: DeviceSettingsFiles;
  /** A vault token is available (the file, or `DDL_SYNC_TOKEN`). */
  hasToken: boolean;
  /** Puts a new sync setup into effect (the old engine and lease stop first). */
  applySync?(sync: DaemonSyncConfig): Promise<void>;
  logger: Logger;
}

const LOCKED_MESSAGES: Record<EnvLockedField, string> = {
  placement: "DDL_AGENT_PLACEMENT sets where the agent runs on this device",
  remoteHosts: "DDL_REMOTE_HOSTS sets the names this daemon answers to",
  sync: "DDL_SYNC_URL, DDL_SYNC_VAULT or DDL_SYNC_TOKEN set the sync setup of this device",
};

export class DeviceSettings {
  /** The same object for the daemon's lifetime: its `name` follows renames. */
  readonly device: DeviceIdentity;
  readonly #options: DeviceSettingsOptions;
  readonly #placementListeners = new Set<(placement: AgentPlacement) => void>();
  #placement: AgentPlacement;
  #sync: DaemonSyncConfig;
  #hasToken: boolean;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeviceSettingsOptions) {
    this.#options = options;
    this.device = { ...options.device };
    this.#placement = options.placement;
    this.#sync = options.sync;
    this.#hasToken = options.hasToken;
  }

  get placement(): AgentPlacement {
    return this.#placement;
  }

  get sync(): DaemonSyncConfig {
    return this.#sync;
  }

  get lockedByEnv(): readonly EnvLockedField[] {
    return this.#options.lockedByEnv;
  }

  response(): DeviceSettingsResponse {
    const remote = this.#sync.kind === "remote" ? this.#sync : null;
    return {
      device: { id: this.device.id, name: this.device.name },
      placement: this.#placement,
      remoteHosts: [...this.#options.remoteHosts.list()],
      sync: { url: remote?.url ?? null, vault: remote?.vault ?? null, hasToken: this.#hasToken },
      lockedByEnv: [...this.#options.lockedByEnv],
    };
  }

  /** Called with the new stored placement after it changed. */
  onPlacementChange(listener: (placement: AgentPlacement) => void): Unsubscribe {
    this.#placementListeners.add(listener);
    return () => {
      this.#placementListeners.delete(listener);
    };
  }

  /** Changes the name, placement or remote hosts (already validated by the route). */
  patch(patch: DeviceSettingsPatch): Promise<DeviceSettingsResponse> {
    return this.#serialized(async () => {
      if (patch.placement !== undefined) this.#assertUnlocked("placement");
      if (patch.remoteHosts !== undefined) this.#assertUnlocked("remoteHosts");
      const { placement, remoteHosts, name } = patch;
      if (placement !== undefined || remoteHosts !== undefined) {
        await this.#options.files.config.update((config) => {
          if (placement !== undefined) config.agent = { ...record(config.agent), placement };
          if (remoteHosts !== undefined) {
            config.remote = { ...record(config.remote), hosts: remoteHosts };
          }
        });
      }
      if (name !== undefined && name !== this.device.name) {
        await this.#options.files.saveDevice({ id: this.device.id, name });
        this.device.name = name;
        this.#options.logger.info("Renamed this device");
      }
      if (remoteHosts !== undefined) this.#options.remoteHosts.set(remoteHosts);
      if (placement !== undefined && placement !== this.#placement) {
        this.#placement = placement;
        this.#options.logger.info("Changed where the agent runs", { placement });
        for (const listener of [...this.#placementListeners]) listener(placement);
      }
      return this.response();
    });
  }

  /** Points this device at the sync service and puts it into effect. */
  setupSync(request: DeviceSyncSetupRequest): Promise<DeviceSettingsResponse> {
    return this.#serialized(async () => {
      this.#assertUnlocked("sync");
      const sync = validRemoteSync(request.url, request.vault);
      if (!sync.ok) throw new ApiError(400, "invalid_request", sync.message);
      if (request.token !== undefined && !isValidSyncToken(request.token)) {
        throw new ApiError(400, "invalid_request", "token must be one line without spaces");
      }
      if (request.token === undefined && !this.#hasToken) {
        throw new ApiError(400, "invalid_request", "No vault token is saved yet: include `token`");
      }
      if (request.token !== undefined) {
        await this.#options.files.syncToken.write(request.token);
        this.#hasToken = true;
      }
      await this.#options.files.config.update((config) => {
        config.sync = sync.config;
      });
      this.#sync = sync.config;
      this.#options.logger.info("Sync with the sync service set up", {
        host: new URL(sync.config.url).host,
      });
      await this.#options.applySync?.(sync.config);
      return this.response();
    });
  }

  /** Stops syncing with the sync service and deletes the saved token. */
  removeSync(): Promise<DeviceSettingsResponse> {
    return this.#serialized(async () => {
      this.#assertUnlocked("sync");
      const wasRemote = this.#sync.kind === "remote";
      if (wasRemote) {
        await this.#options.files.config.update((config) => {
          delete config.sync;
        });
        this.#sync = { kind: "none" };
      }
      await this.#options.files.syncToken.remove();
      this.#hasToken = false;
      if (wasRemote) {
        this.#options.logger.info("Sync with the sync service turned off");
        await this.#options.applySync?.(this.#sync);
      }
      return this.response();
    });
  }

  #assertUnlocked(field: EnvLockedField): void {
    if (this.#options.lockedByEnv.includes(field)) {
      throw new ApiError(409, "locked_by_env", `${LOCKED_MESSAGES[field]}; change it there`);
    }
  }

  #serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(step);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

/** Device settings kept in memory (tests, and apps built without a home folder). */
export function memoryDeviceSettings(
  overrides: Partial<DeviceSettingsOptions> = {},
): DeviceSettings {
  return new DeviceSettings({
    device: { id: "dev_this_device", name: "This device" },
    placement: "this_device",
    sync: { kind: "none" },
    lockedByEnv: [],
    remoteHosts: createRemoteHosts(),
    files: {
      config: memoryJsonObjectFile(),
      saveDevice: async () => {},
      syncToken: memorySecretFile(),
    },
    hasToken: false,
    logger: silentLogger,
    ...overrides,
  });
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
