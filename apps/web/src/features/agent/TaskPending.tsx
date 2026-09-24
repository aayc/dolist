import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { findRecordIn } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { StatusChip } from "./StatusChip";

/** Shown when a badge is clicked before the orchestrator has created a thread for the task. */
export function TaskPending({ taskId }: { taskId: string }) {
  const { agent } = useServices();
  const record = useAgentStore((s) => findRecordIn(s.records, taskId));
  const threadId = record?.threadId ?? null;

  useEffect(() => {
    if (threadId) agent.openThread(threadId);
  }, [agent, threadId]);

  return (
    <div className="thread-view" data-testid="task-pending">
      <header className="thread-header">
        <IconButton icon={ArrowLeft} label="Back to inbox" onClick={() => ui.showInbox()} />
        <div className="thread-heading">
          <h2 className="thread-title">{record?.text ?? "Task"}</h2>
          <div className="thread-meta">
            <StatusChip status={record?.status ?? "triaging"} />
          </div>
        </div>
      </header>
      <div className="thread-pending">
        <p>
          The orchestrator is looking at this task. A thread appears here as soon as work starts.
        </p>
      </div>
    </div>
  );
}
