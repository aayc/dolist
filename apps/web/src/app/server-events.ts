import type { AgentStatusResponse, ServerEvent } from "@ddl/core";
import { uncitedLinks } from "../features/links/link-previews";
import { applyActivity } from "../state/activity-store";
import { dispatchAgentEvent, useAgentStore } from "../state/agent-store";
import { applyImportJob } from "../state/obsidian-import-store";
import { applyRoutinesChanged, updateRoutines } from "../state/routines-store";
import { applySettings } from "../state/settings-store";
import { applySurfaceFrame } from "../state/surface-store";
import { announceApproval } from "./approval-toasts";
import { announceImportEnd } from "./import-toasts";
import { announceRoutineRun } from "./routine-toasts";
import type { Services } from "./services";

/** Coalesces a flapping relay (connecting, then connected) into one refetch. */
const REFETCH_DELAY_MS = 200;

/**
 * Where the agent's threads come from: the relay's state and the device that runs the agent. When
 * it changes (relayed, or no longer), the daemon pushes the machine's status, approvals, thread
 * summaries and routines, but not thread details or task records, so the panel fetches again.
 */
function agentSource(status: AgentStatusResponse): string | undefined {
  const placement = status.placement;
  return placement ? `${placement.relay}\u0000${placement.runsOn?.deviceId ?? ""}` : undefined;
}

let lastAgentSource: string | undefined;
let refetchTimer: ReturnType<typeof setTimeout> | undefined;

function followAgentSource(status: AgentStatusResponse, services: Services): void {
  const source = agentSource(status);
  const moved = lastAgentSource !== undefined && source !== lastAgentSource;
  lastAgentSource = source;
  if (!moved) return;
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(() => void services.agent.resync(), REFETCH_DELAY_MS);
}

/** Routes daemon push events into the stores/controllers. */
export function handleServerEvent(event: ServerEvent, services: Services): void {
  switch (event.type) {
    case "agent.status":
      followAgentSource(event.status, services);
      dispatchAgentEvent(event);
      return;
    case "vault.changed":
      services.workspace.handleVaultChanged(event);
      return;
    case "settings.changed":
      applySettings(event.settings);
      return;
    case "surface.frame":
      applySurfaceFrame(event);
      return;
    case "approval.upsert":
      announceApproval(event.approval, services.agent);
      dispatchAgentEvent(event);
      return;
    case "thread.message": {
      dispatchAgentEvent(event);
      const { message, threadId } = event;
      const detail = useAgentStore.getState().details[threadId];
      if (!detail) return;
      // Artifact metadata and cited sources only come with the full thread.
      const stale =
        message.kind === "artifact"
          ? !detail.artifacts.some((a) => a.id === message.artifactId)
          : message.kind === "text" &&
            message.role === "agent" &&
            !message.streaming &&
            uncitedLinks(message.text, detail.sources).length > 0;
      if (stale) services.agent.scheduleThreadRefetch(threadId);
      return;
    }
    case "routines.changed":
      updateRoutines((state) => applyRoutinesChanged(state, event.routines));
      return;
    case "routine.notification":
      announceRoutineRun(event.notification, services.agent);
      return;
    case "import.progress":
      applyImportJob(event.job);
      announceImportEnd(event.job);
      return;
    case "orchestrator.activity":
      applyActivity(event.activity);
      return;
    case "hello":
      return;
    case "error":
      console.warn("[daemon]", event.message);
      return;
    default:
      dispatchAgentEvent(event);
  }
}
