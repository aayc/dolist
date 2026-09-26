import type { TextMessage, ThreadMessage } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BINARY_ARTIFACT_SUFFIX,
  createThreadStore,
  THREAD_JOURNALS_DIR,
  threadJournalPath,
} from "../src/threads/store";
import type { ThreadStoreEvent } from "../src/threads/types";

function text(id: string, body: string, extra: Partial<TextMessage> = {}): TextMessage {
  return {
    id,
    kind: "text",
    role: "agent",
    author: "orchestrator",
    text: body,
    createdAt: 1,
    ...extra,
  };
}

function journalAppends(storage: MemoryStorageProvider) {
  const spy = vi.spyOn(storage, "append");
  return () => spy.mock.calls.filter(([path]) => path.startsWith(THREAD_JOURNALS_DIR)).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadStore", () => {
  it("creates threads, emits events and persists after the debounce", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorageProvider();
    const appends = journalAppends(storage);
    const store = createThreadStore({ storage, flushDelayMs: 400, pendingApprovals: () => 2 });
    const events: ThreadStoreEvent[] = [];
    store.on((e) => events.push(e));

    const thread = store.create({
      taskId: "tsk_1",
      notePath: "Daily/2026-09-23.md",
      title: "Book",
    });
    store.upsertMessage(thread.id, text("m1", "On it"));
    expect(events.map((e) => e.type)).toEqual(["thread.upsert", "thread.message", "thread.upsert"]);
    const lastUpsert = events.at(-1);
    expect(lastUpsert?.type === "thread.upsert" && lastUpsert.thread).toMatchObject({
      messageCount: 1,
      lastMessagePreview: "On it",
      pendingApprovals: 2,
    });

    expect(appends()).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(appends()).toBe(1);
    const file = await storage.read(threadJournalPath(thread.id));
    expect(
      file!.content
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual(["thread.created", "message"]);
  });

  it("streams deltas without writing, then persists the finalized message", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorageProvider();
    const store = createThreadStore({ storage, flushDelayMs: 100 });
    const thread = store.create({ taskId: null, notePath: null, title: "t" });
    await vi.advanceTimersByTimeAsync(100);
    const appends = journalAppends(storage);
    const deltas: string[] = [];
    store.on((e) => {
      if (e.type === "thread.delta") deltas.push(e.delta);
    });

    store.upsertMessage(thread.id, text("s1", "", { streaming: true }));
    for (const word of ["Hello ", "there ", "friend"]) store.appendDelta(thread.id, "s1", word);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deltas).toEqual(["Hello ", "there ", "friend"]);
    expect((store.get(thread.id)!.messages[0] as TextMessage).text).toBe("Hello there friend");
    expect(appends()).toBe(0);

    store.upsertMessage(thread.id, text("s1", "Hello there friend"));
    await vi.advanceTimersByTimeAsync(100);
    expect(appends()).toBe(1);
  });

  it("replaces messages with the same id", () => {
    const store = createThreadStore({ storage: new MemoryStorageProvider() });
    const thread = store.create({ taskId: null, notePath: null, title: "t" });
    store.upsertMessage(thread.id, text("m1", "first"));
    store.upsertMessage(thread.id, text("m2", "second"));
    store.upsertMessage(thread.id, text("m1", "first, edited"));
    const messages = store.get(thread.id)!.messages as TextMessage[];
    expect(messages.map((m) => m.text)).toEqual(["first, edited", "second"]);
  });

  it("round-trips threads and artifacts (text and binary) through storage", async () => {
    const storage = new MemoryStorageProvider();
    const store = createThreadStore({ storage });
    const thread = store.create({
      taskId: "tsk_9",
      notePath: "Daily/2026-09-23.md",
      title: "Plan",
    });
    store.upsertMessage(thread.id, text("m1", "Here is the plan"));
    store.setStatus(thread.id, "done");
    store.addSurface(thread.id, "browser");
    const doc = await store.addArtifact(thread.id, {
      title: "Plan",
      kind: "markdown",
      mimeType: "text/markdown",
      content: "# Plan\n- step",
    });
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    const image = await store.addArtifact(thread.id, {
      title: "Screenshot",
      kind: "image",
      mimeType: "image/png",
      content: bytes,
    });
    expect(doc.path).toBe(`.daily-do-list/artifacts/${thread.id}/${doc.id}.md`);
    expect(image.path.endsWith(`.png${BINARY_ARTIFACT_SUFFIX}`)).toBe(true);
    expect(image.size).toBe(bytes.byteLength);
    await store.flush();

    const reloaded = createThreadStore({ storage });
    await reloaded.load();
    const loaded = reloaded.get(thread.id)!;
    expect(loaded).toMatchObject({ status: "done", surfaces: ["browser"], taskId: "tsk_9" });
    expect(loaded.artifacts.map((a) => a.id)).toEqual([doc.id, image.id]);
    expect(reloaded.findByTask("tsk_9")?.id).toBe(thread.id);

    const docBody = await reloaded.readArtifact(thread.id, doc.id);
    expect(new TextDecoder().decode(docBody!.body)).toBe("# Plan\n- step");
    const imageBody = await reloaded.readArtifact(thread.id, image.id);
    expect([...imageBody!.body]).toEqual([...bytes]);
    expect(await reloaded.readArtifact(thread.id, "art_missing")).toBeNull();
  });

  it("marks messages that were still streaming as finished when loaded", async () => {
    const storage = new MemoryStorageProvider();
    const store = createThreadStore({ storage });
    const thread = store.create({ taskId: null, notePath: null, title: "t" });
    store.upsertMessage(thread.id, text("s1", "partial", { streaming: true }));
    await store.flush();
    const reloaded = createThreadStore({ storage });
    await reloaded.load();
    const message = reloaded.get(thread.id)!.messages[0] as ThreadMessage & { streaming?: boolean };
    expect(message.streaming).toBe(false);
  });

  it("works next to an unreadable snapshot, and filters lists", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: { ".daily-do-list/threads/bad.json": "{not json" },
    });
    const store = createThreadStore({ storage });
    await store.load();
    const a = store.create({ taskId: "a", notePath: "Daily/1.md", title: "A" });
    store.create({ taskId: "b", notePath: "Daily/2.md", title: "B" });
    expect(store.list({ notePath: "Daily/1.md" }).map((t) => t.id)).toEqual([a.id]);
    expect(store.list({ taskId: "b" })).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });
});
