/**
 * The thread store on its journal: golden journals load exactly, any sequence of changes reloads
 * to the same thread, another writer's events fold in, write-ahead records are durable before a
 * call runs, and appends never rewrite a file.
 */
import {
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  persistedThreadImportEvent,
} from "@ddl/contract";
import type { TextMessage, Thread, ThreadMessage } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { messageArb } from "../../../contract/test/persisted/arbitraries";
import { createThreadStore, threadJournalPath } from "../../src/threads/store";
import type { ThreadStoreEvent } from "../../src/threads/types";
import { NOW, readFixture, recordingLogger, sidecar, vault } from "./helpers";

const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const T = 1790154000000;

const text = (id: string, createdAt: number, body = id): TextMessage => ({
  id,
  kind: "text",
  role: "agent",
  author: "orchestrator",
  createdAt,
  text: body,
});

async function loadStore(storage: MemoryStorageProvider, logger = recordingLogger()) {
  const store = createThreadStore({ storage, now: () => NOW, logger, flushDelayMs: 1 });
  await store.load();
  return store;
}

async function journalOf(storage: MemoryStorageProvider, id: string) {
  const file = await storage.read(threadJournalPath(id));
  return file ? decodePersistedThreadJournal(file.content, id) : null;
}

describe("golden journals through the real thread store", () => {
  it("v1.jsonl folds to exactly this thread", async () => {
    const id = "thr_journal00001";
    const storage = vault({ [threadJournalPath(id)]: readFixture("thread-journal", "v1.jsonl") });
    const store = await loadStore(storage);
    const expected: Thread = {
      id,
      taskId: "tsk_7fq2m9x0ab",
      notePath: "Daily/2026-09-23.md",
      title: "Thank the venue in Slack",
      status: "done",
      createdAt: T,
      updatedAt: T + 60_000,
      messages: [
        {
          id: "msg_0002",
          author: "subagent:operator",
          createdAt: T + 3000,
          kind: "tool_call",
          toolCallId: "call_01",
          toolName: "computer_press",
          label: "Press a control",
          input: { app: "Slack", element: "e12" },
          status: "ok",
          resultPreview: 'Pressed "Send".',
          endedAt: T + 5000,
        },
        {
          id: "msg_0003",
          author: "subagent:operator",
          createdAt: T + 6000,
          kind: "artifact",
          artifactId: "art_note01",
        },
        {
          id: "msg_0004",
          author: "system",
          createdAt: T + 60_000,
          kind: "status",
          status: "done",
          text: "Sent",
        },
      ],
      artifacts: [
        {
          id: "art_note01",
          threadId: id,
          title: "Thank-you note",
          kind: "markdown",
          mimeType: "text/markdown",
          path: `.daily-do-list/artifacts/${id}/art_note01.md`,
          size: 64,
          createdAt: T + 6000,
        },
      ],
      surfaces: ["computer"],
      sources: [{ url: "https://example.com/venue", title: "Example Venue" }],
    };
    expect(store.get(id)).toEqual(expected);
    expect(store.openToolCalls(id)).toEqual([]);
    expect(store.interruptedCalls(id)).toEqual([
      {
        callId: "call_03",
        tool: "computer_open_app",
        target: "Open Slack",
        effectful: true,
        startedAt: T + 9000,
      },
    ]);
    await store.flush();
    // The journal itself is never rewritten.
    expect((await storage.read(threadJournalPath(id)))!.content).toBe(
      readFixture("thread-journal", "v1.jsonl"),
    );
  });

  it("v1-imported.jsonl: a migrated thread plus what happened after", async () => {
    const id = "thr_journal00002";
    const storage = vault({
      [threadJournalPath(id)]: readFixture("thread-journal", "v1-imported.jsonl"),
    });
    const store = await loadStore(storage);
    expect(store.get(id)).toMatchObject({
      taskId: "tsk_import0001",
      status: "working",
      updatedAt: T + 10_500,
      routineId: "rtn_weekly01",
      messages: [
        { id: "msg_l1" },
        { id: "msg_l2", text: "Drafting the email…", streaming: false },
        { id: "msg_l3", role: "user", text: "No cc, thanks" },
      ],
    });
  });

  it("v1-two-writers.jsonl folds in (epoch, seq) order", async () => {
    const id = "thr_journal00003";
    const storage = vault({
      [threadJournalPath(id)]: readFixture("thread-journal", "v1-two-writers.jsonl"),
    });
    const store = await loadStore(storage);
    expect(store.get(id)!.messages.map((m) => m.id)).toEqual([
      "msg_w02",
      "msg_w03",
      "msg_w04",
      "msg_w05",
    ]);
  });

  it("v1-invalid-lines.jsonl loads what it can, reports where, and appends on a fresh line", async () => {
    const id = "thr_journal00004";
    const original = readFixture("thread-journal", "v1-invalid-lines.jsonl");
    const storage = vault({ [threadJournalPath(id)]: original });
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.get(id)).toMatchObject({
      title: "Renew passport",
      status: "working",
      messages: [{ id: "msg_b1", text: "On it." }],
      sources: [{ url: "https://example.org/passport" }],
    });
    const warning = logger.entries.find((e) => e.message === "Skipped unreadable journal lines");
    expect(warning?.fields).toMatchObject({ skipped: 8 });
    expect(logger.text()).not.toContain("Renew pass");
    expect(logger.text()).not.toContain("Not mine");

    store.upsertMessage(id, text("msg_b2", T + 20_000, "Form found"));
    await store.flush();
    const after = (await storage.read(threadJournalPath(id)))!.content;
    expect(after.startsWith(original)).toBe(true);
    expect(after.slice(original.length).startsWith("\n{")).toBe(true);
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)).toEqual(store.get(id));
  });

  it("future-version.jsonl: the thread is skipped and nothing about it is written", async () => {
    const id = "thr_journal00005";
    const files = {
      [threadJournalPath(id)]: readFixture("thread-journal", "future-version.jsonl"),
    };
    const storage = vault(files);
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.list()).toEqual([]);
    store.upsertMessage(id, text("m1", T));
    await store.flush();
    expect(await sidecar(storage)).toEqual(files);
    expect(logger.entries.some((e) => e.message.includes("newer version"))).toBe(true);
  });
});

describe("any sequence of changes", () => {
  type Op =
    | { kind: "message"; message: ThreadMessage }
    | { kind: "stream"; id: string; words: string[] }
    | { kind: "status"; status: "idle" | "working" | "done" | "failed" | "waiting_user" }
    | { kind: "title"; title: string }
    | { kind: "surface"; surface: "browser" | "computer" }
    | { kind: "trim"; keep: number }
    | { kind: "sources"; urls: string[] }
    | { kind: "tick" };
  const op: fc.Arbitrary<Op> = fc.oneof(
    messageArb().map((message) => ({ kind: "message" as const, message })),
    fc.record({
      kind: fc.constant("stream" as const),
      id: fc.stringMatching(/^s[0-9]$/),
      words: fc.array(fc.string({ unit: "binary", maxLength: 6 }), { maxLength: 4 }),
    }),
    fc
      .constantFrom("idle", "working", "done", "failed", "waiting_user")
      .map((status) => ({ kind: "status" as const, status })),
    fc
      .string({ unit: "binary", maxLength: 20 })
      .map((title) => ({ kind: "title" as const, title })),
    fc
      .constantFrom("browser", "computer")
      .map((surface) => ({ kind: "surface" as const, surface })),
    fc.nat({ max: 6 }).map((keep) => ({ kind: "trim" as const, keep })),
    fc
      .array(fc.constantFrom("https://a.example", "https://b.example", "https://c.example"), {
        maxLength: 3,
      })
      .map((urls) => ({ kind: "sources" as const, urls })),
    fc.constant({ kind: "tick" as const }),
  );

  test.prop([fc.array(op, { maxLength: 30 }), fc.boolean()])(
    "reloads to the same thread, flushed midway or not",
    async (ops, flushMidway) => {
      let clock = T;
      const storage = new MemoryStorageProvider({ now: () => clock });
      const store = createThreadStore({ storage, now: () => clock, flushDelayMs: 1_000_000 });
      const { id } = store.create({ taskId: "tsk_p", notePath: "Daily/x.md", title: "p" });
      for (const [i, o] of ops.entries()) {
        switch (o.kind) {
          case "message":
            store.upsertMessage(id, o.message);
            break;
          case "stream":
            store.upsertMessage(id, { ...text(o.id, clock, ""), streaming: true });
            for (const word of o.words) store.appendDelta(id, o.id, word);
            store.upsertMessage(id, text(o.id, clock, o.words.join("")));
            break;
          case "status":
            store.setStatus(id, o.status);
            break;
          case "title":
            store.setTitle(id, o.title);
            break;
          case "surface":
            store.addSurface(id, o.surface);
            break;
          case "trim":
            store.trimMessages(id, o.keep);
            break;
          case "sources":
            store.addSources(
              id,
              o.urls.map((url) => ({ url, title: `t${i}` })),
            );
            break;
          case "tick":
            break;
        }
        clock += 7;
        if (flushMidway && i === Math.floor(ops.length / 2)) await store.flush();
      }
      await store.flush();
      const journal = decodePersistedThreadJournal(
        (await storage.read(threadJournalPath(id)))!.content,
        id,
      );
      expect(journal.issues).toEqual([]);
      const reloaded = createThreadStore({ storage, now: () => clock });
      await reloaded.load();
      expect(reloaded.get(id)).toEqual(store.get(id));
    },
  );
});

describe("the journal while the store runs", () => {
  it("folds events another writer appended meanwhile, in order, at its next append", async () => {
    const storage = vault();
    const a = await loadStore(storage);
    const { id } = a.create({ taskId: null, notePath: null, title: "shared" });
    a.upsertMessage(id, text("a1", 1));
    await a.flush();
    const b = await loadStore(storage);
    b.upsertMessage(id, text("b1", 2));
    await b.flush();
    const seen: ThreadStoreEvent[] = [];
    a.on((event) => seen.push(event));
    a.upsertMessage(id, text("a2", 3));
    await a.flush();
    expect(a.get(id)!.messages.map((m) => m.id)).toEqual(["a1", "b1", "a2"]);
    expect(seen).toContainEqual({ type: "thread.message", threadId: id, message: text("b1", 2) });
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)).toEqual(a.get(id));
  });

  it("starts a journal deleted underneath again from memory", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: null, notePath: null, title: "t" });
    store.upsertMessage(id, text("m1", 1));
    await store.flush();
    storage.simulateExternalChange(threadJournalPath(id), null);
    store.upsertMessage(id, text("m2", 2));
    await store.flush();
    const journal = (await journalOf(storage, id))!;
    expect(journal.events.map((e) => e.type)).toEqual(["thread.imported", "message"]);
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)).toEqual(store.get(id));
  });

  it("stamps events with the lease epoch and a growing seq", async () => {
    let epoch = 0;
    const storage = vault();
    const store = createThreadStore({ storage, now: () => NOW, epoch: () => epoch });
    const { id } = store.create({ taskId: null, notePath: null, title: "t" });
    epoch = 7;
    store.setStatus(id, "working");
    await store.flush();
    const journal = (await journalOf(storage, id))!;
    expect(journal.events.map((e) => [e.epoch, e.seq])).toEqual([
      [0, 1],
      [7, 2],
    ]);
  });
});

describe("tool call write-ahead records", () => {
  it("are on disk before recordToolStarting resolves, and fold into open and interrupted calls", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: "tsk_1", notePath: null, title: "t" });
    store.recordPrompt(id, "sess_1", "Task: send it");
    store.recordToolRequested(id, {
      callId: "call_1",
      tool: "computer_press",
      sessionId: "sess_1",
      input: { app: "Slack" },
    });
    const started = store.recordToolStarting(id, "call_1", {
      tool: "computer_press",
      target: "Press Send in Slack",
      via: "approval",
      approvalId: "apr_1",
    });
    await expect(started).resolves.toBe(true);
    const onDisk = (await journalOf(storage, id))!;
    expect(onDisk.events.map((e) => e.type)).toEqual([
      "thread.created",
      "run.prompted",
      "tool.requested",
      "tool.decided",
      "tool.started",
    ]);
    const open = [
      {
        callId: "call_1",
        tool: "computer_press",
        target: "Press Send in Slack",
        approvalId: "apr_1",
        effectful: true,
        startedAt: NOW,
      },
    ];
    expect(store.openToolCalls(id)).toEqual(open);

    // A restart finds it open: it may or may not have happened.
    const restarted = await loadStore(storage);
    expect(restarted.openToolCalls(id)).toEqual(open);
    expect(restarted.markInterrupted(id)).toEqual(open);
    expect(restarted.openToolCalls(id)).toEqual([]);
    expect(restarted.interruptedCalls(id)).toEqual(open);
    await restarted.flush();
    const again = await loadStore(storage);
    expect(again.openToolCalls(id)).toEqual([]);
    expect(again.interruptedCalls(id)).toEqual(open);
    again.recordPrompt(id, "sess_2", "Retry");
    expect(again.interruptedCalls(id)).toEqual([]);
  });

  it("a finished call is closed, and a thread's visible state never changes", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: null, notePath: null, title: "t" });
    const before = store.get(id);
    await store.recordToolStarting(id, "call_1", { tool: "bash", target: "Run ls" });
    store.recordToolFinished(id, "call_1", { outcome: "ok", output: "a\nb" });
    store.recordToolRequested(id, {
      callId: "call_2",
      tool: "x",
      sessionId: "s",
      input: undefined,
    });
    store.recordToolBlocked(id, "call_2", "User denied");
    store.recordToolFinished(id, "call_2", { outcome: "blocked", output: "Blocked" });
    expect(store.get(id)).toEqual(before);
    expect(store.openToolCalls(id)).toEqual([]);
    await store.flush();
    expect((await loadStore(storage)).openToolCalls(id)).toEqual([]);
  });

  it("rejects when the record can't be written, so the call never runs", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: null, notePath: null, title: "t" });
    await store.flush();
    vi.spyOn(storage, "append").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      store.recordToolStarting(id, "call_1", { tool: "bash", target: "Run rm" }),
    ).rejects.toThrow("disk full");
  });
});

describe("artifacts", () => {
  it("returns null for a binary body that is not base64 instead of garbage bytes", async () => {
    const withBinary: Thread = {
      id: "thr_bin",
      taskId: null,
      notePath: null,
      title: "bin",
      status: "done",
      createdAt: T,
      updatedAt: T,
      messages: [],
      artifacts: [
        {
          id: "art_1",
          threadId: "thr_bin",
          title: "x",
          kind: "file",
          mimeType: "application/zip",
          path: ".daily-do-list/artifacts/thr_bin/art_1.zip.b64",
          size: 3,
          createdAt: T,
        },
      ],
      surfaces: [],
    };
    const logger = recordingLogger();
    const storage = vault({
      [threadJournalPath("thr_bin")]: encodePersistedJournalEvent(
        persistedThreadImportEvent(withBinary),
      ),
      ".daily-do-list/artifacts/thr_bin/art_1.zip.b64": "not base64 at all!",
    });
    const store = await loadStore(storage, logger);
    expect(await store.readArtifact("thr_bin", "art_1")).toBeNull();
    expect(logger.entries.map((e) => e.message)).toContain("Artifact body is not valid base64");
  });

  test.prop([fc.uint8Array({ maxLength: 2048 })])(
    "round-trips any binary body through storage and a reload",
    async (bytes) => {
      const storage = vault();
      const store = createThreadStore({ storage, now: () => NOW });
      const created = store.create({ taskId: null, notePath: null, title: "bin" });
      const meta = await store.addArtifact(created.id, {
        title: "blob",
        kind: "file",
        mimeType: "application/octet-stream",
        content: bytes,
      });
      expect(meta.size).toBe(bytes.byteLength);
      expect([...(await store.readArtifact(created.id, meta.id))!.body]).toEqual([...bytes]);
      await store.flush();
      const reloaded = await loadStore(storage);
      expect([...(await reloaded.readArtifact(created.id, meta.id))!.body]).toEqual([...bytes]);
    },
  );

  test.prop([fc.string({ unit: "binary", maxLength: 300 })])(
    "round-trips any text body byte for byte",
    async (body) => {
      const storage = vault();
      const store = createThreadStore({ storage, now: () => NOW });
      const created = store.create({ taskId: null, notePath: null, title: "txt" });
      const meta = await store.addArtifact(created.id, {
        title: "t",
        kind: "text",
        mimeType: "text/plain",
        content: body,
      });
      const read = await store.readArtifact(created.id, meta.id);
      expect([...read!.body]).toEqual([...new TextEncoder().encode(body)]);
      expect(meta.size).toBe(new TextEncoder().encode(body).byteLength);
    },
  );
});

describe("journal performance", () => {
  it("appends only new lines: no journal rewrite, and streaming deltas never touch the journal", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: null, notePath: null, title: "t" });
    for (let i = 0; i < 50; i++) store.upsertMessage(id, text(`m${i}`, i, "x".repeat(200)));
    await store.flush();
    const writes = vi.spyOn(storage, "write");
    const appends = vi.spyOn(storage, "append");
    store.upsertMessage(id, { ...text("s", 99, ""), streaming: true });
    for (let i = 0; i < 500; i++) store.appendDelta(id, "s", "token ");
    expect(appends).not.toHaveBeenCalled();
    store.upsertMessage(id, text("s", 99, "token ".repeat(500)));
    await store.flush();
    expect(writes.mock.calls.filter(([path]) => path.includes("/journal/"))).toEqual([]);
    expect(appends).toHaveBeenCalledTimes(1);
    const appended = appends.mock.calls[0]![1];
    expect(appended.split("\n").filter(Boolean)).toHaveLength(1);
    expect(appended.length).toBeLessThan(4_000);
  });

  it("loads a 10,000-event journal quickly", async () => {
    const storage = vault();
    const store = await loadStore(storage);
    const { id } = store.create({ taskId: null, notePath: null, title: "long" });
    for (let i = 0; i < 10_000; i++) {
      store.upsertMessage(id, text(`m${i}`, T + i, `message ${i} ✓ ünïcødé`));
    }
    await store.flush();
    const started = performance.now();
    const reloaded = await loadStore(storage);
    const elapsed = performance.now() - started;
    expect(reloaded.get(id)!.messages).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1_500 * TIME_SCALE);
  });
});
