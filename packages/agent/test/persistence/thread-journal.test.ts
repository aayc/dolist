/**
 * The thread store on its journal: golden journals load exactly, snapshot-only threads migrate
 * without losing anything, the snapshot written from the journal is what the old store wrote,
 * crash windows between the two files lose nothing, and appends never rewrite a file.
 */
import {
  decodePersistedThread,
  decodePersistedThreadJournal,
  encodePersistedThread,
  PersistedThreadFileSchema,
} from "@ddl/contract";
import type { TextMessage, Thread, ThreadMessage } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { messageArb } from "../../../contract/test/persisted/arbitraries";
import { createThreadStore, threadJournalPath, threadPath } from "../../src/threads/store";
import type { ThreadStoreEvent } from "../../src/threads/types";
import { createLegacyThreadStore } from "../helpers/legacy-thread-store";
import { NOW, paths, readFixture, recordingLogger, sidecar, vault } from "./helpers";

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

/** Everything except the snapshot: what a device that only has the journal would load. */
async function withoutSnapshot(storage: MemoryStorageProvider, id: string) {
  const files = await sidecar(storage);
  delete files[threadPath(id)];
  return vault(files);
}

describe("golden journals through the real thread store", () => {
  it("v1.jsonl folds to exactly this thread, and the snapshot is written from it", async () => {
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
      { callId: "call_03", tool: "computer_open_app", target: "Open Slack", startedAt: T + 9000 },
    ]);
    await store.flush();
    expect((await storage.read(threadPath(id)))!.content).toBe(encodePersistedThread(expected));
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
    const reloaded = await loadStore(await withoutSnapshot(storage, id));
    expect(reloaded.get(id)).toEqual(store.get(id));
  });

  it("future-version.jsonl: the thread is skipped and nothing about it is written", async () => {
    const id = "thr_journal00005";
    const files = {
      [threadJournalPath(id)]: readFixture("thread-journal", "future-version.jsonl"),
      [threadPath(id)]: encodePersistedThread({
        id,
        taskId: null,
        notePath: null,
        title: "From the future",
        status: "working",
        createdAt: T,
        updatedAt: T,
        messages: [],
        artifacts: [],
        surfaces: [],
      }),
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

  it.each(["corrupt-garbage.jsonl", "corrupt-empty.jsonl"])(
    "%s: the thread loads from its snapshot and new events go after what's there",
    async (name) => {
      const id = "thr_minimal0001";
      const garbage = readFixture("thread-journal", name);
      const storage = vault({
        [threadJournalPath(id)]: garbage,
        [threadPath(id)]: readFixture("threads", "v1-minimal.json"),
      });
      const store = await loadStore(storage);
      expect(store.get(id)).toMatchObject({ id, title: "" });
      store.setTitle(id, "Named at last");
      await store.flush();
      const journal = (await storage.read(threadJournalPath(id)))!.content;
      expect(journal.startsWith(garbage)).toBe(true);
      const reloaded = await loadStore(await withoutSnapshot(storage, id));
      expect(reloaded.get(id)).toEqual(store.get(id));
    },
  );
});

describe("migrating snapshot-only threads", () => {
  it("writes nothing on load; the first change starts the journal with the thread as loaded", async () => {
    const id = "thr_k3j9x0q2m1ab";
    const snapshotText = readFixture("threads", "v1.json");
    const storage = vault({ [threadPath(id)]: snapshotText });
    const store = await loadStore(storage);
    await store.flush();
    expect(await paths(storage)).toEqual([threadPath(id)]);
    const loaded = store.get(id)!;

    store.upsertMessage(id, text("msg_new", NOW, "Picking this back up"));
    await store.flush();
    const journal = (await journalOf(storage, id))!;
    expect(journal.issues).toEqual([]);
    expect(journal.events.map((e) => e.type)).toEqual(["thread.imported", "message"]);
    const imported = journal.events[0]!;
    expect(imported.type === "thread.imported" && imported.thread).toEqual(loaded);

    const fromJournal = await loadStore(await withoutSnapshot(storage, id));
    expect(fromJournal.get(id)).toEqual(store.get(id));
    const fromBoth = await loadStore(storage);
    const before = await sidecar(storage);
    await fromBoth.flush();
    expect(await sidecar(storage)).toEqual(before);
    expect(fromBoth.get(id)).toEqual(store.get(id));
  });

  it("migrates every golden thread losslessly, conflict copies merged in", async () => {
    const files: Record<string, string> = {
      [threadPath("thr_k3j9x0q2m1ab")]: readFixture("threads", "v1.json"),
      [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      [threadPath("thr_partial0001")]: readFixture("threads", "v1-invalid-entries.json"),
      [threadPath("thr_bom00000001")]: readFixture("threads", "v1-bom.json"),
      [threadPath("thr_legacy00001")]: readFixture("threads", "legacy-unversioned.json"),
      [threadPath("thr_sparse00001")]: readFixture("threads", "legacy-unversioned-sparse.json"),
      ".daily-do-list/threads/thr_minimal0001 (conflict 2026-09-23 1830).json":
        encodePersistedThread({
          id: "thr_minimal0001",
          taskId: null,
          notePath: null,
          title: "",
          status: "idle",
          createdAt: T,
          updatedAt: T,
          messages: [text("from-the-copy", T + 1)],
          artifacts: [],
          surfaces: [],
        }),
    };
    const storage = vault(files);
    const store = await loadStore(storage);
    const ids = store.list().map((t) => t.id);
    const before = Object.fromEntries(ids.map((id) => [id, store.get(id)!]));
    expect(before.thr_minimal0001!.messages.map((m) => m.id)).toEqual(["from-the-copy"]);
    for (const id of ids) store.setTitle(id, `${before[id]!.title} ✓`);
    await store.flush();
    const onlyJournals = vault(
      Object.fromEntries(
        Object.entries(await sidecar(storage)).filter(([path]) => path.includes("/journal/")),
      ),
    );
    const reloaded = await loadStore(onlyJournals);
    for (const id of ids) {
      expect(reloaded.get(id)).toEqual({ ...before[id], title: `${before[id]!.title} ✓` });
    }
  });

  it("never journals a thread whose own snapshot a newer app wrote", async () => {
    const future = readFixture("threads", "future-version.json");
    const storage = vault({ [threadPath("thr_future00001")]: future });
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    expect(
      await store.recordToolStarting("thr_future00001", "call_1", { tool: "x", target: "x" }),
    ).toBe(false);
    await store.flush();
    expect(await paths(storage)).toEqual([threadPath("thr_future00001")]);
  });
});

describe("the snapshot follows the journal", () => {
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
    "writes byte for byte the snapshot the old store wrote, and reloads to the same thread",
    async (ops, flushMidway) => {
      let clock = T;
      const now = () => clock;
      const ours = new MemoryStorageProvider({ now });
      const theirs = new MemoryStorageProvider({ now });
      const store = createThreadStore({ storage: ours, now, flushDelayMs: 1_000_000 });
      const legacy = createLegacyThreadStore({ storage: theirs, now, flushDelayMs: 1_000_000 });
      const id = store.create({
        id: "thr_p",
        taskId: "tsk_p",
        notePath: "Daily/x.md",
        title: "p",
      }).id;
      legacy.create({ id, taskId: "tsk_p", notePath: "Daily/x.md", title: "p" });
      for (const [i, o] of ops.entries()) {
        for (const s of [store, legacy]) {
          switch (o.kind) {
            case "message":
              s.upsertMessage(id, o.message);
              break;
            case "stream":
              s.upsertMessage(id, { ...text(o.id, clock, ""), streaming: true });
              for (const word of o.words) s.appendDelta(id, o.id, word);
              s.upsertMessage(id, text(o.id, clock, o.words.join("")));
              break;
            case "status":
              s.setStatus(id, o.status);
              break;
            case "title":
              s.setTitle(id, o.title);
              break;
            case "surface":
              s.addSurface(id, o.surface);
              break;
            case "trim":
              s.trimMessages(id, o.keep);
              break;
            case "sources":
              s.addSources(
                id,
                o.urls.map((url) => ({ url, title: `t${i}` })),
              );
              break;
            case "tick":
              break;
          }
        }
        clock += 7;
        if (flushMidway && i === Math.floor(ops.length / 2)) {
          await Promise.all([store.flush(), legacy.flush()]);
        }
      }
      await Promise.all([store.flush(), legacy.flush()]);
      const ourSnapshot = (await ours.read(threadPath(id)))!.content;
      expect(ourSnapshot).toBe((await theirs.read(threadPath(id)))!.content);
      expect(PersistedThreadFileSchema.safeParse(JSON.parse(ourSnapshot)).success).toBe(true);
      expect(store.get(id)).toEqual(legacy.get(id));
      const reloaded = createThreadStore({ storage: await withoutSnapshot(ours, id), now });
      await reloaded.load();
      expect(reloaded.get(id)).toEqual(store.get(id));
    },
  );
});

describe("crash windows between the journal and the snapshot", () => {
  async function running() {
    const storage = vault();
    const store = createThreadStore({ storage, now: () => NOW, flushDelayMs: 1 });
    await store.load();
    const { id } = store.create({ taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "t" });
    store.upsertMessage(id, text("m1", 1));
    await store.flush();
    return { storage, store, id };
  }

  it("a journal ahead of its snapshot (killed before the snapshot write) wins and the snapshot catches up", async () => {
    const { storage, store, id } = await running();
    const stale = (await storage.read(threadPath(id)))!.content;
    store.upsertMessage(id, text("m2", 2));
    store.setStatus(id, "done");
    await store.flush();
    storage.simulateExternalChange(threadPath(id), stale);
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)).toEqual(store.get(id));
    await reloaded.flush();
    expect(decodePersistedThread((await storage.read(threadPath(id)))!.content)).toMatchObject({
      ok: true,
      value: store.get(id),
    });
  });

  it("a snapshot ahead of its journal (text streamed but never finished) keeps that text", async () => {
    const { storage, store, id } = await running();
    store.upsertMessage(id, { ...text("s1", 3, ""), streaming: true });
    store.appendDelta(id, "s1", "half a sentence");
    store.setTitle(id, "renamed");
    // The snapshot was written with the partial text; the process died before anything else.
    const snapshotText = encodePersistedThread(store.get(id)!);
    storage.simulateExternalChange(threadPath(id), snapshotText);
    const journalText = (await storage.read(threadJournalPath(id)))!.content;
    const crashed = vault({ [threadPath(id)]: snapshotText, [threadJournalPath(id)]: journalText });
    const reloaded = await loadStore(crashed);
    expect(reloaded.get(id)!.messages.map((m) => [m.id, m.kind === "text" && m.text])).toEqual([
      ["m1", "m1"],
      ["s1", "half a sentence"],
    ]);
    await reloaded.flush();
    const fromJournal = await loadStore(await withoutSnapshot(crashed, id));
    expect(fromJournal.get(id)!.messages.map((m) => m.id)).toEqual(["m1", "s1"]);
  });

  it("an older app's changes to the snapshot are imported, not dropped", async () => {
    const { storage, store, id } = await running();
    await store.flush();
    const old = createLegacyThreadStore({ storage, now: () => NOW + 50, flushDelayMs: 1 });
    await old.load();
    old.upsertMessage(id, text("from-old-app", 5));
    old.setStatus(id, "waiting_user");
    await old.flush();
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)).toMatchObject({
      status: "waiting_user",
      messages: [{ id: "m1" }, { id: "from-old-app" }],
    });
    await reloaded.flush();
    const journal = (await journalOf(storage, id))!;
    expect(journal.events.at(-1)?.type).toBe("thread.imported");
    const fromJournal = await loadStore(await withoutSnapshot(storage, id));
    expect(fromJournal.get(id)).toEqual(reloaded.get(id));
  });

  it("a stale snapshot never brings trimmed messages back", async () => {
    const { storage, store, id } = await running();
    for (let i = 2; i <= 5; i++) store.upsertMessage(id, text(`m${i}`, i));
    await store.flush();
    const stale = (await storage.read(threadPath(id)))!.content;
    store.trimMessages(id, 2);
    await store.flush();
    storage.simulateExternalChange(threadPath(id), stale);
    const reloaded = await loadStore(storage);
    expect(reloaded.get(id)!.messages.map((m) => m.id)).toEqual(["m4", "m5"]);
  });
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
    const reloaded = await loadStore(await withoutSnapshot(storage, id));
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
    const reloaded = await loadStore(await withoutSnapshot(storage, id));
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
