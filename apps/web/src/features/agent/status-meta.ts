import {
  type ActionCategory,
  isOrchestratorThread,
  type TaskAgentStatus,
  type ThreadSummary,
} from "@ddl/core";
import { isSameLocalDay } from "../../lib/format";

export type Tone = "accent" | "faint" | "info" | "warning" | "success" | "danger";

export const STATUS_META: Record<TaskAgentStatus, { label: string; tone: Tone; pulse?: boolean }> =
  {
    idle: { label: "Idle", tone: "faint" },
    triaging: { label: "Triaging", tone: "accent", pulse: true },
    queued: { label: "Queued", tone: "faint" },
    working: { label: "Working", tone: "info", pulse: true },
    waiting_approval: { label: "Needs approval", tone: "warning" },
    waiting_user: { label: "Needs you", tone: "warning" },
    done: { label: "Done", tone: "success" },
    failed: { label: "Failed", tone: "danger" },
    cancelled: { label: "Stopped", tone: "faint" },
    ignored: { label: "Ignored", tone: "faint" },
  };

export const CATEGORY_LABELS: Record<ActionCategory, string> = {
  read: "Read",
  compute: "Compute",
  network: "Network",
  file_write: "Writes files",
  browser_input: "Browser input",
  form_submission: "Submits a form",
  computer_control: "Controls the computer",
  communication: "Contacts someone",
  publishing: "Publishes",
  payment: "Spends money",
  booking: "Makes a booking",
  account: "Account change",
  credentials: "Credentials",
  privacy: "Privacy",
  destructive: "Destructive",
  system: "System",
  unknown: "Unknown",
};

export type InboxGroup = "needs_you" | "working" | "done" | "other";

export const INBOX_GROUPS: ReadonlyArray<{ key: InboxGroup; label: string }> = [
  { key: "needs_you", label: "Needs you" },
  { key: "working", label: "Working" },
  { key: "done", label: "Done" },
  { key: "other", label: "Other" },
];

export function inboxGroupOf(
  thread: Pick<ThreadSummary, "status" | "pendingApprovals">,
): InboxGroup {
  if (thread.pendingApprovals > 0) return "needs_you";
  switch (thread.status) {
    case "waiting_approval":
    case "waiting_user":
      return "needs_you";
    case "triaging":
    case "queued":
    case "working":
      return "working";
    case "done":
      return "done";
    default:
      return "other";
  }
}

/**
 * What the agent inbox lists: task threads (the orchestrator's chat is pinned above them). A
 * routine's runs live in their routine's own inbox, except while one waits for you.
 */
export function isInboxThread(
  thread: Pick<ThreadSummary, "id" | "routineId" | "status" | "pendingApprovals">,
): boolean {
  if (isOrchestratorThread(thread.id)) return false;
  return thread.routineId === undefined || inboxGroupOf(thread) === "needs_you";
}

/** Today's threads (plus anything still waiting on the user), grouped and newest first. */
export function groupThreads(
  threads: readonly ThreadSummary[],
  now: number = Date.now(),
): Record<InboxGroup, ThreadSummary[]> {
  const groups: Record<InboxGroup, ThreadSummary[]> = {
    needs_you: [],
    working: [],
    done: [],
    other: [],
  };
  for (const thread of threads) {
    const group = inboxGroupOf(thread);
    const recent = isSameLocalDay(thread.updatedAt, now) || isSameLocalDay(thread.createdAt, now);
    if (!recent && group !== "needs_you" && group !== "working") continue;
    groups[group].push(thread);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

export function authorLabel(author: string): string {
  if (author === "orchestrator") return "Orchestrator";
  if (author === "you") return "You";
  if (author === "system") return "System";
  if (author.startsWith("subagent:")) {
    const name = author.slice("subagent:".length);
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} agent`;
  }
  return author;
}
