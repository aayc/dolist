/**
 * The vault's sync engine and its target, replaceable while the daemon runs: `configure` stops the
 * current engine, disposes its target, prepares the new setup (loading the token) and starts it.
 */
import { type Logger, type SyncStatusResponse, type Unsubscribe, withTimeout } from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { DaemonSyncConfig } from "./config";
import { errorMessage } from "./errors";
import { disabledSyncStatusResponse, toSyncStatusResponse } from "./routes/sync";
import { type DeviceIdentity, type PreparedSync, prepareSync } from "./sync-setup";
import { createSync, type SyncHandle } from "./wiring";

/** A sync pass run around agent handovers (before starting, after stopping) is bounded by this. */
const HANDOVER_SYNC_TIMEOUT_MS = 15_000;

export interface SyncControllerOptions {
  /** The vault as the engine sees it (attributed so its writes are tagged `sync`). */
  primary: StorageProvider;
  device: DeviceIdentity;
  syncTokenPath: string;
  env: Record<string, string | undefined>;
  /** The agent lease epoch this device holds, or null: fences the agent's files. */
  leaseEpoch?: () => number | null;
  logger: Logger;
  /** Sync's wait for local changes to settle (`SyncStartOptions.debounceMs`). */
  debounceMs?: number;
}

export class SyncController {
  readonly #options: SyncControllerOptions;
  #prepared: PreparedSync = { target: { kind: "none" } };
  #handle: SyncHandle | null = null;
  #unsubscribe: Unsubscribe | undefined;

  constructor(options: SyncControllerOptions) {
    this.#options = options;
  }

  /** The current setup: the sync service's client and this device, when syncing with it. */
  get remote(): PreparedSync["remote"] {
    return this.#prepared.remote;
  }

  get handle(): SyncHandle | null {
    return this.#handle;
  }

  /** Replaces the running sync (if any) with `sync`, and starts it. */
  async configure(sync: DaemonSyncConfig): Promise<void> {
    await this.stop();
    const { primary, device, syncTokenPath, env, logger } = this.#options;
    const log = logger.child({ component: "sync" });
    this.#prepared = await prepareSync({ sync, syncTokenPath, device, env, logger: log });
    const target = this.#prepared.target;
    const { leaseEpoch, debounceMs } = this.#options;
    this.#handle = target
      ? await createSync({ target, primary, logger, ...(leaseEpoch ? { leaseEpoch } : {}) })
      : null;
    if (this.#handle) {
      this.#unsubscribe = this.#handle.engine.onStatus((status) => {
        if (status.state === "error") log.warn("Sync failed", { error: status.lastError });
        else log.debug("Sync status", { state: status.state });
      });
      this.#handle.engine.start(debounceMs === undefined ? {} : { debounceMs });
    }
  }

  /** Stops the engine (after its current pass) and disposes the target. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    const handle = this.#handle;
    this.#handle = null;
    this.#prepared = { target: { kind: "none" } };
    if (!handle) return;
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        this.#options.logger.warn(`Stopping sync failed: ${name}`, { error: errorMessage(error) });
      }
    };
    await step("engine", () => handle.engine.stop());
    await step("target", () => handle.target.dispose());
  }

  /** One sync pass, best effort and bounded (agent handovers wait for it). */
  async syncPass(): Promise<void> {
    const handle = this.#handle;
    if (!handle) return;
    try {
      await withTimeout(handle.engine.syncOnce(), HANDOVER_SYNC_TIMEOUT_MS, "Sync pass timed out");
    } catch (error) {
      this.#options.logger.warn("Sync pass around the agent handover failed", {
        error: errorMessage(error),
      });
    }
  }

  status(): SyncStatusResponse {
    const remote = this.#prepared.remote
      ? { host: this.#prepared.remote.host, deviceName: this.#prepared.remote.device.name }
      : undefined;
    if (this.#handle) return toSyncStatusResponse(this.#handle.engine.status(), remote);
    if (!remote) return disabledSyncStatusResponse();
    return {
      state: "error",
      target: "remote",
      lastSyncedAt: null,
      pendingChanges: 0,
      conflicts: [],
      ...(this.#prepared.remote?.problem ? { lastError: this.#prepared.remote.problem } : {}),
      remoteHost: remote.host,
      deviceName: remote.deviceName,
    };
  }
}
