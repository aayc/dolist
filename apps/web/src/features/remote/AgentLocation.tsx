import { LoaderCircle } from "lucide-react";
import { useServices } from "../../app/services";
import { cx } from "../../lib/cx";
import { useAgentStore } from "../../state/agent-store";
import { useSettingsStore } from "../../state/settings-store";
import { ui } from "../../state/ui-store";
import { setPlacement, useDeviceStore } from "./device-store";
import { PlacementToggle } from "./PlacementToggle";
import { type LocationTone, locationLine } from "./placement";

const DOT_TONE: Record<LocationTone, string> = {
  here: "tone-success",
  machine: "tone-info",
  other: "tone-accent",
  idle: "tone-faint",
  busy: "tone-info",
  warning: "tone-warning",
  danger: "tone-danger",
};

/** Under the agent panel's header: the orchestrator toggle and where the agent runs now. */
export function AgentLocation() {
  const relay = useAgentStore((s) => s.status?.placement?.relay);
  if (!relay) return null;
  return (
    <div className="agent-location" data-testid="agent-location" data-relay={relay}>
      <PlacementToggle />
      <LocationStatus />
    </div>
  );
}

/** What's happening now (a handover, who runs it, a problem), with what to do about it. */
export function LocationStatus({ testId = "agent-location-line" }: { testId?: string }) {
  const { client } = useServices();
  const placement = useAgentStore((s) => s.status?.placement);
  const readiness = useAgentStore((s) => s.status?.readiness);
  const machineName = useSettingsStore((s) => s.settings.remote?.alwaysOnMachine?.name);
  const error = useDeviceStore((s) => s.placementError);
  const locked = useDeviceStore((s) => s.device?.lockedByEnv.includes("placement") ?? false);
  if (!placement) return null;
  const line = locationLine(placement, { machineName, readiness, error, locked });
  const { action } = line;
  return (
    <div
      className={cx("agent-location-line", DOT_TONE[line.tone])}
      role="status"
      data-testid={testId}
      data-kind={line.kind}
    >
      {line.kind === "note" || line.kind === "connecting" ? (
        <LoaderCircle size={12} className="spin agent-location-spinner" aria-hidden="true" />
      ) : (
        <span className="agent-location-dot" aria-hidden="true" />
      )}
      <span
        className="agent-location-text"
        data-tooltip={line.detail}
        data-testid={`${testId}-text`}
      >
        {line.text}
      </span>
      {action ? (
        <button
          type="button"
          className="link-button agent-location-action"
          data-testid={`${testId}-action`}
          onClick={() => {
            if (action.kind === "run_here") void setPlacement(client, "this_device");
            else ui.openOverlay({ kind: "settings", section: action.section });
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
