import type { ServerEvent } from "@ddl/core";
import { dispatchAgentEvent, useAgentStore } from "../state/agent-store";
import { applySettings } from "../state/settings-store";
import { applySurfaceFrame } from "../state/surface-store";
import { announceApproval } from "./approval-toasts";
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
      if (message.kind !== "artifact") return;
      const detail = useAgentStore.getState().details[threadId];
      if (detail && !detail.artifacts.some((a) => a.id === message.artifactId)) {
        services.agent.scheduleThreadRefetch(threadId);
      }
      return;
    }
    case "hello":
      return;
    case "error":
      console.warn("[daemon]", event.message);
      return;
    default:
      dispatchAgentEvent(event);
  }
}
