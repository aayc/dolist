import type { AgentPlacement, AgentPlacementStatus, AgentReadiness, AgentRunsOn } from "@ddl/core";
import type { SettingsSection } from "../../state/ui-store";

/** What the toggle offers: where the orchestrator runs for this device. */
export type PlacementChoice = Exclude<AgentPlacement, "always_on_host">;

export const PLACEMENT_CHOICES: ReadonlyArray<{ value: PlacementChoice; label: string }> = [
  { value: "this_device", label: "This device" },
  { value: "always_on_machine", label: "Always-on machine" },
];

/** A link that opens the Settings section which fixes something. */
export interface SetupLink {
  section: SettingsSection;
  label: string;
}

const HELD_HERE: Record<
  NonNullable<AgentPlacementStatus["heldHere"]>,
  { why: string; setup: SetupLink; held: string }
> = {
  no_sync: {
    why: "This device doesn't sync",
    setup: { section: "sync", label: "Set up sync" },
    held: "Held on this device until it syncs",
  },
  no_machine: {
    why: "Set up an always-on machine in Settings",
    setup: { section: "machine", label: "Set up an always-on machine" },
    held: "Held on this device until an always-on machine is set up",
  },
};

export const PLACEMENT_LOCKED =
  "DDL_AGENT_PLACEMENT sets where the agent runs on this device, so it can't be changed here";

export type ToggleState =
  /** The daemon doesn't report placement (an older daemon). */
  | { kind: "hidden" }
  /** This is the always-on machine. */
  | { kind: "host" }
  | {
      kind: "toggle";
      selected: PlacementChoice;
      /** Why it can't be switched (its tooltip), or null. */
      disabled: string | null;
      saving: boolean;
    };

/**
 * The toggle for a placement status: the stored choice (or the one being saved), disabled with a
 * reason while the agent is held here or an environment variable sets it.
 */
export function toggleState(
  placement: AgentPlacementStatus | undefined,
  options: { locked: boolean; pending: AgentPlacement | null },
): ToggleState {
  if (!placement) return { kind: "hidden" };
  const stored = options.pending ?? placement.placement;
  if (stored === "always_on_host") return { kind: "host" };
  const saving = options.pending !== null;
  const disabled = placement.heldHere
    ? HELD_HERE[placement.heldHere].why
    : options.locked
      ? PLACEMENT_LOCKED
      : null;
  return { kind: "toggle", selected: stored, disabled, saving };
}

/** Where the agent runs, in a few words, and more for a tooltip. */
export function runsOnText(runsOn: AgentRunsOn | null): {
  text: string;
  tone: LocationTone;
  detail?: string;
} {
  if (!runsOn) return { text: "Not running right now", tone: "idle" };
  if (runsOn.thisDevice) {
    return {
      text: runsOn.alwaysOnMachine ? "Running here" : "Running on this device",
      tone: "here",
    };
  }
  if (runsOn.alwaysOnMachine) {
    return {
      text: `Running on ${runsOn.name}`,
      tone: "machine",
      detail: `${runsOn.name} is the always-on machine`,
    };
  }
  return {
    text: `Running on ${runsOn.name}`,
    tone: "other",
    detail: `${runsOn.name} runs the agent itself; its work shows here as it syncs`,
  };
}

export type LocationTone = "here" | "machine" | "other" | "idle" | "busy" | "warning" | "danger";

export type LocationAction =
  | ({ kind: "settings" } & SetupLink)
  | { kind: "run_here"; label: string };

/** The line under the toggle: what's happening now, and what to do about it. */
export interface LocationLine {
  kind: "error" | "note" | "unreachable" | "not_paired" | "connecting" | "held" | "runs";
  text: string;
  tone: LocationTone;
  /** More about it (the text's tooltip). */
  detail?: string;
  action?: LocationAction;
}

/** The first thing that keeps a device from running the agent at all, or null. */
export function blockingProblem(readiness: AgentReadiness | undefined): string | null {
  if (!readiness) return null;
  if (!readiness.harness.ready) return readiness.harness.problem ?? "Its agent can't start";
  if (!readiness.modelCredential) return "It has no model credential";
  return null;
}

export function locationLine(
  placement: AgentPlacementStatus,
  context: {
    /** The vault's always-on machine, when one is set up. */
    machineName?: string;
    readiness?: AgentReadiness;
    /** The last placement change failed. */
    error?: string | null;
    locked?: boolean;
  },
): LocationLine {
  const machine = context.machineName ?? "the always-on machine";
  if (context.error) return { kind: "error", text: context.error, tone: "danger" };
  if (placement.note) return { kind: "note", text: placement.note, tone: "busy" };
  switch (placement.relay) {
    case "unreachable":
      return {
        kind: "unreachable",
        text: `${context.machineName ?? "The always-on machine"} can't be reached`,
        tone: "danger",
        ...(context.locked
          ? {}
          : { action: { kind: "run_here", label: "Run it on this device instead" } }),
      };
    case "not_paired":
      return {
        kind: "not_paired",
        text: "This device isn't paired with the always-on machine",
        tone: "warning",
        action: { kind: "settings", section: "machine", label: "Pair it" },
      };
    case "connecting":
      return { kind: "connecting", text: `Connecting to ${machine}…`, tone: "busy" };
    default:
      break;
  }
  const held = placement.heldHere ? HELD_HERE[placement.heldHere] : null;
  const setup = held ? ({ kind: "settings", ...held.setup } as const) : undefined;
  if (held && placement.placement === "always_on_machine") {
    return { kind: "held", text: held.held, tone: "here", ...(setup ? { action: setup } : {}) };
  }
  const runs = runsOnText(placement.runsOn);
  const problem = placement.runsOn?.thisDevice ? blockingProblem(context.readiness) : null;
  if (problem) {
    return {
      kind: "runs",
      text: `${runs.text}, which isn't ready`,
      tone: "warning",
      detail: problem,
      action: setup ?? { kind: "settings", section: "location", label: "See why" },
    };
  }
  return {
    kind: "runs",
    text: runs.text,
    tone: runs.tone,
    ...(runs.detail ? { detail: runs.detail } : {}),
    ...(setup ? { action: setup } : {}),
  };
}

/**
 * Why this device can't act on the agent right now (its agent actions are disabled with this as
 * the tooltip), or null. It can when it runs the agent, or relays to the always-on machine running
 * it; otherwise the daemon serves the synced state read-only.
 */
export function readOnlyReason(placement: AgentPlacementStatus | undefined): string | null {
  if (!placement || placement.runsOn?.thisDevice) return null;
  switch (placement.relay) {
    case "unreachable":
      return "The always-on machine can't be reached";
    case "not_paired":
      return "This device isn't paired with the always-on machine";
    case "connecting":
      return "Connecting to the always-on machine…";
    default:
      break;
  }
  const { runsOn } = placement;
  if (!runsOn) return machineIdle(placement) ? MACHINE_IDLE : null;
  if (placement.relay === "connected" && runsOn.alwaysOnMachine) return null;
  return `The agent is running on ${runsOn.name}`;
}

export const MACHINE_IDLE = "The always-on machine isn't running the agent right now";

/** Set to the always-on machine, which nobody runs the agent on (and no relay to ask it). */
export function machineIdle(placement: AgentPlacementStatus): boolean {
  return (
    placement.placement === "always_on_machine" &&
    !placement.heldHere &&
    placement.runsOn === null &&
    placement.relay === "off"
  );
}
