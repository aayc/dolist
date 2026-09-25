import { Clock, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/shallow";
import { useAgentStore } from "../../state/agent-store";
import { ACTIVITY_TEXT, type Activity, deriveActivity, pendingApprovalOf } from "./activity";
import { useRevealStore } from "./reveal-store";
import { toolIcon } from "./tool-icons";

/** The step's elapsed time shows from this many seconds on. */
const ELAPSED_AFTER_S = 3;

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "· 12s" once the current step has taken 3 s, ticking once a second (and only while shown). */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const into = (((Date.now() - since) % 1000) + 1000) % 1000;
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        Math.max(16, 1000 - into),
      );
    };
    setNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [since]);
  const seconds = Math.floor((now - since) / 1000);
  if (seconds < ELAPSED_AFTER_S) return null;
  return (
    <span className="chat-activity-elapsed" data-testid="chat-activity-elapsed">
      · {formatElapsed(seconds)}
    </span>
  );
}

function stepKey(activity: Activity | null): string {
  if (!activity) return "";
  if (activity.kind === "tool") return `tool:${activity.messageId}`;
  if (activity.kind === "approval") return `approval:${activity.approvalId ?? ""}`;
  return activity.kind;
}

/**
 * What the agent is doing right now, at the end of the chat while it's queued or running: waiting
 * for your approval (click to see the card), the running tool, or thinking; nothing while its text
 * types out.
 */
export function ActivityRow({
  threadId,
  onShowApproval,
}: {
  threadId: string;
  onShowApproval: (approvalId: string) => void;
}) {
  const revealing = useRevealStore((s) => (s.revealing[threadId] ?? 0) > 0);
  const activity = useAgentStore(
    useShallow((s) => {
      const thread = s.details[threadId];
      return deriveActivity({
        status: thread?.status ?? s.threads[threadId]?.status ?? "idle",
        messages: thread?.messages ?? [],
        approval: pendingApprovalOf(s.approvals, threadId),
        revealing,
      });
    }),
  );
  const key = stepKey(activity);
  // Queued and thinking have no timestamp of their own: count from when the step showed here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step restarts the count
  const shownAt = useMemo(() => Date.now(), [key]);

  return (
    <div className="chat-activity-slot" role="status" aria-live="polite">
      {activity ? (
        <ActivityContent
          activity={activity}
          since={Math.min(Date.now(), activityStart(activity) ?? shownAt)}
          onShowApproval={onShowApproval}
        />
      ) : null}
    </div>
  );
}

function activityStart(activity: Activity): number | null {
  if (activity.kind === "tool") return activity.since;
  if (activity.kind === "approval") return activity.since;
  return null;
}

function ActivityContent({
  activity,
  since,
  onShowApproval,
}: {
  activity: Activity;
  since: number;
  onShowApproval: (approvalId: string) => void;
}) {
  const label =
    activity.kind === "tool"
      ? activity.label
      : activity.kind === "approval"
        ? ACTIVITY_TEXT.approval
        : activity.kind === "queued"
          ? ACTIVITY_TEXT.queued
          : ACTIVITY_TEXT.thinking;
  const content = (
    <>
      <ActivityIcon activity={activity} />
      <span key={label} className="chat-activity-label">
        {label}
      </span>
      <Elapsed since={since} />
    </>
  );
  const common = {
    className: `chat-activity is-${activity.kind}`,
    "data-testid": "chat-activity",
    "data-kind": activity.kind,
  };
  if (activity.kind === "approval" && activity.approvalId) {
    const { approvalId } = activity;
    return (
      <button type="button" {...common} onClick={() => onShowApproval(approvalId)}>
        {content}
      </button>
    );
  }
  return <div {...common}>{content}</div>;
}

function ActivityIcon({ activity }: { activity: Activity }) {
  switch (activity.kind) {
    case "approval":
      return <ShieldAlert size={14} className="chat-activity-icon" aria-hidden="true" />;
    case "tool": {
      // The tool's row above already spins; here its icon breathes.
      const Icon = toolIcon(activity.toolName);
      return <Icon size={14} className="chat-activity-icon" aria-hidden="true" />;
    }
    case "queued":
      return <Clock size={14} className="chat-activity-icon" aria-hidden="true" />;
    case "thinking":
      return (
        <span className="thinking-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      );
  }
}
