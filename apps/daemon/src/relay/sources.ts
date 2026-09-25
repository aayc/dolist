/**
 * What the agent relay reads about this device: where its agent runs and its credential for the
 * always-on machine. Structural types: anything with these members works (the daemon's placement
 * and machine link provide them; tests use the settable versions below).
 */
import type { AgentPlacement, RelayState, Unsubscribe } from "@ddl/core";

/** This device's credential for the always-on machine. */
export interface MachineCredential {
  /** The machine's URL (`https://<host>[:port]`); the token is only ever sent there. */
  url: string;
  /** A token the machine issued to this daemon. Never log it. */
  token: string;
}

export interface PlacementSource {
  /** `effective`: what applies now (`this_device` whenever the agent is held on this device). */
  current(): { effective: AgentPlacement };
  onChange(listener: () => void): Unsubscribe;
  /**
   * The relay reports its state here while the effective placement is `always_on_machine` (null
   * otherwise), for the `placement` block of the agent status.
   */
  setRelay?(state: RelayState | null): void;
}

export interface MachineCredentialSource {
  /** The credential for the vault's always-on machine, or null (not paired). */
  current(): MachineCredential | null;
  onChange(listener: () => void): Unsubscribe;
}

/** A placement that changes only when told to. */
export class SettablePlacement implements PlacementSource {
  #effective: AgentPlacement;
  #relay: RelayState | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(effective: AgentPlacement = "this_device") {
    this.#effective = effective;
  }

  /** The last state the relay reported. */
  get relay(): RelayState | null {
    return this.#relay;
  }

  current(): { effective: AgentPlacement } {
    return { effective: this.#effective };
  }

  set(effective: AgentPlacement): void {
    if (effective === this.#effective) return;
    this.#effective = effective;
    for (const listener of [...this.#listeners]) listener();
  }

  onChange(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setRelay(state: RelayState | null): void {
    this.#relay = state;
  }
}

/** A machine credential that changes only when told to. */
export class SettableMachineCredential implements MachineCredentialSource {
  #credential: MachineCredential | null;
  readonly #listeners = new Set<() => void>();

  constructor(credential: MachineCredential | null = null) {
    this.#credential = credential;
  }

  current(): MachineCredential | null {
    return this.#credential;
  }

  set(credential: MachineCredential | null): void {
    this.#credential = credential;
    for (const listener of [...this.#listeners]) listener();
  }

  onChange(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
