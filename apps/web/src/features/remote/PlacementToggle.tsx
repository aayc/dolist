import { Server } from "lucide-react";
import { useEffect } from "react";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { useAgentStore } from "../../state/agent-store";
import { loadDevice, setPlacement, useDeviceStore } from "./device-store";
import { PLACEMENT_CHOICES, toggleState } from "./placement";
import "../../styles/remote.css";

/**
 * "Where the orchestrator runs": This device or the always-on machine, one click away. While it
 * can't be switched (held here, or set by an environment variable) it's disabled and its tooltip
 * says why; on the always-on machine itself it says so instead.
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
  if (state.kind === "hidden") return null;
  if (state.kind === "host") {
    return (
      <div className="placement-host" data-testid="placement-host">
        <Server size={14} aria-hidden="true" />
        This is the always-on machine
      </div>
    );
  }
  return (
    <div
      className={cx("placement-toggle", state.disabled && "is-held")}
      data-tooltip={state.disabled ?? undefined}
      data-testid={testId}
      data-selected={state.selected}
      data-disabled={state.disabled ? "true" : undefined}
    >
      <fieldset className="segmented">
        <legend className="sr-only">Where the orchestrator runs</legend>
        {PLACEMENT_CHOICES.map(({ value, label }) => {
          const active = state.selected === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              className={cx("segmented-item", active && "is-active")}
              disabled={state.disabled !== null || state.saving}
              onClick={() => {
                if (!active) void setPlacement(client, value);
              }}
              data-testid={`${testId}-${value}`}
            >
              {label}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}
