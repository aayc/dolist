import { deferred, type ThreadMessage } from "@ddl/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardMessage,
  matchPending,
  type PendingMessage,
  pendingOf,
  pruneConfirmed,
  retryMessage,
  sendMessage,
  useOutboxStore,
} from "./outbox-store";

const THREAD = "thr_1";

function user(id: string, text: string): ThreadMessage {
  return { id, kind: "text", role: "user", author: "you", createdAt: 1, text };
}

const pending = () => pendingOf(useOutboxStore.getState(), THREAD);

describe("optimistic sends", () => {
  beforeEach(() => {
    useOutboxStore.setState({ pending: {} });
  });

  it("shows the reply at once while it sends, then until the thread has it", async () => {
    const request = deferred<void>();
    const post = vi.fn(() => request.promise);
    const sent = sendMessage(post, THREAD, "Somewhere quiet, please", []);
    expect(post).toHaveBeenCalledWith(THREAD, "Somewhere quiet, please");
    expect(pending()).toMatchObject([{ text: "Somewhere quiet, please", state: "sending" }]);

    // The daemon's event can beat its response: confirmed, but kept until the request is over.
    const messages = [user("m1", "Somewhere quiet, please")];
    expect(matchPending(pending(), messages).unconfirmed).toEqual([]);
    pruneConfirmed(THREAD, messages);
    expect(pending()).toHaveLength(1);

    request.resolve();
    await sent;
    expect(pending()).toMatchObject([{ state: "sent" }]);
    pruneConfirmed(THREAD, messages);
    expect(pending()).toEqual([]);
  });

  it("keeps a sent reply until its message arrives (the response can beat the event)", async () => {
    await sendMessage(async () => {}, THREAD, "Thanks!", []);
    pruneConfirmed(THREAD, []);
    expect(pending()).toMatchObject([{ state: "sent" }]);
    pruneConfirmed(THREAD, [user("m1", "Thanks!")]);
    expect(pending()).toEqual([]);
  });

  it("marks a failed send for an inline retry, which sends it again", async () => {
    const post = vi
      .fn<(threadId: string, text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce();
    await sendMessage(post, THREAD, "Try again", []);
    expect(pending()).toMatchObject([{ state: "failed", error: "offline" }]);

    await retryMessage(post, THREAD, pending()[0]!.id);
    expect(post).toHaveBeenCalledTimes(2);
    expect(pending()).toMatchObject([{ state: "sent" }]);
    expect(pending()[0]).not.toHaveProperty("error");
  });

  it("discards a failed reply", async () => {
    await sendMessage(() => Promise.reject(new Error("offline")), THREAD, "Never mind", []);
    discardMessage(THREAD, pending()[0]!.id);
    expect(useOutboxStore.getState().pending).toEqual({});
  });

  it("matches the same text sent twice one message at a time, ignoring older copies", () => {
    const old = user("m0", "ok");
    const items: PendingMessage[] = [
      { id: "a", threadId: THREAD, text: "ok", state: "sent", baseline: 1 },
      { id: "b", threadId: THREAD, text: "ok", state: "sending", baseline: 1 },
    ];
    expect(matchPending(items, [old]).unconfirmed.map((p) => p.id)).toEqual(["a", "b"]);
    const one = matchPending(items, [old, user("m1", "ok")]);
    expect(one.confirmed.map((p) => p.id)).toEqual(["a"]);
    expect(one.unconfirmed.map((p) => p.id)).toEqual(["b"]);
    expect(matchPending(items, [old, user("m1", "ok"), user("m2", "ok")]).unconfirmed).toEqual([]);
  });
});
