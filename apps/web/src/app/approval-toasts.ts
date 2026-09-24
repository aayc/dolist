import type { ApprovalRequest } from "@ddl/core";
import { useAgentStore } from "../state/agent-store";
import { dismissToast, toast } from "../state/toast-store";
import { ui } from "../state/ui-store";
import type { AgentActions } from "./agent-actions";

function toastId(approvalId: string): string {
  return `approval-${approvalId}`;
}

function threadOnScreen(threadId: string | null): boolean {
  const { rightOpen, rightView } = ui.get();
  return rightOpen && rightView.kind === "thread" && rightView.threadId === threadId;
}

/** Toast for an approval that just became pending (called for pushed events only, not snapshots). */
export function announceApproval(approval: ApprovalRequest, agent: AgentActions): void {
  const previous = useAgentStore.getState().approvals[approval.id];
  if (approval.status !== "pending" || previous?.status === "pending") return;
  if (threadOnScreen(approval.threadId)) return;
  const threadId = approval.threadId;
  toast({
    id: toastId(approval.id),
    kind: "approval",
    title: "Approval needed",
    body: approval.summary,
    actionLabel: "Review",
    timeoutMs: 15_000,
    onClick: () => (threadId ? agent.openThread(threadId) : agent.openInbox()),
  });
}

/** Removes approval toasts as soon as the approval stops being pending, whatever decided it. */
export function installApprovalToastCleanup(): () => void {
  return useAgentStore.subscribe((state, previous) => {
    if (state.approvals === previous.approvals) return;
    for (const approval of Object.values(state.approvals)) {
      if (approval.status !== "pending" && previous.approvals[approval.id]?.status === "pending") {
        dismissToast(toastId(approval.id));
      }
    }
  });
}
