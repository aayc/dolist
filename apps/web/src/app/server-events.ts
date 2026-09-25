import type { ServerEvent } from "@ddl/core";
import { uncitedLinks } from "../features/links/link-previews";
import { dispatchAgentEvent, useAgentStore } from "../state/agent-store";
import { applyImportJob } from "../state/obsidian-import-store";
import { applyRoutinesChanged, updateRoutines } from "../state/routines-store";
import { applySettings } from "../state/settings-store";
import { applySurfaceFrame } from "../state/surface-store";
import { announceApproval } from "./approval-toasts";
import { announceImportEnd } from "./import-toasts";
import { announceRoutineRun } from "./routine-toasts";
import type { Services } from "./services";

/** Routes daemon push events into the stores/controllers. */
export function handleServerEvent(event: ServerEvent, services: Services): void {
  switch (event.type) {
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
    case "hello":
      return;
    case "error":
      console.warn("[daemon]", event.message);
      return;
    default:
      dispatchAgentEvent(event);
  }
}
