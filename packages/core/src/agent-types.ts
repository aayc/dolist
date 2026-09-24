/**
 * Agent-facing domain types shared by the daemon (producer) and every UI (consumer).
 * These are plain JSON-serializable shapes; they cross the wire unchanged.
 */

/** Lifecycle of the agent's work on one to-do item. Drives the badge shown next to the task. */
export type TaskAgentStatus =
  | "idle" // seen, not yet considered (e.g. still settling while the user types)
  | "triaging" // the orchestrator is deciding what to do
  | "queued" // delegated, waiting for a free subagent slot
  | "working" // a subagent is actively working
  | "waiting_approval" // blocked on the user approving a risky action
  | "waiting_user" // the agent asked the user a question
  | "done"
  | "failed"
  | "cancelled"
  | "ignored"; // the orchestrator decided there is nothing it can do

export const ACTIVE_TASK_STATUSES: readonly TaskAgentStatus[] = [
  "triaging",
  "queued",
  "working",
  "waiting_approval",
  "waiting_user",
];

export function isActiveTaskStatus(status: TaskAgentStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

/** Everything the UI needs to render the agent badge/pill for one task line. */
export interface TaskAgentRecord {
  taskId: string;
  notePath: string;
  /** ISO date (YYYY-MM-DD) when the note is a daily note. */
  date: string | null;
  /** Latest task text. */
  text: string;
  /** Last known 0-based line (clients re-resolve locally while editing). */
  line: number;
  status: TaskAgentStatus;
  /** One-line status shown inline in the editor, e.g. "Found 3 flights under $400". */
  summary?: string;
  threadId: string | null;
  updatedAt: number;
  /** Agent messages the user has not seen yet. */
  unread: number;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type SafetyDecision = "allow" | "require_approval" | "deny";

/** Coarse effect categories used by the safety evaluator and shown on approval cards. */
export type ActionCategory =
  | "read"
  | "compute"
  | "network"
  | "file_write"
  | "browser_input"
  | "form_submission"
  | "computer_control"
  | "communication"
  | "publishing"
  | "payment"
  | "booking"
  | "account"
  | "credentials"
  | "privacy"
  | "destructive"
  | "system"
  | "unknown";

export type ApprovalScope = "once" | "task" | "always";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRequest {
  id: string;
  threadId: string | null;
  taskId: string | null;
  toolName: string;
  toolLabel?: string;
  /** Tool arguments exactly as the agent proposed them. */
  input: unknown;
  /** Human-readable description of the action ("Send email to sam@… with subject …"). */
  summary: string;
  risk: RiskLevel;
  categories: ActionCategory[];
  /** Why the safety evaluator wants a human in the loop. */
  reason: string;
  status: ApprovalStatus;
  /** Scope the user granted when approving. */
  scope?: ApprovalScope;
  decisionNote?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
}

export type ArtifactKind = "markdown" | "code" | "html" | "image" | "json" | "text" | "file";

export interface ArtifactMeta {
  id: string;
  threadId: string;
  title: string;
  kind: ArtifactKind;
  mimeType: string;
  /** Code language hint for `code` artifacts. */
  language?: string;
  /** Vault-relative sidecar path of the artifact body. */
  path: string;
  size: number;
  createdAt: number;
}

export type MessageAuthor = "you" | "orchestrator" | `subagent:${string}` | "system";

interface BaseMessage {
  id: string;
  author: MessageAuthor;
  createdAt: number;
}

export interface TextMessage extends BaseMessage {
  kind: "text";
  role: "agent" | "user" | "system";
  /** Markdown. */
  text: string;
  /** True while tokens are still streaming in (see `thread.delta` events). */
  streaming?: boolean;
}

export interface ToolCallMessage extends BaseMessage {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  label?: string;
  input: unknown;
  status: "running" | "ok" | "error" | "blocked";
  /** Short, UI-safe preview of the result (full results stay server-side). */
  resultPreview?: string;
  endedAt?: number;
}

export interface ApprovalMessage extends BaseMessage {
  kind: "approval";
  approvalId: string;
}

export interface ArtifactMessage extends BaseMessage {
  kind: "artifact";
  artifactId: string;
}

export interface StatusMessage extends BaseMessage {
  kind: "status";
  status: TaskAgentStatus;
  text?: string;
}

export type ThreadMessage =
  | TextMessage
  | ToolCallMessage
  | ApprovalMessage
  | ArtifactMessage
  | StatusMessage;

/** Live visual surfaces a thread can expose (streamed as `surface.frame` events). */
export type SurfaceKind = "browser" | "computer";

export interface Thread {
  id: string;
  taskId: string | null;
  notePath: string | null;
  /** Task text snapshot (kept in sync as the task is edited). */
  title: string;
  status: TaskAgentStatus;
  createdAt: number;
  updatedAt: number;
  messages: ThreadMessage[];
  artifacts: ArtifactMeta[];
  surfaces: SurfaceKind[];
}

export interface ThreadSummary {
  id: string;
  taskId: string | null;
  notePath: string | null;
  title: string;
  status: TaskAgentStatus;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  lastMessagePreview?: string;
  artifactCount: number;
  surfaces: SurfaceKind[];
  pendingApprovals: number;
}

export function summarizeThread(thread: Thread, pendingApprovals = 0): ThreadSummary {
  let lastMessagePreview: string | undefined;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.kind === "text") {
      lastMessagePreview = m.text.slice(0, 200);
      break;
    }
  }
  return {
    id: thread.id,
    taskId: thread.taskId,
    notePath: thread.notePath,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
    ...(lastMessagePreview === undefined ? {} : { lastMessagePreview }),
    artifactCount: thread.artifacts.length,
    surfaces: thread.surfaces,
    pendingApprovals,
  };
}

/** One frame of a live surface (browser screencast or desktop screenshot). */
export interface SurfaceFrame {
  threadId: string;
  surface: SurfaceKind;
  mimeType: "image/jpeg" | "image/png";
  /** Base64-encoded image bytes. */
  data: string;
  width: number;
  height: number;
  /** Browser only. */
  url?: string;
  title?: string;
  /** The action that produced this frame, for overlays (e.g. a click marker). */
  action?: { kind: string; x?: number; y?: number; text?: string };
  ts: number;
}
