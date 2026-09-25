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
  /**
   * Set when the orchestrator attached the thread to a line that isn't a task (a heading, a
   * question written as prose…): `taskId` is then the anchor's id, `text` the line (without an
   * agent marker) and `line` where it is. Clients draw the badge there and highlight the line.
   */
  anchor?: "line";
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

export type ApprovalDecision = "approve" | "deny";

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

/** `blocked`: the safety gate refused the call (denied or not approved). */
export type ToolCallStatus = "running" | "ok" | "error" | "blocked";

export interface ToolCallMessage extends BaseMessage {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  label?: string;
  input: unknown;
  status: ToolCallStatus;
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

export type ThreadMessageKind = ThreadMessage["kind"];

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
  /**
   * Web pages this thread cites (in its messages or the note lines it wrote), with what the agent
   * saw of them: clients preview a citation from here, never by fetching the page.
   */
  sources?: CitedSource[];
  /** Set on a routine's runs: the routine (`Routine.id`) this thread is one run of. */
  routineId?: string;
}

/** A web page an agent found or read, as a citation preview. */
export interface CitedSource {
  url: string;
  title?: string;
  /** A sentence or two from the search result or the page. */
  snippet?: string;
}

/**
 * The orchestrator's own chat: one thread with this id (`taskId` and `notePath` null) records each
 * of its turns (what woke it, its text, its tool calls) and takes the user's direct messages.
 */
export const ORCHESTRATOR_THREAD_ID = "thr_orchestrator";
export type OrchestratorThreadId = typeof ORCHESTRATOR_THREAD_ID;
export const ORCHESTRATOR_THREAD_TITLE = "Orchestrator";

export function isOrchestratorThread(threadId: string): threadId is OrchestratorThreadId {
  return threadId === ORCHESTRATOR_THREAD_ID;
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
  /** Set on a routine's runs (see `Thread.routineId`). */
  routineId?: string;
}

const PREVIEW_LENGTH = 200;

/** The first `max` UTF-16 units of `text`, never ending on half of a surrogate pair. */
function preview(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

export function summarizeThread(thread: Thread, pendingApprovals = 0): ThreadSummary {
  let lastMessagePreview: string | undefined;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (m.kind === "text") {
      lastMessagePreview = preview(m.text, PREVIEW_LENGTH);
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
    ...(thread.routineId === undefined ? {} : { routineId: thread.routineId }),
  };
}

// ── Routines ─────────────────────────────────────────────────────────────────

/** When a finished run notifies: every time, only when it found something new, or never. */
export type RoutineNotify = "always" | "when_changed" | "never";

/** Capabilities a routine's runs get (the `uses` hint of its file). */
export type RoutineUse = "web" | "browser" | "computer" | "shell" | "files" | "connectors";

/** What started a run: its schedule, a slot missed while the Mac slept or the agent was down, or the user. */
export type RoutineRunTrigger = "schedule" | "catch_up" | "manual";

/** One run of a routine (its thread holds the conversation). */
export interface RoutineRun {
  threadId: string;
  trigger: RoutineRunTrigger;
  status: TaskAgentStatus;
  startedAt: number;
  finishedAt?: number;
  /** One line: the run's badge text. */
  summary?: string;
  /** Whether the run found something new since the previous one (runs report it when they can). */
  changed?: boolean;
}

/**
 * A standing job the agent runs on a schedule: one markdown file in the vault's `Routines/`
 * folder (the definition) plus the scheduler's state in the sidecar (next run, last run).
 */
export interface Routine {
  /** Stable id derived from the file's path (`rtn_…`), safe in URLs. */
  id: string;
  /** `Routines/<name>.md`. */
  path: string;
  /** The file name without `.md`. */
  name: string;
  /** The schedule as written in the file. */
  schedule: string;
  /** The schedule in words (`Every weekday at 7:30 AM`); absent when it can't be read. */
  scheduleText?: string;
  notify: RoutineNotify;
  uses: RoutineUse[];
  paused: boolean;
  /** The file's body: what each run does. */
  instructions: string;
  /** Why the routine can't run (an unreadable schedule, an unknown setting, no instructions). */
  error?: string;
  /** Absent while paused, invalid or unscheduled. */
  nextRunAt?: number;
  lastRun?: RoutineRun;
  /** Runs kept (threads with this `routineId`). */
  runCount: number;
  /** Runs the user (or the agent) may still start today beyond the schedule. */
  extraRunsLeft: number;
}

/** A starter routine the "New routine" sheet offers. */
export interface RoutineTemplate {
  id: string;
  name: string;
  /** One line for the picker. */
  description: string;
  schedule: string;
  notify: RoutineNotify;
  uses: RoutineUse[];
  instructions: string;
}

/** A finished run worth telling the user about (sent according to the routine's `notify`). */
export interface RoutineNotification {
  routineId: string;
  /** The routine's name. */
  title: string;
  /** The run's result in one or two lines. */
  body: string;
  threadId: string;
  status: TaskAgentStatus;
  at: number;
}

/** The action that produced a frame, for overlays (e.g. a click marker at x/y in frame pixels). */
export interface SurfaceFrameAction {
  kind: string;
  x?: number;
  y?: number;
  text?: string;
}

/** One frame of a live surface (browser screencast or desktop screenshot). */
export interface SurfaceFrame {
  threadId: string;
  surface: SurfaceKind;
  mimeType: "image/jpeg" | "image/png";
  /** Base64-encoded image bytes. */
  data: string;
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** Browser only. */
  url?: string;
  title?: string;
  action?: SurfaceFrameAction;
  ts: number;
}
