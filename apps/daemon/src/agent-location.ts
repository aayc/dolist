/**
 * Where this device's agent runs, as the rest of the daemon reads it (the agent relay above all):
 * read-only views with change listeners. Structural types: anything with these members works.
 */
import type {
  AgentPlacement,
  AgentPlacementStatus,
  AgentRunsOn,
  RelayState,
  Unsubscribe,
} from "@ddl/core";

/** This device's credential for the always-on machine (`$DDL_HOME/machine-token`). */
export interface MachineCredential {
  /** The machine's normalized URL (`https://<host>[:port]`); the token is only ever sent there. */
  url: string;
  /** A device token the machine issued to this daemon. Never log it. */
  token: string;
}

export interface MachineCredentialSource {
  /**
   * The credential for the vault's current always-on machine, or null (not paired, or paired
   * with a machine that is no longer the vault's always-on machine).
   */
  current(): MachineCredential | null;
  onChange(listener: (credential: MachineCredential | null) => void): Unsubscribe;
}

export interface PlacementSnapshot {
  /** The stored choice. */
  placement: AgentPlacement;
  /** What applies now: `this_device` whenever `heldHere` is set. */
  effective: AgentPlacement;
  heldHere?: "no_machine" | "no_sync";
  /** Who holds the agent lease (null: nobody, or not known). */
  runsOn: AgentRunsOn | null;
}

export interface PlacementSource {
  current(): PlacementSnapshot;
  /** Called after any field of `current()` or `status()` changed. */
  onChange(listener: (snapshot: PlacementSnapshot) => void): Unsubscribe;
  /** The `placement` block of the agent status. */
  status(): AgentPlacementStatus;
  /**
   * The relay reports its state here while the effective placement is `always_on_machine`
   * (null: back to the default, `not_paired` without a credential and `off` otherwise).
   */
  setRelay(state: RelayState | null): void;
}
