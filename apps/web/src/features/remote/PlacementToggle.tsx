import { useEffect } from "react";
import { useServices } from "../../app/services";
import { Switch } from "../../components/Switch";
import { useAgentStore } from "../../state/agent-store";
import { loadDevice, setPlacement, useDeviceStore } from "./device-store";
import { toggleState } from "./placement";

/**
 * The Remote switch: on, the orchestrator runs on the always-on machine; off, on this device.
 * While it can't be flipped (held here, set by an environment variable, or moving) it's disabled
 * and its wrapper's tooltip says why. Nothing on the always-on machine itself.
 */
export function PlacementToggle({ testId = "placement-toggle" }: { testId?: string }) {
  const { client } = useServices();
  const placement = useAgentStore((s) => s.status?.placement);
  const locked = useDeviceStore((s) => s.device?.lockedByEnv.includes("placement") ?? false);
  const pending = useDeviceStore((s) => s.pendingPlacement);
  const shown = placement !== undefined;
  useEffect(() => {
    if (shown) void loadDevice(client);
  }, [client, shown]);

  const state = toggleState(placement, { locked, pending });
  if (!state) return null;
  // Always wrapped (not DisabledReason), so disabling it doesn't remount it mid-slide.
  return (
    <span className="disabled-reason" data-tooltip={state.disabled ?? undefined}>
      <Switch
        checked={state.remote}
        onChange={(remote) =>
          void setPlacement(client, remote ? "always_on_machine" : "this_device")
        }
        label="Remote"
        disabled={state.disabled !== null}
        tooltip={
          state.remote
            ? "Run the orchestrator on this device"
            : "Run the orchestrator on your always-on machine"
        }
        testId={testId}
      />
    </span>
  );
}
