/**
 * Decides whether this daemon runs the agent, and follows changes to that while it runs:
 * - without the sync service (or with the agent off) it runs its own agent, as a standalone device;
 * - with the sync service it runs the agent only while it holds the vault's agent lease;
 * - with the sync service set up but unusable (no token) it doesn't run it at all.
 * Sync changes (`applySync`) stop the current arrangement cleanly first: a held lease is released
 * after the agent stopped and its state was synced.
 */
import type { AgentMode, Logger } from "@ddl/core";
import {
  AgentLease,
  agentLeaseClient,
  LEASE_CHECKING_PROBLEM,
  type LeaseTimings,
} from "./agent-lease";
import type { DaemonSyncConfig } from "./config";
import type { LeasedAgentRuntime } from "./leased-runtime";
import type { SyncController } from "./sync-controller";
import type { DeviceIdentity } from "./sync-setup";

export interface AgentSupervisorOptions {
  runtime: LeasedAgentRuntime;
  sync: SyncController;
  device: DeviceIdentity;
  agentMode: AgentMode;
  leaseTimings?: Partial<LeaseTimings>;
  logger: Logger;
}

type Arrangement =
  | { kind: "idle" }
  | { kind: "standalone" }
  | { kind: "unavailable"; problem: string }
  | { kind: "lease"; lease: AgentLease };

export class AgentSupervisor {
  readonly #options: AgentSupervisorOptions;
  #arrangement: Arrangement = { kind: "idle" };
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AgentSupervisorOptions) {
    this.#options = options;
  }

  /** The lease this daemon keeps while syncing with the sync service. */
  get lease(): AgentLease | undefined {
    return this.#arrangement.kind === "lease" ? this.#arrangement.lease : undefined;
  }

  /** Sets up the agent for the current sync. */
  start(): Promise<void> {
    return this.#serialized(() => this.#arrange());
  }

  /** Stops the current arrangement, switches sync to `sync`, and sets the agent up again. */
  applySync(sync: DaemonSyncConfig): Promise<void> {
    return this.#serialized(async () => {
      await this.#leave();
      await this.#options.sync.configure(sync);
      await this.#arrange();
    });
  }

  /** Releases the lease (after the agent stopped and synced) and stops following changes. */
  stop(): Promise<void> {
    this.#stopped = true;
    return this.#serialized(() => this.#leave("The daemon is shutting down."));
  }

  async #arrange(): Promise<void> {
    if (this.#stopped) return;
    const { runtime, sync, agentMode } = this.#options;
    const remote = sync.remote;
    if (!remote || agentMode === "off") {
      this.#arrangement = { kind: "standalone" };
      await runtime.activate();
      return;
    }
    if (!remote.client) {
      const problem = remote.problem ?? "Sync with the sync server can't start.";
      this.#arrangement = { kind: "unavailable", problem };
      await runtime.deactivate(problem);
      return;
    }
    await runtime.deactivate(LEASE_CHECKING_PROBLEM);
    const lease = new AgentLease({
      client: agentLeaseClient(remote.client),
      device: this.#options.device,
      ...(this.#options.leaseTimings ? { timings: this.#options.leaseTimings } : {}),
      // Pull what the previous device's agent wrote before loading it.
      onAcquired: async () => {
        await sync.syncPass();
        await runtime.activate();
      },
      // Push the stopped agent's last state for whichever device takes over.
      onUnavailable: async (problem) => {
        const wasRunning = runtime.active;
        await runtime.deactivate(problem);
        if (wasRunning) void sync.syncPass();
      },
      logger: this.#options.logger.child({ component: "lease" }),
    });
    this.#arrangement = { kind: "lease", lease };
    lease.start();
  }

  /** Ends the current arrangement: the agent stops and a held lease is released after a sync. */
  async #leave(problem = LEASE_CHECKING_PROBLEM): Promise<void> {
    const { runtime, sync } = this.#options;
    const current = this.#arrangement;
    this.#arrangement = { kind: "idle" };
    if (current.kind === "lease") {
      await current.lease.stop(async () => {
        await runtime.deactivate(problem);
        await sync.syncPass();
      });
    }
    await runtime.deactivate(problem);
  }

  #serialized(step: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(step);
    this.#queue = run.catch((error: unknown) => {
      this.#options.logger.error("Setting up the agent failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return run;
  }
}
