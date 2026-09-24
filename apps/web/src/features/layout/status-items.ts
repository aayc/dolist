import type { AgentMode } from "@ddl/core";
import type { ClientKind, ConnectionState } from "../../api/client";
import type { SaveState } from "../../state/notes-store";

/* The status bar is quiet while things are fine: `null` means "show nothing". */

export type SaveProblem = Exclude<SaveState, "saved">;

/** Unsaved, saving, conflict and failed saves show; a saved note doesn't. */
export function visibleSaveState(state: SaveState | null): SaveProblem | null {
  return state === null || state === "saved" ? null : state;
}

export interface ConnectionItem {
  label: string;
  title: string;
}

const CONNECTION_PROBLEMS: Record<Exclude<ConnectionState, "online">, string> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

/** Connection problems show; a live daemon connection doesn't, the in-browser demo gets a marker. */
export function connectionItem(
  state: ConnectionState,
  kind: ClientKind | null,
): ConnectionItem | null {
  if (state !== "online") return { label: CONNECTION_PROBLEMS[state], title: `Daemon: ${state}` };
  if (kind === "mock")
    return { label: "Demo", title: "Running against the in-browser mock daemon" };
  return null;
}

/** The agent's mode is worth a word only when it isn't the real agent. */
export function agentModeLabel(mode: AgentMode | null): string | null {
  return mode === null || mode === "live" ? null : mode;
}
