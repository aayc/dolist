import type { AgentPlacement, DeviceSettingsResponse } from "@ddl/core";
import { create } from "zustand";
import type { DaemonClient } from "../../api/client";
import { updateAgentState } from "../../state/agent-store";
import { remoteErrorMessage } from "./remote-errors";

interface DeviceState {
  /** This daemon's device-local settings, once loaded. */
  device: DeviceSettingsResponse | null;
  /** Why they couldn't be loaded. */
  loadError: string | null;
  /** A placement being saved (the toggle shows it chosen meanwhile). */
  pendingPlacement: AgentPlacement | null;
  /** Why the last placement change failed. */
  placementError: string | null;
}

export const useDeviceStore = create<DeviceState>(() => ({
  device: null,
  loadError: null,
  pendingPlacement: null,
  placementError: null,
}));

/** How long a failed placement change is explained under the toggle. */
const ERROR_SHOWN_MS = 8_000;

let loading: Promise<void> | null = null;

/** Loads the device settings once (`force`: again); the header and Settings share them. */
export function loadDevice(client: DaemonClient, force = false): Promise<void> {
  if (!force && (useDeviceStore.getState().device || loading)) return loading ?? Promise.resolve();
  loading = client
    .getDevice()
    .then(
      (device) => useDeviceStore.setState({ device, loadError: null }),
      (error: unknown) => useDeviceStore.setState({ loadError: remoteErrorMessage(error, "load") }),
    )
    .finally(() => {
      loading = null;
    });
  return loading;
}

export function applyDevice(device: DeviceSettingsResponse): void {
  useDeviceStore.setState({ device, loadError: null });
}

/**
 * Where this device's agent runs (`PATCH /api/device`). The daemon pushes the new placement in
 * `agent.status`; until then the agent status carries the choice, so the toggle doesn't flicker.
 */
export async function setPlacement(client: DaemonClient, placement: AgentPlacement): Promise<void> {
  if (useDeviceStore.getState().pendingPlacement !== null) return;
  useDeviceStore.setState({ pendingPlacement: placement, placementError: null });
  try {
    const device = await client.updateDevice({ placement });
    updateAgentState((state) =>
      state.status?.placement
        ? {
            ...state,
            status: { ...state.status, placement: { ...state.status.placement, placement } },
          }
        : state,
    );
    useDeviceStore.setState({ device, pendingPlacement: null });
  } catch (error) {
    const message = remoteErrorMessage(error, "placement");
    useDeviceStore.setState({ pendingPlacement: null, placementError: message });
    setTimeout(() => {
      if (useDeviceStore.getState().placementError === message) clearPlacementError();
    }, ERROR_SHOWN_MS);
  }
}

export function clearPlacementError(): void {
  useDeviceStore.setState({ placementError: null });
}
