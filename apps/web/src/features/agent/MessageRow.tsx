import type { StatusMessage, TextMessage, ThreadMessage } from "@ddl/core";
import { memo } from "react";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { useAgentStore } from "../../state/agent-store";
import { ApprovalCard } from "./ApprovalCard";
import { ArtifactCard } from "./ArtifactCard";
import { Markdown } from "./Markdown";
import { StreamingText } from "./StreamingText";
import { authorLabel, STATUS_META } from "./status-meta";
import { ToolCallRow } from "./ToolCallRow";

interface MessageRowProps {
  threadId: string;
  message: ThreadMessage;
}

/** While a text message streams, its deltas are painted in place by <StreamingText>, so the row skips re-renders. */
function sameRow(a: MessageRowProps, b: MessageRowProps): boolean {
  if (a.threadId !== b.threadId) return false;
  if (a.message === b.message) return true;
  return (
    a.message.kind === "text" &&
    b.message.kind === "text" &&
    a.message.id === b.message.id &&
    a.message.streaming === true &&
    b.message.streaming === true
  );
}

export const MessageRow = memo(function MessageRow({ threadId, message }: MessageRowProps) {
  switch (message.kind) {
    case "text":
      return <TextMessageView threadId={threadId} message={message} />;
    case "tool_call":
      return <ToolCallRow message={message} />;
    case "status":
      return <StatusDivider message={message} />;
    case "approval":
      return <ApprovalSlot approvalId={message.approvalId} />;
    case "artifact":
      return <ArtifactCard threadId={threadId} artifactId={message.artifactId} />;
  }
}, sameRow);

function TextMessageView({ threadId, message }: { threadId: string; message: TextMessage }) {
  const mine = message.role === "user";
  return (
    <div
      className={cx(
        "message",
        mine ? "is-user" : "is-agent",
        message.role === "system" && "is-system",
      )}
      data-testid="message-text"
      data-streaming={message.streaming ? "true" : "false"}
    >
      {mine ? null : (
        <div className="message-author">
          {authorLabel(message.author)}
          <time>{formatTimestamp(message.createdAt)}</time>
        </div>
      )}
      <div className="message-body">
        {message.streaming ? (
          <StreamingText threadId={threadId} messageId={message.id} />
        ) : mine ? (
          <p className="message-plain">{message.text}</p>
        ) : (
          <Markdown source={message.text} />
        )}
      </div>
    </div>
  );
}

function StatusDivider({ message }: { message: StatusMessage }) {
  return (
    <div
      className={cx("status-divider", `tone-${STATUS_META[message.status].tone}`)}
      data-testid="status-divider"
    >
      <span>{message.text ?? STATUS_META[message.status].label}</span>
      <time>{formatTimestamp(message.createdAt)}</time>
    </div>
  );
}

function ApprovalSlot({ approvalId }: { approvalId: string }) {
  const approval = useAgentStore((s) => s.approvals[approvalId]);
  if (!approval) return <div className="approval-card is-loading" aria-busy="true" />;
  return <ApprovalCard approval={approval} />;
}
