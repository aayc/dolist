import type { Logger, Unsubscribe } from "@ddl/core";
import type { AgentLease } from "./agent-lease";
import { errorMessage } from "./errors";
import type { PlacementSource } from "./relay/sources";

export const RELAYED_PROBLEM = "The agent runs on the always-on machine.";

export interface PlacementLeaseOptions {
  placement: PlacementSource;
  createLease(): AgentLease;
  /** Stops the agent here before the lease is released (it runs a sync pass). */
  beforeRelease(problem: string): Promise<void>;
  /** The agent doesn't run here: it runs on the always-on machine. */
  onRelayed(): Promise<void>;
  logger: Logger;
}

/**
 * The agent lease, asked for only while this device may run the agent. A device whose effective
 * placement is `always_on_machine` never asks (its agent runs on the always-on machine), and
 * switching to that placement releases the lease the way shutting down does. Steps run one at a
 * time.
 */
export class PlacementLease {
  readonly #options: PlacementLeaseOptions;
  #lease: AgentLease | null = null;
  #unsubscribe: Unsubscribe | undefined;
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: PlacementLeaseOptions) {
    this.#options = options;
  }

  start(): void {
    this.#unsubscribe = this.#options.placement.onChange(() => void this.#apply());
    void this.#apply();
  }

  /** Stops asking; if this device holds the lease, runs `beforeRelease` and releases it. */
  async stop(problem: string): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe?.();
    await this.#enqueue(async () => {
      const lease = this.#lease;
      this.#lease = null;
      await lease?.stop(() => this.#options.beforeRelease(problem));
    });
  }

  #apply(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#stopped) return;
      const relayed = this.#options.placement.current().effective === "always_on_machine";
      if (!relayed && !this.#lease) {
        this.#lease = this.#options.createLease();
        this.#lease.start();
      } else if (relayed) {
        const lease = this.#lease;
        this.#lease = null;
        await lease?.stop(() => this.#options.beforeRelease(RELAYED_PROBLEM));
        await this.#options.onRelayed();
      }
    });
  }

  #enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(step).catch((error: unknown) => {
      this.#options.logger.error("Agent lease step failed", { error: errorMessage(error) });
    });
    this.#queue = next;
    return next;
  }
}
