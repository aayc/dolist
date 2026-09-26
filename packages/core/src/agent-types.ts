/** Agent constants and helpers shared by the daemon and every UI (the types are in `./wire`). */
import type { TaskAgentStatus, Thread, ThreadSummary } from "./wire";

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

export type SafetyDecision = "allow" | "require_approval" | "deny";

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

/** Bounds the daemon keeps orchestrator activity within (clients may rely on them for layout). */
export const ORCHESTRATOR_ACTIVITY_LIMITS = {
  /** `trigger.summary`, in UTF-16 units. */
  summaryChars: 80,
  /** `trigger.lines`: the first lines, in note order. */
  lines: 20,
  /** Each `trigger.lines[].text`. */
  lineChars: 300,
  /** `outcome.text`. */
  outcomeTextChars: 160,
} as const;

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
