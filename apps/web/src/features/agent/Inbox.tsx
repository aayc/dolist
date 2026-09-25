import { stem, type ThreadSummary } from "@ddl/core";
import { Inbox as InboxIcon, X } from "lucide-react";
import { memo, useMemo } from "react";
import { useServices } from "../../app/services";
import { Count } from "../../components/Count";
import { IconButton } from "../../components/IconButton";
import { formatTimestamp } from "../../lib/format";
import { perfStart } from "../../perf/perf";
import { findRecordIn } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { AgentLocation } from "../remote/AgentLocation";
import { RoutinesInboxRow } from "../routines/RoutinesInboxRow";
import { OrchestratorInboxRow } from "./OrchestratorInboxRow";
import { StatusChip } from "./StatusChip";
import { groupThreads, INBOX_GROUPS, isInboxThread } from "./status-meta";

export function Inbox() {
  const threads = useAgentStore((s) => s.threads);
  const groups = useMemo(
    () => groupThreads(Object.values(threads).filter(isInboxThread)),
    [threads],
  );
  const total = INBOX_GROUPS.reduce((sum, g) => sum + groups[g.key].length, 0);

  return (
    <div className="inbox" data-testid="inbox">
      <header className="panel-header" data-tooltip-placement="bottom">
        <span className="panel-title">Agent inbox</span>
        <IconButton
          icon={X}
          label="Close agent panel"
          command="panel:right"
          onClick={() => ui.set({ rightOpen: false })}
        />
      </header>
      <AgentLocation />
      <div className="inbox-scroll">
        <OrchestratorInboxRow />
        <RoutinesInboxRow />
        {total === 0 ? (
          <div className="inbox-empty">
            <InboxIcon size={28} strokeWidth={1.5} aria-hidden="true" />
            <p>Nothing here yet today.</p>
            <p className="muted">
              Write a task in today's daily note and the agent will pick it up.
            </p>
          </div>
        ) : null}
        {INBOX_GROUPS.map(({ key, label }) =>
          groups[key].length === 0 ? null : (
            <section key={key} className="inbox-group" data-testid={`inbox-group-${key}`}>
              <h3 className="inbox-group-title">
                {label}
                <Count value={groups[key].length} className="inbox-count" />
              </h3>
              {groups[key].map((thread) => (
                <InboxItem key={thread.id} thread={thread} />
              ))}
            </section>
          ),
        )}
      </div>
    </div>
  );
}

const InboxItem = memo(function InboxItem({ thread }: { thread: ThreadSummary }) {
  const { agent } = useServices();
  const unread = useAgentStore((s) =>
    thread.taskId ? (findRecordIn(s.records, thread.taskId)?.unread ?? 0) : 0,
  );
  return (
    <button
      type="button"
      className="inbox-item"
      data-testid="inbox-item"
      data-thread-id={thread.id}
      data-tooltip={thread.title}
      data-tooltip-overflow=".inbox-item-title"
      onClick={(event) => {
        perfStart("thread:open", event.timeStamp);
        agent.openThread(thread.id);
      }}
    >
      <span className="inbox-item-top">
        <span className="inbox-item-title">{thread.title}</span>
        {unread > 0 ? (
          <span className="unread-dot" data-tooltip={`${unread} unread`}>
            <span className="sr-only">{unread} unread</span>
          </span>
        ) : null}
      </span>
      {thread.lastMessagePreview ? (
        <span className="inbox-item-preview">
          {thread.lastMessagePreview.replace(/[*_`#>]/g, "")}
        </span>
      ) : null}
      <span className="inbox-item-meta">
        <StatusChip status={thread.status} />
        {thread.routineId ? (
          <span className="inbox-note">Routine run</span>
        ) : thread.notePath ? (
          <span className="inbox-note">{stem(thread.notePath)}</span>
        ) : null}
        <time className="inbox-time">{formatTimestamp(thread.updatedAt)}</time>
      </span>
    </button>
  );
});
