import {
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  type StatusMessage,
  type ThreadMessage,
} from "@ddl/core";
import { ArrowLeft, Brain, CornerDownRight, Square, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { formatTimestamp } from "../../lib/format";
import { perfEndAfterPaint, perfPending } from "../../perf/perf";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { Composer } from "./Composer";
import { MessageRow } from "./MessageRow";
import { useMarkdownLinks } from "./markdown-links";
import { resolveTask, taskIdOf } from "./orchestrator-links";
import { StatusChip } from "./StatusChip";
import "../../styles/orchestrator.css";

const THREAD_ID = ORCHESTRATOR_THREAD_ID;
const NO_MESSAGES: readonly ThreadMessage[] = [];
/** Within this distance from the bottom the list stays pinned to new content. */
const PIN_THRESHOLD_PX = 48;

/**
 * The orchestrator's own chat in the agent panel: every turn (what woke it, what it said, each
 * decision as a tool call linked to its task's thread) and a composer to write to it.
 */
export function OrchestratorView() {
  const { agent } = useServices();
  const loaded = useAgentStore((s) => THREAD_ID in s.details);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let current = true;
    // Quiet: a daemon without an agent runtime has no such thread; it's explained in place.
    void agent.loadThread(THREAD_ID, false, true).then(() => {
      if (current) setUnavailable(!(THREAD_ID in useAgentStore.getState().details));
    });
    return () => {
      current = false;
    };
  }, [agent]);

  useLayoutEffect(() => {
    if (loaded && perfPending("thread:open")) perfEndAfterPaint("thread:open");
  }, [loaded]);

  return (
    <div className="thread-view orchestrator-view" data-testid="orchestrator-view">
      <OrchestratorHeader />
      <div className="thread-body">
        {loaded ? (
          <OrchestratorChat />
        ) : unavailable ? (
          <p className="thread-pending">
            The orchestrator's chat isn't available: the agent runtime isn't running.
          </p>
        ) : (
          <div className="thread-loading" aria-busy="true" />
        )}
      </div>
    </div>
  );
}

function OrchestratorHeader() {
  const { agent } = useServices();
  const status = useAgentStore(
    (s) => s.details[THREAD_ID]?.status ?? s.threads[THREAD_ID]?.status ?? "idle",
  );
  return (
    <header className="thread-header" data-tooltip-placement="bottom">
      <IconButton
        icon={ArrowLeft}
        label="Back to inbox"
        onClick={() => ui.showInbox()}
        data-testid="thread-back"
      />
      <div className="thread-heading">
        <h2 className="thread-title" data-testid="thread-title">
          {ORCHESTRATOR_THREAD_TITLE}
        </h2>
        <div className="thread-meta">
          <StatusChip status={status} />
          <span className="orchestrator-scope">Every task, every decision</span>
        </div>
      </div>
      <div className="thread-actions">
        {status === "working" ? (
          <IconButton
            icon={Square}
            label="Stop this run"
            onClick={() => void agent.cancel(THREAD_ID)}
            data-testid="thread-stop"
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

function OrchestratorChat() {
  const messages = useAgentStore((s) => s.details[THREAD_ID]?.messages ?? NO_MESSAGES);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useMarkdownLinks(scrollRef, THREAD_ID);

  // Streaming text grows the DOM without React renders; follow it while pinned to the bottom.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    scroller.scrollTop = scroller.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="chat">
      <div
        ref={scrollRef}
        className="chat-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
        }}
      >
        <div ref={contentRef} className="chat-list" data-testid="chat-list">
          {messages.length === 0 ? (
            <p className="orchestrator-empty" data-testid="orchestrator-empty">
              Each time the orchestrator wakes up — a task changed, you replied, a subagent finished
              — what it decided shows up here. Write to it below: ask what it's doing, or tell it
              what to change.
            </p>
          ) : null}
          {messages.map((message) => (
            <OrchestratorRow key={message.id} message={message} />
          ))}
        </div>
      </div>
      <Composer threadId={THREAD_ID} />
    </div>
  );
}

const OrchestratorRow = memo(function OrchestratorRow({ message }: { message: ThreadMessage }) {
  if (message.kind === "status" && message.author === "orchestrator") {
    return <ThoughtRow message={message} />;
  }
  const taskId = taskIdOf(message);
  if (!taskId) return <MessageRow threadId={THREAD_ID} message={message} />;
  return (
    <div className="orchestrator-tool">
      <MessageRow threadId={THREAD_ID} message={message} />
      <TaskLink taskId={taskId} />
    </div>
  );
});

/** "Thought for 3 s": that it reasoned and for how long, never what. */
function ThoughtRow({ message }: { message: StatusMessage }) {
  return (
    <div className="orchestrator-thought" data-testid="orchestrator-thought">
      <Brain size={13} strokeWidth={1.75} aria-hidden="true" />
      <span>{message.text ?? "Thinking…"}</span>
      <time>{formatTimestamp(message.createdAt)}</time>
    </div>
  );
}

/** The task a decision was about; opens its thread when it has one. */
function TaskLink({ taskId }: { taskId: string }) {
  const { agent } = useServices();
  const task = useAgentStore(useShallow((s) => resolveTask(s, taskId)));
  if (!task?.title) return null;
  const { threadId, title } = task;
  if (!threadId) {
    return (
      <span className="orchestrator-task is-plain" data-testid="orchestrator-task">
        <CornerDownRight size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="orchestrator-task-title">{title}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="orchestrator-task"
      data-testid="orchestrator-task-link"
      data-task-id={taskId}
      data-tooltip="Open this task's thread"
      onClick={() => agent.openTaskThread(taskId, threadId)}
    >
      <CornerDownRight size={12} strokeWidth={1.75} aria-hidden="true" />
      <span className="orchestrator-task-title">{title}</span>
    </button>
  );
}
