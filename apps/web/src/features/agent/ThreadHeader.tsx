import { isActiveTaskStatus, isOrchestratorThread, stem } from "@ddl/core";
import { ArrowLeft, NotebookPen, Repeat, RotateCcw, Square, X } from "lucide-react";
import { useServices } from "../../app/services";
import { DisabledReason } from "../../components/DisabledReason";
import { IconButton } from "../../components/IconButton";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { useReadOnlyReason } from "../remote/read-only";
import { repeatDraft } from "../routines/repeat";
import { StatusChip } from "./StatusChip";

export function ThreadHeader({ threadId }: { threadId: string }) {
  const { agent } = useServices();
  const readOnly = useReadOnlyReason();
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
  const taskId = useAgentStore(
    (s) => s.details[threadId]?.taskId ?? s.threads[threadId]?.taskId ?? null,
  );
  const active = isActiveTaskStatus(status);
  // A routine runs again with its Run now, which counts against its extra runs for the day.
  const canRetry =
    !routineId && (status === "failed" || status === "cancelled" || status === "done");
  const canRepeat =
    status === "done" && taskId !== null && !routineId && !isOrchestratorThread(threadId);

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
          <DisabledReason reason={readOnly}>
            <IconButton
              icon={Square}
              command="agent:stop"
              disabled={readOnly !== null}
              onClick={() => void agent.cancel(threadId)}
              data-testid="thread-stop"
            />
          </DisabledReason>
        ) : null}
        {canRepeat ? (
          <IconButton
            icon={Repeat}
            label="Repeat this on a schedule"
            onClick={() => ui.newRoutine(repeatDraft({ id: threadId, title }))}
            data-testid="thread-repeat"
          />
        ) : null}
        {canRetry ? (
          <DisabledReason reason={readOnly}>
            <IconButton
              icon={RotateCcw}
              label="Retry"
              disabled={readOnly !== null}
              onClick={() => void agent.retry(threadId)}
              data-testid="thread-retry"
            />
          </DisabledReason>
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
