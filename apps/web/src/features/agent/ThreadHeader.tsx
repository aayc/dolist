import { isActiveTaskStatus, stem } from "@ddl/core";
import { ArrowLeft, NotebookPen, RotateCcw, Square, X } from "lucide-react";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { StatusChip } from "./StatusChip";

export function ThreadHeader({ threadId }: { threadId: string }) {
  const { agent } = useServices();
  const title = useAgentStore(
    (s) => s.details[threadId]?.title ?? s.threads[threadId]?.title ?? "",
  );
  const status = useAgentStore(
    (s) => s.details[threadId]?.status ?? s.threads[threadId]?.status ?? "idle",
  );
  const notePath = useAgentStore(
    (s) => s.details[threadId]?.notePath ?? s.threads[threadId]?.notePath ?? null,
  );
  const routineId = useAgentStore(
    (s) => s.details[threadId]?.routineId ?? s.threads[threadId]?.routineId,
  );
  const active = isActiveTaskStatus(status);
  // A routine runs again with its Run now, which counts against its extra runs for the day.
  const canRetry =
    !routineId && (status === "failed" || status === "cancelled" || status === "done");

  return (
    <header className="thread-header" data-tooltip-placement="bottom">
      {routineId ? (
        <IconButton
          icon={ArrowLeft}
          label="Back to the routine"
          onClick={() => ui.showRoutine(routineId)}
          data-testid="thread-back"
        />
      ) : (
        <IconButton
          icon={ArrowLeft}
          label="Back to inbox"
          onClick={() => ui.showInbox()}
          data-testid="thread-back"
        />
      )}
      <div className="thread-heading">
        <h2
          className="thread-title"
          data-tooltip={title}
          data-tooltip-overflow=""
          data-testid="thread-title"
        >
          {title}
        </h2>
        <div className="thread-meta">
          <StatusChip status={status} />
          {notePath ? <span className="thread-note">{stem(notePath)}</span> : null}
        </div>
      </div>
      <div className="thread-actions">
        {active ? (
          <IconButton
            icon={Square}
            command="agent:stop"
            onClick={() => void agent.cancel(threadId)}
            data-testid="thread-stop"
          />
        ) : null}
        {canRetry ? (
          <IconButton
            icon={RotateCcw}
            label="Retry"
            onClick={() => void agent.retry(threadId)}
            data-testid="thread-retry"
          />
        ) : null}
        {notePath ? (
          <IconButton
            icon={NotebookPen}
            label={routineId ? "Open the routine's file" : "Show task in note"}
            onClick={() => void agent.revealTask(threadId)}
            data-testid="thread-open-note"
          />
        ) : null}
        <IconButton
          icon={X}
          label="Close agent panel"
          command="panel:right"
          onClick={() => ui.set({ rightOpen: false })}
          data-testid="thread-close"
        />
      </div>
    </header>
  );
}
