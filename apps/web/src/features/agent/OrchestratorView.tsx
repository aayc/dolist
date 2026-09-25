import {
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  type StatusMessage,
  type ThreadMessage,
} from "@ddl/core";
import { ArrowDown, ArrowLeft, Brain, CornerDownRight, Square, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useServices } from "../../app/services";
import { Count } from "../../components/Count";
import { DisabledReason } from "../../components/DisabledReason";
import { IconButton } from "../../components/IconButton";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { perfEndAfterPaint, perfPending } from "../../perf/perf";
import { useAgentStore } from "../../state/agent-store";
import {
  discardMessage,
  matchPending,
  type PostMessage,
  pendingOf,
  pruneConfirmed,
  retryMessage,
  useOutboxStore,
} from "../../state/outbox-store";
import { ui, useUiStore } from "../../state/ui-store";
import { useReadOnlyReason } from "../remote/read-only";
import { ActivityRow } from "./ActivityRow";
import { Composer } from "./Composer";
import { installCodeCopy } from "./code-copy";
import { MessageRow } from "./MessageRow";
import { useMarkdownLinks } from "./markdown-links";
import { resolveTask, taskIdOf } from "./orchestrator-links";
import { PendingReply } from "./PendingReply";
import { StatusChip } from "./StatusChip";
import { useChatScroll } from "./use-chat-scroll";
import "../../styles/orchestrator.css";

const THREAD_ID = ORCHESTRATOR_THREAD_ID;
const NO_MESSAGES: readonly ThreadMessage[] = [];
/** A turn asked for that isn't in the chat (yet) stops being waited for after this. */
const FOCUS_WAIT_MS = 5_000;

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
  const readOnly = useReadOnlyReason();
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
          <DisabledReason reason={readOnly}>
            <IconButton
              icon={Square}
              label="Stop this run"
              disabled={readOnly !== null}
              onClick={() => void agent.cancel(THREAD_ID)}
              data-testid="thread-stop"
            />
          </DisabledReason>
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

/**
 * Like a task's chat tab (typing reveal, activity row, jump to latest, optimistic replies), except
 * that decisions stay one per row with their task link instead of folding into a tool group.
 */
function OrchestratorChat() {
  const { agent } = useServices();
  const messages = useAgentStore((s) => s.details[THREAD_ID]?.messages ?? NO_MESSAGES);
  const pending = useOutboxStore((s) => pendingOf(s, THREAD_ID));
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // What was there when the chat opened is history: it renders at once, without animation.
  const history = useRef<ReadonlySet<string> | null>(null);
  history.current ??= new Set(messages.map((m) => m.id));
  const seen = history.current;
  useMarkdownLinks(scrollRef, THREAD_ID);
  const scroll = useChatScroll(scrollRef, contentRef, messages);

  useEffect(() => {
    const root = scrollRef.current;
    return root ? installCodeCopy(root) : undefined;
  }, []);

  // Opened at a turn (an activity chip, the note's indicator): show where that turn starts.
  const focus = useUiStore((s) => s.chatFocus);
  const { showMessage } = scroll;
  useEffect(() => {
    if (!focus) return;
    const arrived = messages.some((m) => m.id === focus.messageId);
    if ((arrived && showMessage(focus.messageId)) || Date.now() - focus.at > FOCUS_WAIT_MS) {
      ui.set({ chatFocus: null });
    }
  }, [focus, messages, showMessage]);

  const unconfirmed = useMemo(
    () => matchPending(pending, messages).unconfirmed,
    [pending, messages],
  );
  useEffect(() => {
    if (pending.length > 0) pruneConfirmed(THREAD_ID, messages);
  }, [messages, pending]);

  const post: PostMessage = useCallback((id, text) => agent.postMessage(id, text), [agent]);

  return (
    <div className="chat">
      <div className="chat-main">
        <div
          ref={scrollRef}
          className="chat-scroll"
          onScroll={scroll.onScroll}
          onWheel={scroll.onWheel}
          data-testid="chat-scroll"
        >
          <div ref={contentRef} className="chat-list" data-testid="chat-list">
            {messages.length === 0 && unconfirmed.length === 0 ? (
              <p className="orchestrator-empty" data-testid="orchestrator-empty">
                Each time the orchestrator wakes up — a task changed, you replied, a subagent
                finished — what it decided shows up here. Write to it below: ask what it's doing, or
                tell it what to change.
              </p>
            ) : null}
            {messages.map((message) => (
              <OrchestratorRow key={message.id} message={message} live={!seen.has(message.id)} />
            ))}
            {unconfirmed.map((item) => (
              <PendingReply
                key={item.id}
                item={item}
                onRetry={() => void retryMessage(post, THREAD_ID, item.id)}
                onDiscard={() => discardMessage(THREAD_ID, item.id)}
              />
            ))}
            <ActivityRow threadId={THREAD_ID} onShowApproval={scroll.showApproval} />
          </div>
        </div>
        <button
          type="button"
          className={cx("jump-latest", !scroll.pinned && "is-visible")}
          onClick={scroll.jumpToLatest}
          data-testid="jump-latest"
        >
          <ArrowDown size={14} aria-hidden="true" />
          Jump to latest
          {scroll.newCount > 0 ? (
            <span className="jump-latest-count">
              <Count value={scroll.newCount} className="jump-latest-number" /> new
            </span>
          ) : null}
        </button>
      </div>
      <Composer threadId={THREAD_ID} post={post} onSend={scroll.jumpToLatest} />
    </div>
  );
}

const OrchestratorRow = memo(function OrchestratorRow({
  message,
  live,
}: {
  message: ThreadMessage;
  live: boolean;
}) {
  if (message.kind === "status" && message.author === "orchestrator") {
    return <ThoughtRow message={message} />;
  }
  const taskId = taskIdOf(message);
  if (!taskId) return <MessageRow threadId={THREAD_ID} message={message} live={live} />;
  return (
    <div className="orchestrator-tool">
      <MessageRow threadId={THREAD_ID} message={message} live={live} />
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
