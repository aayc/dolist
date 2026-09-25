/**
 * Decides whether this daemon runs the agent, and follows changes to that while it runs:
 * - without the sync service (or with the agent off) it runs its own agent, as a standalone device;
 * - with the sync service set up but unusable (no token) it doesn't run it at all;
 * - otherwise the device's placement applies: `this_device` asks for the agent lease with priority
 *   `interactive`, `always_on_host` with priority `host`, and `always_on_machine` never asks (it
 *   only watches who holds the lease). Without an always-on machine in the vault's settings, or
 *   without sync, the agent is held on this device (`this_device`) whatever is stored.
 * Changes (sync, placement, the vault's always-on machine) stop the current arrangement cleanly
 * first: a held lease is released after the agent stopped and its state was synced. A change of
 * priority alone keeps the lease and applies on the next request.
 */
import type {
  AgentMode,
  AgentPlacement,
  AgentPlacementStatus,
  AgentRunsOn,
  AlwaysOnMachine,
  AppSettings,
  Logger,
  RelayState,
  SyncLeaseHolder,
  SyncLeasePriority,
  Unsubscribe,
} from "@ddl/core";
import {
  AgentLease,
  agentLeaseClient,
  LEASE_CHECKING_PROBLEM,
  type LeaseTimings,
  LeaseWatcher,
} from "./agent-lease";
import type { MachineCredentialSource, PlacementSnapshot, PlacementSource } from "./agent-location";
import type { DaemonSyncConfig } from "./config";
import { errorMessage } from "./errors";
import type { LeasedAgentRuntime } from "./leased-runtime";
import type { SyncController } from "./sync-controller";
import type { DeviceIdentity } from "./sync-setup";

/** How long "Handing the agent to <machine>…" shows at most while the machine picks it up. */
const HANDING_OVER_NOTE_MS = 60_000;

export interface AgentSupervisorOptions {
  runtime: LeasedAgentRuntime;
  sync: SyncController;
  device: DeviceIdentity;
  agentMode: AgentMode;
  /** The stored placement (device-local, `DeviceSettings`). */
  placement: {
    readonly placement: AgentPlacement;
    onPlacementChange(listener: (placement: AgentPlacement) => void): Unsubscribe;
  };
  /** The vault's settings, for `remote.alwaysOnMachine`. */
  settings: {
    get(): AppSettings;
    onChange(listener: (settings: AppSettings) => void): Unsubscribe;
  };
  /** This device's credential for the always-on machine (for the relay state). */
  credential?: MachineCredentialSource;
  leaseTimings?: Partial<LeaseTimings>;
  logger: Logger;
  now?: () => number;
}

type Arrangement =
  | { kind: "idle" }
  | { kind: "standalone" }
  | { kind: "unavailable"; problem: string }
  | { kind: "lease"; lease: AgentLease }
  | { kind: "relayed"; watcher: LeaseWatcher; problem: string };

type Desired =
  | { kind: "standalone" }
  | { kind: "unavailable"; problem: string }
  | { kind: "lease"; priority: SyncLeasePriority }
  | { kind: "relayed" };

/** The placement that applies, and why the stored one doesn't when it doesn't. */
export function effectivePlacement(
  stored: AgentPlacement,
  context: { syncing: boolean; machine: AlwaysOnMachine | null },
): { effective: AgentPlacement; heldHere?: "no_machine" | "no_sync" } {
  if (!context.syncing) return { effective: "this_device", heldHere: "no_sync" };
  if (!context.machine) return { effective: "this_device", heldHere: "no_machine" };
  return { effective: stored };
}

export class AgentSupervisor implements PlacementSource {
  readonly #options: AgentSupervisorOptions;
  readonly #now: () => number;
  readonly #listeners = new Set<(snapshot: PlacementSnapshot) => void>();
  readonly #unsubscribes: Unsubscribe[] = [];
  #arrangement: Arrangement = { kind: "idle" };
  #relay: RelayState | null = null;
  #handingTo: { name: string; until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  #machineKey: string;
  #lastKey = "";
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AgentSupervisorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#machineKey = JSON.stringify(this.#machine());
  }

  /** The lease this daemon keeps while it asks for the agent. */
  get lease(): AgentLease | undefined {
    return this.#arrangement.kind === "lease" ? this.#arrangement.lease : undefined;
  }

  /** Sets up the agent for the current sync and placement, and follows their changes. */
  start(): Promise<void> {
    const { placement, settings, credential } = this.#options;
    this.#unsubscribes.push(
      placement.onPlacementChange(() => void this.#serialized(() => this.#reconcile())),
      settings.onChange(() => {
        const key = JSON.stringify(this.#machine());
        if (key === this.#machineKey) return;
        this.#machineKey = key;
        void this.#serialized(() => this.#reconcile());
      }),
    );
    if (credential) this.#unsubscribes.push(credential.onChange(() => this.#changed()));
    return this.#serialized(() => this.#reconcile());
  }

  /** Stops the current arrangement, switches sync to `sync`, and sets the agent up again. */
  applySync(sync: DaemonSyncConfig): Promise<void> {
    return this.#serialized(async () => {
      await this.#leave();
      await this.#options.sync.configure(sync);
      await this.#reconcile();
    });
  }

  /** Releases the lease (after the agent stopped and synced) and stops following changes. */
  stop(): Promise<void> {
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearHandingTo();
    return this.#serialized(() => this.#leave("The daemon is shutting down."));
  }

  current(): PlacementSnapshot {
    const stored = this.#options.placement.placement;
    const { effective, heldHere } = this.#effective();
    return {
      placement: stored,
      effective,
      ...(heldHere ? { heldHere } : {}),
      runsOn: this.#runsOn(),
    };
  }

  status(): AgentPlacementStatus {
    const { placement, heldHere, runsOn } = this.current();
    const note = this.#note();
    return {
      placement,
      ...(heldHere ? { heldHere } : {}),
      runsOn,
      relay: this.#relayState(),
      ...(note ? { note } : {}),
    };
  }

  onChange(listener: (snapshot: PlacementSnapshot) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setRelay(state: RelayState | null): void {
    this.#relay = state;
    this.#changed();
  }

  // ── Arrangements ─────────────────────────────────────────────────────────

  #machine(): AlwaysOnMachine | null {
    return this.#options.settings.get().remote.alwaysOnMachine;
  }

  #effective(): ReturnType<typeof effectivePlacement> {
    return effectivePlacement(this.#options.placement.placement, {
      syncing: Boolean(this.#options.sync.remote?.client),
      machine: this.#machine(),
    });
  }

  #desired(): Desired {
    const remote = this.#options.sync.remote;
    if (!remote || this.#options.agentMode === "off") return { kind: "standalone" };
    if (!remote.client) {
      return { kind: "unavailable", problem: remote.problem ?? "Sync can't start." };
    }
    const { effective } = this.#effective();
    if (effective === "always_on_machine") return { kind: "relayed" };
    return { kind: "lease", priority: effective === "always_on_host" ? "host" : "interactive" };
  }

  async #reconcile(): Promise<void> {
    if (this.#stopped) return;
    const desired = this.#desired();
    const current = this.#arrangement;
    if (current.kind === "lease" && desired.kind === "lease") {
      current.lease.setPriority(desired.priority);
    } else if (
      current.kind !== desired.kind ||
      (desired.kind === "unavailable" && current.kind === "unavailable")
    ) {
      const machine = this.#machine();
      if (desired.kind === "relayed" && machine && current.kind === "lease") {
        this.#setHandingTo(machine.name);
      }
      await this.#leave(
        desired.kind === "relayed" && machine
          ? `Handing the agent to ${machine.name}…`
          : LEASE_CHECKING_PROBLEM,
      );
      await this.#enter(desired);
    }
    this.#changed();
  }

  async #enter(desired: Desired): Promise<void> {
    const { runtime, sync, device, logger } = this.#options;
    switch (desired.kind) {
      case "standalone":
        this.#arrangement = { kind: "standalone" };
        await runtime.activate();
        return;
      case "unavailable":
        this.#arrangement = desired;
        await runtime.deactivate(desired.problem);
        return;
      case "lease": {
        const client = sync.remote?.client;
        if (!client) return;
        await runtime.deactivate(LEASE_CHECKING_PROBLEM);
        const lease = new AgentLease({
          client: agentLeaseClient(client),
          device,
          priority: desired.priority,
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
          windDown: async (problem) => {
            await runtime.deactivate(problem);
            await sync.syncPass();
          },
          onChange: () => this.#changed(),
          logger: logger.child({ component: "lease" }),
        });
        this.#arrangement = { kind: "lease", lease };
        lease.start();
        return;
      }
      case "relayed": {
        const client = sync.remote?.client;
        if (!client) return;
        const watcher: LeaseWatcher = new LeaseWatcher({
          client: agentLeaseClient(client),
          ...(this.#options.leaseTimings?.retryEveryMs
            ? { everyMs: this.#options.leaseTimings.retryEveryMs }
            : {}),
          onChange: () => void this.#serialized(() => this.#watched(watcher)),
          logger: logger.child({ component: "lease" }),
        });
        const problem = this.#relayedProblem(null);
        this.#arrangement = { kind: "relayed", watcher, problem };
        await runtime.deactivate(problem);
        watcher.start();
        return;
      }
    }
  }

  /** The watcher saw a new holder: update the reason and the handover note. */
  async #watched(watcher: LeaseWatcher): Promise<void> {
    const current = this.#arrangement;
    if (current.kind !== "relayed" || current.watcher !== watcher) return;
    if (watcher.holder?.priority === "host") this.#clearHandingTo();
    const problem = this.#relayedProblem(watcher.holder);
    if (problem !== current.problem) {
      this.#arrangement = { ...current, problem };
      await this.#options.runtime.deactivate(problem);
    }
    this.#changed();
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
    } else if (current.kind === "relayed") {
      current.watcher.stop();
    }
    await runtime.deactivate(problem);
  }

  // ── Status ───────────────────────────────────────────────────────────────

  #runsOn(): AgentRunsOn | null {
    const { device, agentMode } = this.#options;
    const self = (alwaysOnMachine: boolean): AgentRunsOn => ({
      deviceId: device.id,
      name: device.name,
      thisDevice: true,
      alwaysOnMachine,
    });
    const current = this.#arrangement;
    switch (current.kind) {
      case "standalone":
        return agentMode === "off" ? null : self(false);
      case "lease": {
        const state = current.lease.state;
        if (state.kind === "held" || state.kind === "yielding") {
          return self(state.lease.priority === "host");
        }
        return state.kind === "elsewhere" ? this.#fromHolder(state.holder) : null;
      }
      case "relayed":
        return current.watcher.holder ? this.#fromHolder(current.watcher.holder) : null;
      default:
        return null;
    }
  }

  #fromHolder(holder: SyncLeaseHolder): AgentRunsOn {
    return {
      deviceId: holder.device,
      name: holder.deviceName,
      thisDevice: holder.device === this.#options.device.id,
      alwaysOnMachine: holder.priority === "host",
    };
  }

  #relayState(): RelayState {
    if (this.#arrangement.kind !== "relayed") return "off";
    if (this.#relay) return this.#relay;
    return this.#options.credential?.current() ? "off" : "not_paired";
  }

  #note(): string | undefined {
    const current = this.#arrangement;
    if (current.kind === "lease") {
      const state = current.lease.state;
      if (state.kind === "elsewhere" && state.takeoverPending) {
        return `Taking over from ${state.holder.deviceName}…`;
      }
      if (state.kind === "yielding") return "Handing the agent to another device…";
    }
    if (this.#handingTo && this.#now() < this.#handingTo.until) {
      return `Handing the agent to ${this.#handingTo.name}…`;
    }
    return undefined;
  }

  #relayedProblem(holder: SyncLeaseHolder | null): string {
    const machine = this.#machine();
    if (holder && holder.device !== this.#options.device.id) {
      return `The agent is running on ${holder.deviceName}.`;
    }
    return machine
      ? `The agent runs on the always-on machine (${machine.name}), which isn't running it right now.`
      : "The agent runs on the always-on machine.";
  }

  #setHandingTo(name: string): void {
    this.#clearHandingTo();
    const timer = setTimeout(() => {
      this.#handingTo = null;
      this.#changed();
    }, HANDING_OVER_NOTE_MS);
    timer.unref?.();
    this.#handingTo = { name, until: this.#now() + HANDING_OVER_NOTE_MS, timer };
  }

  #clearHandingTo(): void {
    if (this.#handingTo) clearTimeout(this.#handingTo.timer);
    this.#handingTo = null;
  }

  /** Tells listeners (and the agent status) when anything they show changed. */
  #changed(): void {
    const snapshot = this.current();
    const key = JSON.stringify([snapshot, this.status()]);
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#options.logger.error("Placement listener failed", { error: errorMessage(error) });
      }
    }
    this.#options.runtime.refreshStatus();
  }

  #serialized(step: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(step);
    this.#queue = run.catch((error: unknown) => {
      this.#options.logger.error("Setting up the agent failed", { error: errorMessage(error) });
    });
    return run;
  }
}
