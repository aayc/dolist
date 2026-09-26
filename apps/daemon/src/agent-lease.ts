import { randomBytes } from "node:crypto";
import {
  errorMessage,
  type Logger,
  SYNC_LEASE_TAKEOVER,
  type SyncLeaseHolder,
  type SyncLeasePriority,
} from "@ddl/core";
import type { LeaseAttempt, SyncServiceClient } from "@ddl/storage";
import type { DeviceIdentity } from "./sync-setup";

export interface LeaseRequest {
  deviceName: string;
  session: string;
  ttlMs: number;
  priority: SyncLeasePriority;
}

/** The server side of the lease: one holder at a time, renewable by it, free after the TTL. */
export interface LeaseClient {
  acquire(request: LeaseRequest): Promise<LeaseAttempt>;
  /** Releases a held lease, or withdraws this device's pending takeover. */
  release(session: string): Promise<void>;
  /** The current holder, without asking for the lease. */
  holder(): Promise<SyncLeaseHolder | null>;
}

/** The `agent` lease of a vault on the sync server. */
export function agentLeaseClient(client: SyncServiceClient): LeaseClient {
  return {
    acquire: (request) => client.acquireLease("agent", request),
    release: async (session) => {
      await client.releaseLease("agent", session);
    },
    holder: () => client.leaseHolder("agent"),
  };
}

export interface LeaseTimings {
  /** How long a grant lasts on the server. */
  ttlMs: number;
  renewEveryMs: number;
  /** How often to ask again while another device holds it. */
  retryEveryMs: number;
  /** How often to ask while this device's takeover is pending. */
  takeoverRetryMs: number;
  /** Longest wait between attempts while the server can't be reached. */
  maxBackoffMs: number;
  /** The agent stops this long before the lease could have expired on the server. */
  marginMs: number;
}

export const DEFAULT_LEASE_TIMINGS: LeaseTimings = {
  ttlMs: 60_000,
  renewEveryMs: 20_000,
  retryEveryMs: 15_000,
  takeoverRetryMs: SYNC_LEASE_TAKEOVER.pollMs,
  maxBackoffMs: 60_000,
  marginMs: 5_000,
};

export type AgentLeaseState =
  | { kind: "checking" }
  | { kind: "held"; lease: SyncLeaseHolder }
  /** A device that outranks this one asked for the agent: stopping, syncing, then releasing. */
  | { kind: "yielding"; lease: SyncLeaseHolder }
  /** `takeoverPending`: this device outranks the holder and waits for it to yield. */
  | { kind: "elsewhere"; holder: SyncLeaseHolder; takeoverPending: boolean }
  | { kind: "unreachable"; error: string }
  | { kind: "stopped" };

export interface AgentLeaseOptions {
  client: LeaseClient;
  /** Read on every request, so a rename shows on other devices. */
  device: DeviceIdentity;
  /** `interactive` (a device set to run the agent) outranks `host` (the always-on machine). */
  priority?: SyncLeasePriority;
  timings?: Partial<LeaseTimings>;
  /** This device holds the lease now: the agent may run. */
  onAcquired(): Promise<void>;
  /** The agent must not run here (never had the lease, or lost it); `problem` says why. */
  onUnavailable(problem: string): Promise<void>;
  /**
   * Before a voluntary release (yielding to another device, or `stop()`): stop the agent with
   * `problem` as the reason and push its last state. Default: `onUnavailable`.
   */
  windDown?(problem: string): Promise<void>;
  /** The state changed (who holds the lease, a pending takeover, the priority). */
  onChange?(): void;
  logger: Logger;
  /** Monotonic milliseconds. */
  now?: () => number;
}

export const LEASE_CHECKING_PROBLEM = "Checking with the sync server which device runs the agent…";
export const LEASE_YIELDING_PROBLEM = "Another device is taking the agent over.";
const LEASE_LOST_PROBLEM =
  "The agent stopped here because the sync server stopped answering: it must never run on two devices at once. It resumes when the server answers.";

/**
 * Keeps the vault's `agent` lease so that exactly one device runs the agent. It acquires the lease
 * (and renews it every `renewEveryMs`) while it is free or already ours; while another device
 * holds it, it asks again every `retryEveryMs` and takes over once that device releases it or
 * stops renewing. If renewals fail, the agent stops before the grant could have run out on the
 * server (`marginMs` early, measured from when the last successful request was sent), so two
 * devices never both believe they hold it. Steps run one at a time.
 *
 * Priorities: a request that outranks the holder makes the server ask the holder to yield; this
 * device then asks every `takeoverRetryMs` until it gets the lease. When the server asks this
 * device to yield, it winds the agent down (stop, sync), releases, and asks again later like any
 * device that doesn't hold the lease.
 */
export class AgentLease {
  /** Random per process: a copied device id can't renew someone else's grant. */
  readonly session = `s_${randomBytes(12).toString("base64url")}`;
  readonly #options: AgentLeaseOptions;
  readonly #timings: LeaseTimings;
  readonly #now: () => number;
  #priority: SyncLeasePriority;
  #state: AgentLeaseState = { kind: "checking" };
  /** The epoch of the grant this device holds, until its release completes. */
  #heldEpoch: number | null = null;
  #problem: string | undefined;
  #deadline = 0;
  #failures = 0;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: AgentLeaseOptions) {
    this.#options = options;
    this.#timings = { ...DEFAULT_LEASE_TIMINGS, ...options.timings };
    this.#now = options.now ?? (() => performance.now());
    this.#priority = options.priority ?? "interactive";
  }

  get state(): AgentLeaseState {
    return this.#state;
  }

  get priority(): SyncLeasePriority {
    return this.#priority;
  }

  /**
   * The epoch of the lease grant this device holds, or null. It stays set while the agent winds
   * down before a release, so the agent's last writes still carry it.
   */
  get heldEpoch(): number | null {
    return this.#heldEpoch;
  }

  start(): void {
    this.#schedule(0);
  }

  /** Asks with `priority` from now on (a holder renews with it; a waiting device asks now). */
  setPriority(priority: SyncLeasePriority): void {
    if (priority === this.#priority) return;
    this.#priority = priority;
    this.#options.onChange?.();
    if (this.#state.kind !== "held" && this.#state.kind !== "yielding") this.#schedule(0);
  }

  /**
   * Stops asking; if this device holds the lease, winds the agent down (`beforeRelease`, else the
   * `windDown` option) and releases it. A pending takeover is withdrawn.
   */
  async stop(beforeRelease?: () => Promise<void>): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#deadlineTimer);
    await this.#enqueue(async () => {
      const previous = this.#state;
      this.#state = { kind: "stopped" };
      const held = previous.kind === "held";
      const pending = previous.kind === "elsewhere" && previous.takeoverPending;
      const windDown = this.#options.windDown;
      if (held) {
        try {
          await (beforeRelease ?? (() => windDown?.("The daemon is shutting down.")))();
        } catch (error) {
          this.#options.logger.warn("Could not wind down before releasing the agent lease", {
            error: errorMessage(error),
          });
        }
      }
      if (held || pending) await this.#release();
      this.#options.onChange?.();
    });
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#enqueue(() => this.#attempt()), ms);
    this.#timer.unref?.();
  }

  #enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(step).catch((error: unknown) => {
      this.#options.logger.error("Agent lease step failed", { error: errorMessage(error) });
    });
    this.#queue = next;
    return next;
  }

  async #attempt(): Promise<void> {
    if (this.#stopped) return;
    const { client, device } = this.#options;
    const sentAt = this.#now();
    let outcome: LeaseAttempt;
    try {
      outcome = await client.acquire({
        deviceName: device.name,
        session: this.session,
        ttlMs: this.#timings.ttlMs,
        priority: this.#priority,
      });
    } catch (error) {
      await this.#failed(errorMessage(error));
      return;
    }
    this.#failures = 0;
    if (outcome.granted) {
      this.#deadline = sentAt + this.#timings.ttlMs - this.#timings.marginMs;
      this.#armDeadline();
      const acquired = this.#state.kind !== "held";
      this.#setState({ kind: "held", lease: outcome.lease });
      this.#heldEpoch = outcome.lease.epoch;
      this.#problem = undefined;
      // A grant that lands while stopping is released by `stop()`; the agent doesn't start.
      if (acquired && !this.#stopped) {
        this.#options.logger.info("This device runs the agent");
        await this.#options.onAcquired();
      }
      if (outcome.lease.yieldRequested && !this.#stopped) {
        await this.#yield(outcome.lease);
        return;
      }
      this.#schedule(this.#timings.renewEveryMs);
      return;
    }
    clearTimeout(this.#deadlineTimer);
    const takeoverPending = outcome.takeoverPending === true;
    await this.#unavailable(
      { kind: "elsewhere", holder: outcome.holder, takeoverPending },
      heldElsewhereProblem(outcome.holder, device),
    );
    this.#schedule(takeoverPending ? this.#timings.takeoverRetryMs : this.#timings.retryEveryMs);
  }

  /** Hands the agent to the device that outranks this one: stop, sync, release, ask later. */
  async #yield(lease: SyncLeaseHolder): Promise<void> {
    this.#options.logger.info("Handing the agent over to a device that asked for it");
    this.#setState({ kind: "yielding", lease });
    this.#problem = LEASE_YIELDING_PROBLEM;
    try {
      await this.#windDown(LEASE_YIELDING_PROBLEM);
    } catch (error) {
      this.#options.logger.warn("Could not wind down before handing the agent over", {
        error: errorMessage(error),
      });
    }
    clearTimeout(this.#deadlineTimer);
    await this.#release();
    if (this.#stopped) return;
    this.#setState({ kind: "checking" });
    this.#schedule(this.#timings.retryEveryMs);
  }

  async #release(): Promise<void> {
    try {
      await this.#options.client.release(this.session);
    } catch (error) {
      this.#options.logger.warn("Could not release the agent lease; it runs out by itself", {
        error: errorMessage(error),
      });
    } finally {
      this.#heldEpoch = null;
    }
  }

  #windDown(problem: string): Promise<void> {
    return (this.#options.windDown ?? this.#options.onUnavailable)(problem);
  }

  async #failed(error: string): Promise<void> {
    this.#failures++;
    if (this.#state.kind === "held") {
      const left = this.#deadline - this.#now();
      if (left > 0) {
        this.#options.logger.warn("Could not renew the agent lease; retrying", { error });
        this.#schedule(Math.max(50, Math.min(this.#timings.renewEveryMs / 4, left / 2)));
        return;
      }
      this.#options.logger.warn("Lost the agent lease: the sync server didn't answer in time");
      await this.#unavailable({ kind: "unreachable", error }, LEASE_LOST_PROBLEM);
    } else if (this.#state.kind === "unreachable") {
      // Still unreachable: keep the reason already reported (it says how this began).
      this.#state = { kind: "unreachable", error };
    } else {
      await this.#unavailable(
        { kind: "unreachable", error },
        `The agent stays off here until the sync server confirms that no other device runs it (${error}).`,
      );
    }
    const { retryEveryMs, maxBackoffMs } = this.#timings;
    this.#schedule(Math.min(maxBackoffMs, (retryEveryMs / 3) * 2 ** (this.#failures - 1)));
  }

  #armDeadline(): void {
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = setTimeout(
      () =>
        void this.#enqueue(async () => {
          if (this.#state.kind !== "held" || this.#now() < this.#deadline) return;
          this.#options.logger.warn("Lost the agent lease: the sync server didn't answer in time");
          await this.#unavailable({ kind: "unreachable", error: "no answer" }, LEASE_LOST_PROBLEM);
        }),
      Math.max(0, this.#deadline - this.#now()),
    );
    this.#deadlineTimer.unref?.();
  }

  /** Enters a state where the agent must not run; tells the owner if it ran or the reason changed. */
  async #unavailable(state: AgentLeaseState, problem: string): Promise<void> {
    const wasHeld = this.#state.kind === "held";
    this.#setState(state);
    // Lost, not released: the grant is no longer this device's to write under.
    this.#heldEpoch = null;
    if (!wasHeld && problem === this.#problem) return;
    this.#problem = problem;
    if (wasHeld) this.#options.logger.warn("This device no longer runs the agent");
    await this.#options.onUnavailable(problem);
  }

  #setState(state: AgentLeaseState): void {
    const before = describeState(this.#state);
    this.#state = state;
    if (describeState(state) !== before) this.#options.onChange?.();
  }
}

/**
 * Who holds the vault's agent lease, for a device that never asks for it (its agent runs on the
 * always-on machine). Asks the server every `everyMs`.
 */
export class LeaseWatcher {
  readonly #client: LeaseClient;
  readonly #everyMs: number;
  readonly #onChange: () => void;
  readonly #logger: Logger;
  #holder: SyncLeaseHolder | null = null;
  #known = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: {
    client: LeaseClient;
    everyMs?: number;
    onChange: () => void;
    logger: Logger;
  }) {
    this.#client = options.client;
    this.#everyMs = options.everyMs ?? DEFAULT_LEASE_TIMINGS.retryEveryMs;
    this.#onChange = options.onChange;
    this.#logger = options.logger;
  }

  /** The last holder seen (null: nobody, or not known yet). */
  get holder(): SyncLeaseHolder | null {
    return this.#holder;
  }

  start(): void {
    void this.#check();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  async #check(): Promise<void> {
    if (this.#stopped) return;
    let holder: SyncLeaseHolder | null = this.#holder;
    try {
      holder = await this.#client.holder();
    } catch (error) {
      this.#logger.debug("Could not ask who runs the agent", { error: errorMessage(error) });
    }
    if (this.#stopped) return;
    const changed = !this.#known || holderKey(holder) !== holderKey(this.#holder);
    this.#holder = holder;
    this.#known = true;
    if (changed) this.#onChange();
    this.#timer = setTimeout(() => void this.#check(), this.#everyMs);
    this.#timer.unref?.();
  }
}

function heldElsewhereProblem(holder: SyncLeaseHolder, device: DeviceIdentity): string {
  return holder.device === device.id
    ? "An earlier run of this device still holds the agent lease; the agent starts here once it runs out."
    : `The agent is running on ${holder.deviceName}.`;
}

function holderKey(holder: SyncLeaseHolder | null): string {
  return holder
    ? `${holder.device}\u0000${holder.deviceName}\u0000${holder.priority}\u0000${holder.yieldRequested === true}`
    : "";
}

function describeState(state: AgentLeaseState): string {
  switch (state.kind) {
    case "held":
    case "yielding":
      return `${state.kind}\u0000${state.lease.priority}\u0000${state.lease.yieldRequested === true}`;
    case "elsewhere":
      return `${state.kind}\u0000${holderKey(state.holder)}\u0000${state.takeoverPending}`;
    default:
      return state.kind;
  }
}
