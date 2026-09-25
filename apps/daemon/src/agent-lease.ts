import { randomBytes } from "node:crypto";
import type { Logger, SyncLeaseHolder } from "@ddl/core";
import type { LeaseAttempt, SyncServiceClient } from "@ddl/storage";
import { errorMessage } from "./errors";
import type { DeviceIdentity } from "./sync-setup";

/** The server side of the lease: one holder at a time, renewable by it, free after the TTL. */
export interface LeaseClient {
  acquire(request: { deviceName: string; session: string; ttlMs: number }): Promise<LeaseAttempt>;
  release(session: string): Promise<void>;
}

/** The `agent` lease of a vault on the sync server. */
export function agentLeaseClient(client: SyncServiceClient): LeaseClient {
  return {
    acquire: (request) => client.acquireLease("agent", request),
    release: async (session) => {
      await client.releaseLease("agent", session);
    },
  };
}

export interface LeaseTimings {
  /** How long a grant lasts on the server. */
  ttlMs: number;
  renewEveryMs: number;
  /** How often to ask again while another device holds it. */
  retryEveryMs: number;
  /** Longest wait between attempts while the server can't be reached. */
  maxBackoffMs: number;
  /** The agent stops this long before the lease could have expired on the server. */
  marginMs: number;
}

export const DEFAULT_LEASE_TIMINGS: LeaseTimings = {
  ttlMs: 60_000,
  renewEveryMs: 20_000,
  retryEveryMs: 15_000,
  maxBackoffMs: 60_000,
  marginMs: 5_000,
};

export type AgentLeaseState =
  | { kind: "checking" }
  | { kind: "held" }
  | { kind: "elsewhere"; holder: SyncLeaseHolder }
  | { kind: "unreachable"; error: string }
  | { kind: "stopped" };

export interface AgentLeaseOptions {
  client: LeaseClient;
  device: DeviceIdentity;
  timings?: Partial<LeaseTimings>;
  /** This device holds the lease now: the agent may run. */
  onAcquired(): Promise<void>;
  /** The agent must not run here (never had the lease, or lost it); `problem` says why. */
  onUnavailable(problem: string): Promise<void>;
  logger: Logger;
  /** Monotonic milliseconds. */
  now?: () => number;
}

export const LEASE_CHECKING_PROBLEM = "Checking with the sync server which device runs the agent…";
const LEASE_LOST_PROBLEM =
  "The agent stopped here because the sync server stopped answering: it must never run on two devices at once. It resumes when the server answers.";

/**
 * Keeps the vault's `agent` lease so that exactly one device runs the agent. It acquires the lease
 * (and renews it every `renewEveryMs`) while it is free or already ours; while another device
 * holds it, it asks again every `retryEveryMs` and takes over once that device releases it or
 * stops renewing. If renewals fail, the agent stops before the grant could have run out on the
 * server (`marginMs` early, measured from when the last successful request was sent), so two
 * devices never both believe they hold it. Steps run one at a time.
 */
export class AgentLease {
  /** Random per process: a copied device id can't renew someone else's grant. */
  readonly session = `s_${randomBytes(12).toString("base64url")}`;
  readonly #options: AgentLeaseOptions;
  readonly #timings: LeaseTimings;
  readonly #now: () => number;
  #state: AgentLeaseState = { kind: "checking" };
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
  }

  get state(): AgentLeaseState {
    return this.#state;
  }

  start(): void {
    this.#schedule(0);
  }

  /** Stops asking; if this device holds the lease, runs `beforeRelease` and then releases it. */
  async stop(beforeRelease?: () => Promise<void>): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#deadlineTimer);
    await this.#enqueue(async () => {
      const held = this.#state.kind === "held";
      this.#state = { kind: "stopped" };
      if (!held) return;
      try {
        await beforeRelease?.();
      } catch (error) {
        this.#options.logger.warn("Could not wind down before releasing the agent lease", {
          error: errorMessage(error),
        });
      }
      try {
        await this.#options.client.release(this.session);
      } catch (error) {
        this.#options.logger.warn("Could not release the agent lease; it runs out by itself", {
          error: errorMessage(error),
        });
      }
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
      this.#state = { kind: "held" };
      this.#problem = undefined;
      // A grant that lands while stopping is released by `stop()`; the agent doesn't start.
      if (acquired && !this.#stopped) {
        this.#options.logger.info("This device runs the agent");
        await this.#options.onAcquired();
      }
      this.#schedule(this.#timings.renewEveryMs);
      return;
    }
    clearTimeout(this.#deadlineTimer);
    await this.#unavailable(
      { kind: "elsewhere", holder: outcome.holder },
      heldElsewhereProblem(outcome.holder, device),
    );
    this.#schedule(this.#timings.retryEveryMs);
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
    this.#state = state;
    if (!wasHeld && problem === this.#problem) return;
    this.#problem = problem;
    if (wasHeld) this.#options.logger.warn("This device no longer runs the agent");
    await this.#options.onUnavailable(problem);
  }
}

function heldElsewhereProblem(holder: SyncLeaseHolder, device: DeviceIdentity): string {
  return holder.device === device.id
    ? "An earlier run of this device still holds the agent lease; the agent starts here once it runs out."
    : `The agent is running on ${holder.deviceName}.`;
}
