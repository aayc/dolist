import type { AgentMode, ComputerAccess } from "@ddl/core";
import type { ClientKind, ConnectionState } from "../../api/client";
import type { SaveState } from "../../state/notes-store";

/* The status bar is quiet while things are fine: `null` means "show nothing". */

export type SaveProblem = Exclude<SaveState, "saved">;

/** Unsaved, saving, conflict and failed saves show; a saved note doesn't. */
export function visibleSaveState(state: SaveState | null): SaveProblem | null {
  return state === null || state === "saved" ? null : state;
}

/** A status bar item's text and its tooltip. */
export interface ConnectionItem {
  label: string;
  title: string;
}

const CONNECTION_PROBLEMS: Record<Exclude<ConnectionState, "online">, string> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

const CONNECTION_TITLES: Record<Exclude<ConnectionState, "online">, string> = {
  connecting: "Connecting to the daemon",
  reconnecting: "Lost the daemon — reconnecting automatically",
  offline: "Can't reach the daemon — retrying automatically",
};

/** Connection problems show; a live daemon connection doesn't, the in-browser demo gets a marker. */
export function connectionItem(
  state: ConnectionState,
  kind: ClientKind | null,
): ConnectionItem | null {
  if (state !== "online")
    return { label: CONNECTION_PROBLEMS[state], title: CONNECTION_TITLES[state] };
  if (kind === "mock")
    return { label: "Demo", title: "Running against the in-browser mock daemon" };
  return null;
}

/** The agent's mode is worth a word only when it isn't the real agent. */
export function agentModeLabel(mode: AgentMode | null): string | null {
  return mode === null || mode === "live" ? null : mode;
}

export type AgentItemState = "unknown" | "on" | "paused" | "off" | "unavailable";

/** One agent item that never says "on" while the agent can't act (same wording as the Mac app). */
export function agentItem(
  enabled: boolean | null,
  off: boolean,
  problem: string | null,
): { state: AgentItemState; label: string; title: string } {
  if (enabled === null) return { state: "unknown", label: "Agent", title: "Agent status unknown" };
  if (off) {
    return {
      state: "off",
      label: "Agent off",
      title: problem ?? "The agent is turned off for this daemon",
    };
  }
  if (problem) return { state: "unavailable", label: "Agent unavailable", title: problem };
  return enabled
    ? {
        state: "on",
        label: "Agent on",
        title: "The agent is watching your daily notes — click to pause",
      }
    : { state: "paused", label: "Agent paused", title: "The agent is paused — click to resume" };
}

/**
 * A warning while agents can't use the Mac's apps because a permission is missing; nothing when
 * they can, when there's no computer use, or while the agent isn't on.
 */
export function computerItem(
  access: ComputerAccess | undefined,
  agentOn: boolean,
): ConnectionItem | null {
  if (!access || !agentOn || (access.accessibility && access.screenRecording)) return null;
  const missing = [
    access.accessibility ? "" : "Accessibility",
    access.screenRecording ? "" : "Screen Recording",
  ]
    .filter(Boolean)
    .join(" and ");
  const host = access.hostApp ? `“${access.hostApp.name}”` : "the app running Daily Do List";
  return {
    label: "Computer access",
    title: `Agents can't use your Mac's apps yet: allow ${missing} for ${host}`,
  };
}

/** "2 running", or "3 queued" while nothing runs yet; the tooltip counts both. */
export function runningItem(running: number, queued: number): ConnectionItem | null {
  if (running + queued <= 0) return null;
  const tasks = (n: number) => (n === 1 ? "1 agent task" : `${n} agent tasks`);
  if (running <= 0) return { label: `${queued} queued`, title: `${tasks(queued)} queued` };
  return {
    label: `${running} running`,
    title: `${tasks(running)} running${queued > 0 ? ` · ${queued} queued` : ""}`,
  };
}
