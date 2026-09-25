import type { ToolCallMessage } from "@ddl/core";
import { ChevronRight, CircleCheck, CircleX, LoaderCircle, ShieldX } from "lucide-react";
import { useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { toolIcon } from "./tool-icons";

const STATUS_LABEL: Record<ToolCallMessage["status"], string> = {
  running: "Running",
  ok: "Succeeded",
  error: "Failed",
  blocked: "Blocked by safety policy",
};

function StatusIcon({ status, settled }: { status: ToolCallMessage["status"]; settled: boolean }) {
  const props = {
    size: 14,
    "aria-label": STATUS_LABEL[status],
    "data-tooltip": STATUS_LABEL[status],
  };
  const done = cx("tool-call-status", settled && "is-settled");
  switch (status) {
    case "running":
      return <LoaderCircle {...props} className="tool-call-status spin tone-info" />;
    case "ok":
      return <CircleCheck {...props} className={cx(done, "tone-success")} />;
    case "error":
      return <CircleX {...props} className={cx(done, "tone-danger")} />;
    case "blocked":
      return <ShieldX {...props} className={cx(done, "tone-warning")} />;
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  // Long durations are usually time spent waiting for the user's approval.
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ToolCallRow({
  message,
  live = false,
  className,
}: {
  message: ToolCallMessage;
  /** Seen running: finishing plays a quick ✓ / ✕ / shield transition. */
  live?: boolean;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const sawRunning = useRef(live || message.status === "running");
  const Icon = toolIcon(message.toolName);
  const took = message.endedAt ? formatDuration(message.endedAt - message.createdAt) : null;
  return (
    <div
      className={cx("tool-call", `is-${message.status}`, className)}
      data-testid="tool-call"
      data-status={message.status}
      data-tool={message.toolName}
    >
      <button
        type="button"
        className="tool-call-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={14} className="tool-call-icon" aria-hidden="true" />
        <span className="tool-call-label">{message.label ?? message.toolName}</span>
        <code className="tool-call-name">{message.toolName}</code>
        <span className="tool-call-spacer" />
        {took ? <span className="tool-call-duration">{took}</span> : null}
        <StatusIcon status={message.status} settled={sawRunning.current} />
        <ChevronRight
          size={14}
          className={cx("tool-call-chevron", open && "is-open")}
          aria-hidden="true"
        />
      </button>
      {message.resultPreview ? (
        <div className="tool-call-preview">{message.resultPreview}</div>
      ) : null}
      {open ? (
        <pre className="tool-call-input" data-testid="tool-call-input">
          {JSON.stringify(message.input, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
