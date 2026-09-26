import { createId, errorMessage, type ThreadMessage } from "@ddl/core";
import { create } from "zustand";

export type PendingState = "sending" | "sent" | "failed";

/** A reply shown in the chat before the daemon confirms it (optimistic send). */
export interface PendingMessage {
  id: string;
  threadId: string;
  text: string;
  state: PendingState;
  /** How many user messages with this text the thread had when it was sent. */
  baseline: number;
  error?: string;
}

interface OutboxState {
  /** threadId → its pending replies, in send order. */
  pending: Readonly<Record<string, readonly PendingMessage[]>>;
}

export const useOutboxStore = create<OutboxState>(() => ({ pending: {} }));

export type PostMessage = (threadId: string, text: string) => Promise<void>;

const NO_PENDING: readonly PendingMessage[] = [];

export function pendingOf(state: OutboxState, threadId: string): readonly PendingMessage[] {
  return state.pending[threadId] ?? NO_PENDING;
}

function userCounts(messages: readonly ThreadMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.kind === "text" && message.role === "user") {
      counts.set(message.text, (counts.get(message.text) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Splits pending replies into those the thread shows by now and those it doesn't. A reply is
 * confirmed once the thread has more user messages with its text than when it was sent (in send
 * order, so the same text sent twice needs two), which needs no clock shared with the daemon.
 */
export function matchPending(
  pending: readonly PendingMessage[],
  messages: readonly ThreadMessage[],
): { confirmed: PendingMessage[]; unconfirmed: PendingMessage[] } {
  const confirmed: PendingMessage[] = [];
  const unconfirmed: PendingMessage[] = [];
  if (pending.length === 0) return { confirmed, unconfirmed };
  const counts = userCounts(messages);
  const claimed = new Map<string, number>();
  for (const item of pending) {
    const taken = claimed.get(item.text) ?? 0;
    if ((counts.get(item.text) ?? 0) - item.baseline > taken) {
      claimed.set(item.text, taken + 1);
      confirmed.push(item);
    } else {
      unconfirmed.push(item);
    }
  }
  return { confirmed, unconfirmed };
}

function update(threadId: string, change: (list: readonly PendingMessage[]) => PendingMessage[]) {
  useOutboxStore.setState((state) => {
    const next = change(pendingOf(state, threadId));
    const { [threadId]: _previous, ...rest } = state.pending;
    return { pending: next.length > 0 ? { ...rest, [threadId]: next } : rest };
  });
}

function patch(threadId: string, id: string, changes: Partial<PendingMessage>): void {
  update(threadId, (list) => list.map((item) => (item.id === id ? { ...item, ...changes } : item)));
}

async function attempt(post: PostMessage, item: PendingMessage): Promise<void> {
  try {
    await post(item.threadId, item.text);
    patch(item.threadId, item.id, { state: "sent" });
  } catch (error) {
    patch(item.threadId, item.id, { state: "failed", error: errorMessage(error) });
  }
}

/** Shows `text` in the thread at once and sends it; `messages` is what the thread has now. */
export function sendMessage(
  post: PostMessage,
  threadId: string,
  text: string,
  messages: readonly ThreadMessage[],
): Promise<void> {
  const item: PendingMessage = {
    id: createId("out"),
    threadId,
    text,
    state: "sending",
    baseline: userCounts(messages).get(text) ?? 0,
  };
  update(threadId, (list) => [...list, item]);
  return attempt(post, item);
}

export function retryMessage(post: PostMessage, threadId: string, id: string): Promise<void> {
  const item = pendingOf(useOutboxStore.getState(), threadId).find((p) => p.id === id);
  if (item?.state !== "failed") return Promise.resolve();
  const { error: _error, ...rest } = item;
  const retry: PendingMessage = { ...rest, state: "sending" };
  update(threadId, (list) => list.map((p) => (p.id === id ? retry : p)));
  return attempt(post, retry);
}

export function discardMessage(threadId: string, id: string): void {
  update(threadId, (list) => list.filter((p) => p.id !== id));
}

/** Forgets replies the thread shows by now, once their request is over. */
export function pruneConfirmed(threadId: string, messages: readonly ThreadMessage[]): void {
  const list = pendingOf(useOutboxStore.getState(), threadId);
  const done = matchPending(list, messages).confirmed.filter((p) => p.state !== "sending");
  if (done.length === 0) return;
  const ids = new Set(done.map((p) => p.id));
  update(threadId, (items) => items.filter((p) => !ids.has(p.id)));
}
