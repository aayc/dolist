/**
 * A thread is the fold of its journal. The store applies every change through `applyJournalPayload`
 * as it records it, and loading folds the same events in canonical order, so the thread in memory
 * and the thread a restart reads back are the same by construction.
 */
import {
  encodePersistedThread,
  finishInterruptedPersistedMessage,
  mergePersistedThreads,
  type PersistedJournalEvent,
  type PersistedJournalPayload,
  type PersistedThread,
} from "@ddl/contract";
import type { CitedSource, Thread, ThreadMessage } from "@ddl/core";

export const MAX_THREAD_SOURCES = 50;

/** A tool call the journal saw start (write-ahead) without seeing it end. */
export interface OpenToolCall {
  callId: string;
  tool: string;
  /** What it does, in words ("Press Send in Slack"). */
  target: string;
  approvalId?: string;
  /** It may change something; false for reads, which are safe to do again. */
  effectful: boolean;
  startedAt: number;
}

export interface JournalFold {
  thread: Thread | undefined;
  /** Messages trimmed away, so a stale snapshot merged in later can't bring them back. */
  trimmed: Set<string>;
  /** Started calls without a result: in flight now, uncertain after a restart. */
  open: Map<string, OpenToolCall>;
  /** Calls marked interrupted since the thread's agent was last prompted. */
  interrupted: OpenToolCall[];
}

export function emptyFold(): JournalFold {
  return { thread: undefined, trimmed: new Set(), open: new Map(), interrupted: [] };
}

/** Applies one event (or a payload recorded at `at`) to the fold. */
export function applyJournalPayload(
  fold: JournalFold,
  payload: PersistedJournalPayload,
  at: number,
  threadId: string,
): void {
  switch (payload.type) {
    case "thread.created": {
      if (fold.thread) return;
      const { routineId, ...header } = payload.thread;
      fold.thread = {
        ...header,
        updatedAt: header.createdAt,
        messages: [],
        artifacts: [],
        surfaces: [],
        ...(routineId ? { routineId } : {}),
      };
      return;
    }
    case "thread.imported": {
      const incoming = withoutTrimmed(payload.thread, fold.trimmed);
      fold.thread = fold.thread
        ? mergePersistedThreads(fold.thread, incoming)
        : copyThread(incoming);
      return;
    }
    case "tool.started":
      fold.open.set(payload.call, {
        callId: payload.call,
        tool: payload.tool,
        target: payload.target,
        ...(payload.approvalId ? { approvalId: payload.approvalId } : {}),
        effectful: payload.effectful !== false,
        startedAt: at,
      });
      return;
    case "tool.finished":
      fold.open.delete(payload.call);
      return;
    case "tool.interrupted": {
      const call = fold.open.get(payload.call);
      if (!call) return;
      fold.open.delete(payload.call);
      fold.interrupted.push(call);
      return;
    }
    case "run.prompted":
      fold.interrupted = [];
      return;
    case "tool.requested":
    case "tool.decided":
    case "run.text":
      return;
    default:
      break;
  }
  fold.thread ??= placeholder(threadId, at);
  const thread = fold.thread;
  switch (payload.type) {
    case "message": {
      const index = findMessageIndex(thread, payload.message.id);
      if (index === -1) thread.messages.push(payload.message);
      else thread.messages[index] = payload.message;
      thread.updatedAt = Math.max(thread.updatedAt, at);
      return;
    }
    case "status":
      thread.status = payload.status;
      thread.updatedAt = Math.max(thread.updatedAt, at);
      return;
    case "title":
      thread.title = payload.title;
      return;
    case "trim": {
      const cut = thread.messages.length - Math.max(0, payload.keep);
      if (cut <= 0) return;
      for (const message of thread.messages.slice(0, cut)) fold.trimmed.add(message.id);
      thread.messages = thread.messages.slice(cut);
      return;
    }
    case "surface":
      if (!thread.surfaces.includes(payload.surface)) thread.surfaces.push(payload.surface);
      return;
    case "sources": {
      const merged = mergeSources(thread.sources, payload.sources);
      if (merged) thread.sources = merged;
      return;
    }
    case "artifact":
      if (!thread.artifacts.some((artifact) => artifact.id === payload.artifact.id)) {
        thread.artifacts.push(payload.artifact);
      }
      thread.updatedAt = Math.max(thread.updatedAt, payload.artifact.createdAt);
      return;
  }
}

/**
 * Folds a journal read from disk (events in canonical order). Messages journaled mid-stream were
 * interrupted (their writer stopped) and come out finished, unless `finishStreaming` is false.
 */
export function foldJournal(
  events: readonly PersistedJournalEvent[],
  threadId: string,
  options: { finishStreaming?: boolean } = {},
): JournalFold {
  const fold = emptyFold();
  for (const event of events) applyJournalPayload(fold, event, event.at, threadId);
  if (fold.thread && options.finishStreaming !== false) {
    fold.thread.messages = fold.thread.messages.map(finishInterruptedPersistedMessage);
  }
  return fold;
}

/**
 * The thread's cited pages with `incoming` merged in (deduplicated by URL, newest last, capped),
 * or null when nothing changes.
 */
export function mergeSources(
  current: readonly CitedSource[] | undefined,
  incoming: readonly CitedSource[],
): CitedSource[] | null {
  if (incoming.length === 0) return null;
  const byUrl = new Map((current ?? []).map((source) => [source.url, source]));
  let changed = false;
  for (const source of incoming) {
    const known = byUrl.get(source.url);
    if (known && known.title === source.title && known.snippet === source.snippet) continue;
    byUrl.delete(source.url);
    byUrl.set(source.url, { ...known, ...source });
    changed = true;
  }
  return changed ? [...byUrl.values()].slice(-MAX_THREAD_SOURCES) : null;
}

/**
 * `theirs` merged into the fold's thread, or null when that changes nothing (the snapshot holds
 * nothing the journal lacks). Messages the journal trimmed don't count.
 */
export function mergeSnapshot(fold: JournalFold, theirs: PersistedThread): Thread | null {
  const ours = fold.thread;
  const incoming = withoutTrimmed(theirs, fold.trimmed);
  if (!ours) return copyThread(incoming);
  const merged = mergePersistedThreads(ours, incoming);
  return encodePersistedThread(merged) === encodePersistedThread(ours) ? null : merged;
}

/** Copy with fresh arrays: messages and artifacts are never mutated in place. */
export function copyThread(thread: PersistedThread): Thread {
  return {
    ...thread,
    messages: [...thread.messages],
    artifacts: [...thread.artifacts],
    surfaces: [...thread.surfaces],
    ...(thread.sources ? { sources: [...thread.sources] } : {}),
  };
}

export function findMessageIndex(thread: Thread, messageId: string): number {
  // Updates almost always target one of the most recent messages.
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i]!.id === messageId) return i;
  }
  return -1;
}

function withoutTrimmed(thread: PersistedThread, trimmed: ReadonlySet<string>): PersistedThread {
  if (trimmed.size === 0) return thread;
  const messages = thread.messages.filter((message) => !trimmed.has(message.id));
  return messages.length === thread.messages.length ? thread : { ...thread, messages };
}

/** A thread whose journal lost its first event: rebuilt from what follows. */
function placeholder(threadId: string, at: number): Thread {
  return {
    id: threadId,
    taskId: null,
    notePath: null,
    title: "",
    status: "idle",
    createdAt: at,
    updatedAt: at,
    messages: [] as ThreadMessage[],
    artifacts: [],
    surfaces: [],
  };
}
