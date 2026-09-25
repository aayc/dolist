import type { AgentPlacementStatus } from "@ddl/core";
import { CloudOff, Eye } from "lucide-react";
import { useServices } from "../../app/services";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { setPlacement, useDeviceStore } from "./device-store";
import { MACHINE_IDLE, machineIdle } from "./placement";
import "../../styles/remote.css";

const SYNCED = "showing the last synced state";

type Banner =
  | { kind: "unreachable" | "not_paired" | "elsewhere" | "idle"; text: string }
  | { kind: "none" };

/** What the agent panel says when this device only shows the agent's work, read-only. */
export function availabilityBanner(placement: AgentPlacementStatus | undefined): Banner {
  if (!placement || placement.runsOn?.thisDevice) return { kind: "none" };
  if (placement.relay === "unreachable") {
    return { kind: "unreachable", text: `The always-on machine can't be reached — ${SYNCED}` };
  }
  if (placement.relay === "not_paired") {
    return {
      kind: "not_paired",
      text: `This device isn't paired with the always-on machine — ${SYNCED}`,
    };
  }
  const { runsOn } = placement;
  if (placement.note) return { kind: "none" };
  if (machineIdle(placement)) return { kind: "idle", text: `${MACHINE_IDLE} — ${SYNCED}` };
  if (!runsOn) return { kind: "none" };
  if (placement.relay === "connected" && runsOn.alwaysOnMachine) return { kind: "none" };
  if (placement.relay === "connecting") return { kind: "none" };
  return { kind: "elsewhere", text: `The agent is running on ${runsOn.name} — ${SYNCED}` };
}

/**
 * Above the agent panel while this device can't act on the agent: why, with what to do about it.
 * The threads and approvals below are the synced ones, and their actions are disabled.
 */
export function AgentAvailabilityBanner() {
  const { client } = useServices();
  const placement = useAgentStore((s) => s.status?.placement);
  const locked = useDeviceStore((s) => s.device?.lockedByEnv.includes("placement") ?? false);
  const banner = availabilityBanner(placement);
  if (banner.kind === "none") return null;
  const Icon = banner.kind === "elsewhere" || banner.kind === "idle" ? Eye : CloudOff;
  return (
    <div
      className={`agent-banner is-${banner.kind}`}
      role="status"
      data-testid="agent-banner"
      data-kind={banner.kind}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="agent-banner-text">{banner.text}</span>
      {banner.kind === "unreachable" && !locked ? (
        <button
          type="button"
          className="link-button"
          onClick={() => void setPlacement(client, "this_device")}
          data-testid="agent-banner-run-here"
        >
          Run it on this device instead
        </button>
      ) : null}
      {banner.kind === "not_paired" ? (
        <button
          type="button"
          className="link-button"
          onClick={() => ui.openOverlay({ kind: "settings", section: "machine" })}
          data-testid="agent-banner-pair"
        >
          Pair it
        </button>
      ) : null}
    </div>
  );
}
