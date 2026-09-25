import type { RoutineNotification, TaskAgentStatus } from "@ddl/core";
import { type ToastKind, toast } from "../state/toast-store";
import { ui } from "../state/ui-store";
import type { AgentActions } from "./agent-actions";

function kindOf(status: TaskAgentStatus): ToastKind {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "error";
    case "waiting_user":
    case "waiting_approval":
      return "warning";
    default:
      return "info";
  }
}

/** The run (or its routine's inbox, where the run's row updates live) is what the panel shows. */
function runOnScreen({ threadId, routineId }: RoutineNotification): boolean {
  const { rightOpen, rightView } = ui.get();
  if (!rightOpen) return false;
  return (
    (rightView.kind === "thread" && rightView.threadId === threadId) ||
    (rightView.kind === "routine" && rightView.routineId === routineId)
  );
}

/** A finished run the daemon says to tell the user about (per the routine's `notify`). */
export function announceRoutineRun(
  notification: RoutineNotification,
  agent: Pick<AgentActions, "openThread">,
): void {
  if (runOnScreen(notification)) return;
  const { threadId } = notification;
  toast({
    id: `routine-${threadId}`,
    kind: kindOf(notification.status),
    title: notification.title,
    body: notification.body,
    actionLabel: "Open",
    timeoutMs: 10_000,
    onClick: () => agent.openThread(threadId),
  });
}
