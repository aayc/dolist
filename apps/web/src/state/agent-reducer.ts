import type {
  AgentStatusResponse,
  ApprovalRequest,
  ServerEvent,
  TaskAgentRecord,
  Thread,
  ThreadMessage,
  ThreadResponse,
  ThreadSummary,
} from "@ddl/core";

export type RecordBucket = Readonly<Record<string, TaskAgentRecord>>;

export interface AgentState {
  status: AgentStatusResponse | null;
  /** notePath → taskId → record */
  records: Readonly<Record<string, RecordBucket>>;
  threads: Readonly<Record<string, ThreadSummary>>;
  /** Fully loaded threads (fetched on open, then kept current by events). */
  details: Readonly<Record<string, Thread>>;
  approvals: Readonly<Record<string, ApprovalRequest>>;
}

export const initialAgentState: AgentState = {
  status: null,
  records: {},
  threads: {},
  details: {},
  approvals: {},
};

function upsertMessage(
  messages: readonly ThreadMessage[],
  message: ThreadMessage,
): ThreadMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.id === message.id) {
      const next = messages.slice();
      next[i] = message;
      return next;
    }
  }
  return [...messages, message];
}

function appendDelta(
  messages: readonly ThreadMessage[],
  messageId: string,
  delta: string,
): ThreadMessage[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.id !== messageId) continue;
    // A late delta (e.g. after a refetch returned the final text) would duplicate text.
    if (message.kind !== "text" || message.streaming !== true) return null;
    const next = messages.slice();
    next[i] = { ...message, text: message.text + delta };
    return next;
  }
  return null;
}

function withRecord(state: AgentState, record: TaskAgentRecord): AgentState {
  const bucket = state.records[record.notePath] ?? {};
  // A task lives in one note; a newer copy anywhere (e.g. after a rename) wins.
  const previous = findRecordIn(state.records, record.taskId);
  if (previous && previous.updatedAt > record.updatedAt) return state;
  let records: Record<string, RecordBucket> = {
    ...state.records,
    [record.notePath]: { ...bucket, [record.taskId]: record },
  };
  // A task can move between notes (rename); drop stale copies elsewhere.
  for (const [notePath, other] of Object.entries(state.records)) {
    if (notePath === record.notePath || !other[record.taskId]) continue;
    const { [record.taskId]: _moved, ...rest } = other;
    records = { ...records, [notePath]: rest };
  }
  return { ...state, records };
}

/** Pure reducer for agent-related server events (unit tested; the store is a thin shell). */
export function reduceAgentEvent(state: AgentState, event: ServerEvent): AgentState {
  switch (event.type) {
    case "task.records":
      return applyRecordsSnapshot(state, event.notePath, event.records);
    case "task.record":
      return withRecord(state, event.record);
    case "thread.upsert": {
      const summary = event.thread;
      const detail = state.details[summary.id];
      const details = detail
        ? {
            ...state.details,
            [summary.id]: {
              ...detail,
              title: summary.title,
              status: summary.status,
              updatedAt: summary.updatedAt,
              surfaces: summary.surfaces,
              notePath: summary.notePath,
            },
          }
        : state.details;
      return { ...state, threads: { ...state.threads, [summary.id]: summary }, details };
    }
    case "thread.message": {
      const detail = state.details[event.threadId];
      if (!detail) return state;
      return {
        ...state,
        details: {
          ...state.details,
          [event.threadId]: { ...detail, messages: upsertMessage(detail.messages, event.message) },
        },
      };
    }
    case "thread.delta": {
      const detail = state.details[event.threadId];
      if (!detail) return state;
      const messages = appendDelta(detail.messages, event.messageId, event.delta);
      if (!messages) return state;
      return { ...state, details: { ...state.details, [event.threadId]: { ...detail, messages } } };
    }
    case "approval.upsert":
      return { ...state, approvals: { ...state.approvals, [event.approval.id]: event.approval } };
    case "agent.status":
      return { ...state, status: event.status };
    default:
      return state;
  }
}

/**
 * Replaces a note's records with a snapshot, keeping any record we already know to be newer. A task
 * lives in one note: a newer copy in another note wins over the snapshot, an older one is dropped.
 */
export function applyRecordsSnapshot(
  state: AgentState,
  notePath: string,
  records: readonly TaskAgentRecord[],
): AgentState {
  const previous = state.records[notePath] ?? {};
  const all: Record<string, RecordBucket> = { ...state.records };
  const bucket: Record<string, TaskAgentRecord> = {};
  for (const record of records) {
    const known = previous[record.taskId];
    if (known && known.updatedAt > record.updatedAt) {
      bucket[record.taskId] = known;
      continue;
    }
    const elsewhere = Object.entries(all).find(
      ([path, other]) => path !== notePath && other[record.taskId],
    );
    if (elsewhere) {
      const [path, other] = elsewhere;
      if (other[record.taskId]!.updatedAt > record.updatedAt) continue;
      const { [record.taskId]: _moved, ...rest } = other;
      all[path] = rest;
    }
    bucket[record.taskId] = record;
  }
  return { ...state, records: { ...all, [notePath]: bucket } };
}

export function applyThreadResponse(state: AgentState, response: ThreadResponse): AgentState {
  const { thread, approvals } = response;
  const approvalMap = { ...state.approvals };
  for (const approval of approvals) approvalMap[approval.id] = approval;
  const known = state.threads[thread.id];
  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const summary: ThreadSummary = known
    ? { ...known, title: thread.title, status: thread.status, surfaces: thread.surfaces }
    : {
        id: thread.id,
        taskId: thread.taskId,
        notePath: thread.notePath,
        title: thread.title,
        status: thread.status,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messageCount: thread.messages.length,
        artifactCount: thread.artifacts.length,
        surfaces: thread.surfaces,
        pendingApprovals,
        ...(thread.routineId === undefined ? {} : { routineId: thread.routineId }),
      };
  return {
    ...state,
    details: { ...state.details, [thread.id]: thread },
    threads: { ...state.threads, [thread.id]: summary },
    approvals: approvalMap,
  };
}

export function applyThreadList(state: AgentState, threads: readonly ThreadSummary[]): AgentState {
  const map: Record<string, ThreadSummary> = {};
  for (const thread of threads) map[thread.id] = thread;
  return { ...state, threads: map };
}

/** Adds a filtered list (a routine's runs) to what's known, newer copies winning. */
export function mergeThreadSummaries(
  state: AgentState,
  threads: readonly ThreadSummary[],
): AgentState {
  let map: Record<string, ThreadSummary> | null = null;
  for (const thread of threads) {
    const known = state.threads[thread.id];
    if (known && known.updatedAt > thread.updatedAt) continue;
    map ??= { ...state.threads };
    map[thread.id] = thread;
  }
  return map ? { ...state, threads: map } : state;
}

/** A routine's runs, newest first. */
export function routineRuns(threads: AgentState["threads"], routineId: string): ThreadSummary[] {
  return Object.values(threads)
    .filter((thread) => thread.routineId === routineId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function applyApprovalList(
  state: AgentState,
  approvals: readonly ApprovalRequest[],
): AgentState {
  const map: Record<string, ApprovalRequest> = {};
  for (const approval of approvals) map[approval.id] = approval;
  return { ...state, approvals: map };
}

export function findRecordIn(
  records: AgentState["records"],
  taskId: string,
): TaskAgentRecord | undefined {
  for (const bucket of Object.values(records)) {
    const record = bucket[taskId];
    if (record) return record;
  }
  return undefined;
}

export function countPendingApprovals(state: AgentState): number {
  let count = 0;
  for (const approval of Object.values(state.approvals)) if (approval.status === "pending") count++;
  return count;
}
