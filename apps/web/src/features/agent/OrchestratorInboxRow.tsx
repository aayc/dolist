import { ORCHESTRATOR_THREAD_ID, ORCHESTRATOR_THREAD_TITLE } from "@ddl/core";
import { Bot, ShieldAlert } from "lucide-react";
import { memo } from "react";
import { useServices } from "../../app/services";
import { commandTooltip } from "../../commands/labels";
import { formatTimestamp } from "../../lib/format";
import { perfStart } from "../../perf/perf";
import { useAgentStore } from "../../state/agent-store";
import { StatusChip } from "./StatusChip";
import "../../styles/orchestrator.css";

/** Pinned at the top of the inbox: the orchestrator's own chat, with its live status. */
export const OrchestratorInboxRow = memo(function OrchestratorInboxRow() {
  const { agent, commands } = useServices();
  const summary = useAgentStore((s) => s.threads[ORCHESTRATOR_THREAD_ID]);
  const preview = summary?.lastMessagePreview?.replace(/[*_`#>]/g, "");
  const pending = summary?.pendingApprovals ?? 0;
  return (
    <button
      type="button"
      className="inbox-item orchestrator-row"
      data-testid="inbox-orchestrator"
      data-status={summary?.status ?? "idle"}
      {...commandTooltip(commands, "agent:orchestrator")}
      onClick={(event) => {
        perfStart("thread:open", event.timeStamp);
        agent.openThread(ORCHESTRATOR_THREAD_ID);
      }}
    >
      <span className="inbox-item-top">
        <Bot size={15} strokeWidth={1.75} className="orchestrator-row-icon" aria-hidden="true" />
        <span className="inbox-item-title">{ORCHESTRATOR_THREAD_TITLE}</span>
        {pending > 0 ? (
          <span className="orchestrator-row-pending">
            <ShieldAlert size={13} strokeWidth={1.75} aria-hidden="true" />
            {pending} to approve
          </span>
        ) : null}
      </span>
      <span className="inbox-item-preview">
        {preview || "Sees every task. Ask what it's doing, or tell it what to change."}
      </span>
      <span className="inbox-item-meta">
        <StatusChip status={summary?.status ?? "idle"} />
        {summary && summary.messageCount > 0 ? (
          <time className="inbox-time">{formatTimestamp(summary.updatedAt)}</time>
        ) : null}
      </span>
    </button>
  );
});
