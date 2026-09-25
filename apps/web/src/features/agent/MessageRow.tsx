import type { StatusMessage, TextMessage, ThreadMessage } from "@ddl/core";
import { memo, useRef } from "react";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { useAgentStore } from "../../state/agent-store";
import { AgentText, findTextMessage } from "./AgentText";
import { ApprovalCard } from "./ApprovalCard";
import { ArtifactCard } from "./ArtifactCard";
import { CopyButton } from "./CopyButton";
import { authorLabel, STATUS_META } from "./status-meta";
import { ToolCallRow } from "./ToolCallRow";

interface MessageRowProps {
  threadId: string;
  message: ThreadMessage;
  /** Arrived while the thread is on screen: it enters with a short fade (history doesn't). */
  live: boolean;
}

/** Agent text paints its own updates from the store (see `AgentText`), so its row never re-renders. */
function sameRow(a: MessageRowProps, b: MessageRowProps): boolean {
  if (a.threadId !== b.threadId || a.live !== b.live) return false;
  if (a.message === b.message) return true;
  return (
    a.message.kind === "text" &&
    b.message.kind === "text" &&
    a.message.id === b.message.id &&
    a.message.role !== "user" &&
    b.message.role !== "user"
  );
}

export const MessageRow = memo(function MessageRow({ threadId, message, live }: MessageRowProps) {
  const entering = live ? "is-entering" : undefined;
  switch (message.kind) {
    case "text":
      return message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AgentMessage threadId={threadId} message={message} live={live} />
      );
    case "tool_call":
      return <ToolCallRow message={message} live={live} className={entering} />;
    case "status":
      return <StatusDivider message={message} className={entering} />;
    case "approval":
      return <ApprovalSlot approvalId={message.approvalId} live={live} />;
    case "artifact":
      return (
        <ArtifactCard threadId={threadId} artifactId={message.artifactId} className={entering} />
      );
  }
}, sameRow);

function MessageTime({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{formatTimestamp(at)}</time>;
}

function AgentMessage({
  threadId,
  message,
  live,
}: {
  threadId: string;
  message: TextMessage;
  live: boolean;
}) {
  return (
    <div
      className={cx(
        "message",
        "is-agent",
        message.role === "system" && "is-system",
        live && "is-entering",
      )}
      data-testid="message-text"
    >
      <div className="message-author">
        {authorLabel(message.author)}
        <MessageTime at={message.createdAt} />
        <span className="message-actions">
          <CopyButton
            getText={() =>
              findTextMessage(useAgentStore.getState().details[threadId], message.id)?.text ??
              message.text
            }
          />
        </span>
      </div>
      <div className="message-body">
        <AgentText threadId={threadId} message={message} live={live} />
      </div>
    </div>
  );
}

/** Your reply: its time and a copy button show beside it on hover. */
export function UserMessage({ message }: { message: Pick<TextMessage, "text" | "createdAt"> }) {
  return (
    <div className="message is-user" data-testid="message-text">
      <div className="message-line">
        <div className="message-meta">
          <MessageTime at={message.createdAt} />
          <CopyButton getText={() => message.text} />
        </div>
        <div className="message-bubble message-body">
          <p className="message-plain">{message.text}</p>
        </div>
      </div>
    </div>
  );
}

function StatusDivider({ message, className }: { message: StatusMessage; className?: string }) {
  return (
    <div
      className={cx("status-divider", `tone-${STATUS_META[message.status].tone}`, className)}
      data-testid="status-divider"
      data-message-id={message.id}
    >
      <span>{message.text ?? STATUS_META[message.status].label}</span>
      <MessageTime at={message.createdAt} />
    </div>
  );
}

function ApprovalSlot({ approvalId, live }: { approvalId: string; live: boolean }) {
  const approval = useAgentStore((s) => s.approvals[approvalId]);
  // Only a card that arrives while you watch asks for attention; history stays still.
  const arriving = useRef(live);
  if (!approval) return <div className="approval-card is-loading" aria-busy="true" />;
  return <ApprovalCard approval={approval} arriving={arriving.current} />;
}
