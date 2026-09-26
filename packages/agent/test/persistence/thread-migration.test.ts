/**
 * Snapshots older apps wrote (`threads/<id>.json`) move into their journals when the store loads:
 * every golden snapshot becomes a journal that folds to exactly the thread it held, a snapshot and
 * a journal merge as they always did, and the migration never loses anything, whether it runs
 * again, on two devices at once, or next to files it can't read.
 */
import {
  decodePersistedThreadJournal,
  encodePersistedThread,
  mergePersistedThreads,
  persistedThreadImportEvent,
} from "@ddl/contract";
import type { Thread, ThreadMessage } from "@ddl/core";
import { MemoryStorageProvider, SyncEngine } from "@ddl/storage";
import { describe, expect, it, vi } from "vitest";
import { migrateThreadFiles } from "../../src/threads/journal/migrate";
import { ARTIFACTS_DIR, createThreadStore, threadJournalPath } from "../../src/threads/store";
import { NOW, paths, readFixture, recordingLogger, STAMP, sidecar, vault } from "./helpers";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

const V1_ID = "thr_k3j9x0q2m1ab";
const T = 1790154000000;

/** Exactly what threads/v1.json must load as — the compatibility promise for v1 thread files. */
const V1_THREAD: Thread = {
  id: V1_ID,
  taskId: "tsk_7fq2m9x0ab",
  notePath: "Daily/2026-09-23.md",
  title: "Book a dentist appointment for next week 🦷",
  status: "done",
  createdAt: T,
  updatedAt: T + 7000,
  messages: [
    {
      id: "msg_0001",
      kind: "status",
      author: "orchestrator",
      createdAt: T + 1000,
      status: "triaging",
    },
    {
      id: "msg_0002",
      kind: "text",
      role: "agent",
      author: "orchestrator",
      createdAt: T + 2000,
      text: "I'll look for dentists near you with openings next week.",
    },
    {
      id: "msg_0003",
      kind: "tool_call",
      author: "subagent:dentist",
      createdAt: T + 3000,
      toolCallId: "call_01",
      toolName: "web_search",
      label: "Search the web",
      input: { query: "dentist saturday opening example street", limit: 5 },
      status: "ok",
      resultPreview: "3 results",
      endedAt: T + 3500,
    },
    {
      id: "msg_0004",
      kind: "tool_call",
      author: "subagent:dentist",
      createdAt: T + 3600,
      toolCallId: "call_02",
      toolName: "browser_snapshot",
      input: undefined,
      status: "blocked",
    },
    {
      id: "msg_apr_book01",
      kind: "approval",
      author: "system",
      createdAt: T + 4000,
      approvalId: "apr_book01",
    },
    {
      id: "msg_0005",
      kind: "artifact",
      author: "subagent:dentist",
      createdAt: T + 5000,
      artifactId: "art_plan01",
    },
    {
      id: "msg_0006",
      kind: "text",
      role: "user",
      author: "you",
      createdAt: T + 6000,
      text: "Prefer mornings — merci! 午前中がいい。 שלום",
    },
    {
      id: "msg_0007",
      kind: "status",
      author: "orchestrator",
      createdAt: T + 7000,
      status: "done",
      text: "Booked for Tue 09:30",
    },
  ],
  artifacts: [
    {
      id: "art_plan01",
      threadId: V1_ID,
      title: "Shortlist",
      kind: "markdown",
      mimeType: "text/markdown",
      path: `.daily-do-list/artifacts/${V1_ID}/art_plan01.md`,
      size: 127,
      createdAt: T + 5000,
    },
    {
      id: "art_shot01",
      threadId: V1_ID,
      title: "Booking page",
      kind: "image",
      mimeType: "image/png",
      path: `.daily-do-list/artifacts/${V1_ID}/art_shot01.png.b64`,
      size: 70,
      createdAt: T + 5500,
    },
    {
      id: "art_code01",
      threadId: V1_ID,
      title: "Availability script",
      kind: "code",
      mimeType: "text/plain",
      language: "python",
      path: `.daily-do-list/artifacts/${V1_ID}/art_code01.py`,
      size: 21,
      createdAt: T + 5600,
    },
  ],
  surfaces: ["browser"],
};

const artifactFiles = {
  [`${ARTIFACTS_DIR}/${V1_ID}/art_plan01.md`]: readFixture("artifacts", `${V1_ID}/art_plan01.md`),
  [`${ARTIFACTS_DIR}/${V1_ID}/art_shot01.png.b64`]: readFixture(
    "artifacts",
    `${V1_ID}/art_shot01.png.b64`,
  ),
  [`${ARTIFACTS_DIR}/${V1_ID}/art_orphan.txt`]: readFixture("artifacts", `${V1_ID}/art_orphan.txt`),
};

const text = (id: string, createdAt: number, body = id): ThreadMessage => ({
  id,
  kind: "text",
  role: "agent",
  author: "orchestrator",
  createdAt,
  text: body,
});

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  taskId: null,
  notePath: null,
  title: id,
  status: "idle",
  createdAt: T,
  updatedAt: T,
  messages: [],
  artifacts: [],
  surfaces: [],
  ...extra,
});

const snapshotPath = (name: string) => `.daily-do-list/threads/${name}.json`;
const COPY = " (conflict 2026-09-23 1830)";

async function loadStore(storage: MemoryStorageProvider, logger = recordingLogger()) {
  const store = createThreadStore({ storage, now: () => NOW, logger, flushDelayMs: 1 });
  await store.load();
  return store;
}

async function journalOf(storage: MemoryStorageProvider, id: string) {
  const file = await storage.read(threadJournalPath(id));
  return file ? decodePersistedThreadJournal(file.content, id) : null;
}

/** A journal a store wrote: `t` created at its `createdAt`, then its messages and status. */
async function journaled(storage: MemoryStorageProvider, t: Thread): Promise<void> {
  let clock = t.createdAt;
  const store = createThreadStore({ storage, now: () => clock });
  store.create({ id: t.id, taskId: t.taskId, notePath: t.notePath, title: t.title });
  clock = t.updatedAt;
  for (const message of t.messages) store.upsertMessage(t.id, message);
  store.setStatus(t.id, t.status);
  await store.flush();
}

describe("golden snapshots become journals", () => {
  it("v1.json: a journal holding exactly this thread, its artifact bodies untouched, no snapshot", async () => {
    const files = { [snapshotPath(V1_ID)]: readFixture("threads", "v1.json"), ...artifactFiles };
    const storage = vault(files);
    const store = await loadStore(storage);
    expect(store.get(V1_ID)).toEqual(V1_THREAD);
    expect(store.findByTask("tsk_7fq2m9x0ab")?.id).toBe(V1_ID);

    const plan = await store.readArtifact(V1_ID, "art_plan01");
    expect(new TextDecoder().decode(plan!.body)).toBe(
      files[`${ARTIFACTS_DIR}/${V1_ID}/art_plan01.md`],
    );
    expect(plan!.body.byteLength).toBe(127);
    const shot = await store.readArtifact(V1_ID, "art_shot01");
    expect(shot!.body.byteLength).toBe(70);
    expect([...shot!.body.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // Metadata whose body was never written, and a body without metadata.
    expect(await store.readArtifact(V1_ID, "art_code01")).toBeNull();
    expect(await store.readArtifact(V1_ID, "art_orphan")).toBeNull();

    await store.flush();
    const { [snapshotPath(V1_ID)]: _, ...rest } = files;
    const { [threadJournalPath(V1_ID)]: journal, ...others } = await sidecar(storage);
    expect(others).toEqual(rest);
    expect(decodePersistedThreadJournal(journal!, V1_ID).events).toEqual([
      persistedThreadImportEvent(V1_THREAD),
    ]);
    expect((await loadStore(storage)).get(V1_ID)).toEqual(V1_THREAD);
  });

  it("v1-minimal.json and the BOM + CRLF v1-bom.json load exactly", async () => {
    const storage = vault({
      [snapshotPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      [snapshotPath("thr_bom00000001")]: readFixture("threads", "v1-bom.json"),
    });
    const store = await loadStore(storage);
    expect(store.get("thr_minimal0001")).toEqual(thread("thr_minimal0001", { title: "" }));
    expect(store.get("thr_bom00000001")).toEqual(
      thread("thr_bom00000001", {
        taskId: "tsk_bom000001",
        notePath: "Daily/2026-09-23.md",
        title: "Saved by Notepad with a byte order mark",
        status: "queued",
        surfaces: ["computer"],
      }),
    );
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([]);
  });

  it("v1-invalid-entries.json drops what it must and keeps the original in corrupt/", async () => {
    const original = readFixture("threads", "v1-invalid-entries.json");
    const storage = vault({ [snapshotPath("thr_partial0001")]: original });
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    const expected = thread("thr_partial0001", {
      taskId: "tsk_partial01",
      notePath: "Daily/2026-09-23.md",
      title: "Renew passport",
      status: "working",
      updatedAt: T + 3000,
      messages: [
        text("msg_a", T + 1000, "On it — checking the renewal form."),
        {
          id: "msg_e",
          kind: "text",
          role: "user",
          author: "you",
          createdAt: T + 2000,
          text: "Thanks",
        },
      ],
      artifacts: [
        {
          id: "art_ok",
          threadId: "thr_partial0001",
          title: "Form",
          kind: "text",
          mimeType: "text/plain",
          path: ".daily-do-list/artifacts/thr_partial0001/art_ok.txt",
          size: 4,
          createdAt: T + 2500,
        },
      ],
      surfaces: ["browser"],
    });
    expect(store.get("thr_partial0001")).toEqual(expected);
    // The artifact pointing at approvals.json was dropped, so it can never be served.
    expect(await store.readArtifact("thr_partial0001", "art_escape")).toBeNull();
    expect(Object.keys(await sidecar(storage)).sort()).toEqual([
      `.daily-do-list/corrupt/threads/thr_partial0001.${STAMP}.json`,
      threadJournalPath("thr_partial0001"),
    ]);
    expect(
      (await storage.read(`.daily-do-list/corrupt/threads/thr_partial0001.${STAMP}.json`))!.content,
    ).toBe(original);
    expect(logger.text()).not.toContain("renewal form");
  });

  it("legacy-unversioned.json loads with interrupted messages finished", async () => {
    const storage = vault({
      [snapshotPath("thr_legacy00001")]: readFixture("threads", "legacy-unversioned.json"),
    });
    const store = await loadStore(storage);
    expect(store.get("thr_legacy00001")).toEqual(
      thread("thr_legacy00001", {
        taskId: "tsk_legacy0001",
        notePath: "Daily/2026-09-22.md",
        title: "Email the landlord about the faucet",
        status: "waiting_user",
        createdAt: 1790067600000,
        updatedAt: 1790067660000,
        messages: [
          text("msg_l1", 1790067610000, "Should I cc your partner?"),
          {
            id: "msg_l2",
            kind: "text",
            role: "agent",
            author: "subagent:email",
            createdAt: 1790067650000,
            text: "Drafting the email…",
            streaming: false,
          },
        ],
      }),
    );
  });

  it("legacy-unversioned-sparse.json gets the defaults the old reader applied", async () => {
    const storage = vault({
      [snapshotPath("thr_sparse00001")]: readFixture("threads", "legacy-unversioned-sparse.json"),
    });
    const store = await loadStore(storage);
    expect(store.get("thr_sparse00001")).toEqual(
      thread("thr_sparse00001", {
        title: "Water the plants",
        createdAt: 1790067600000,
        updatedAt: 1790067600000,
      }),
    );
  });

  it.each([
    "corrupt-truncated.json",
    "corrupt-empty.json",
    "corrupt-not-object.json",
    "corrupt-unsafe-id.json",
  ])("%s is left untouched and reported; other threads still move", async (name) => {
    const content = readFixture("threads", name);
    const storage = vault({
      [`.daily-do-list/threads/${name}`]: content,
      [snapshotPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
    });
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.list().map((t) => t.id)).toEqual(["thr_minimal0001"]);
    expect(await paths(storage)).toEqual([
      threadJournalPath("thr_minimal0001"),
      `.daily-do-list/threads/${name}`,
    ]);
    expect((await storage.read(`.daily-do-list/threads/${name}`))!.content).toBe(content);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: "Left a thread snapshot alone",
        fields: expect.objectContaining({ path: `.daily-do-list/threads/${name}` }),
      }),
    );
  });

  it("future-version.json is left alone and never journaled, even with an older copy", async () => {
    const files = {
      [snapshotPath("thr_future00001")]: readFixture("threads", "future-version.json"),
      [snapshotPath(`thr_future00001${COPY}`)]: encodePersistedThread(thread("thr_future00001")),
    };
    const storage = vault(files);
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.list()).toEqual([]);
    await store.flush();
    expect(await sidecar(storage)).toEqual(files);
    expect(logger.entries.some((e) => e.message.includes("newer version"))).toBe(true);
  });

  it("a whole vault of fixtures: good ones journaled, the rest untouched", async () => {
    const untouched = {
      [snapshotPath("thr_future00001")]: readFixture("threads", "future-version.json"),
      ".daily-do-list/threads/corrupt-truncated.json": readFixture(
        "threads",
        "corrupt-truncated.json",
      ),
      ".daily-do-list/threads/corrupt-empty.json": readFixture("threads", "corrupt-empty.json"),
    };
    const storage = vault({
      [snapshotPath(V1_ID)]: readFixture("threads", "v1.json"),
      [snapshotPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      [snapshotPath("thr_partial0001")]: readFixture("threads", "v1-invalid-entries.json"),
      [snapshotPath("thr_bom00000001")]: readFixture("threads", "v1-bom.json"),
      [snapshotPath("thr_legacy00001")]: readFixture("threads", "legacy-unversioned.json"),
      [snapshotPath("thr_sparse00001")]: readFixture("threads", "legacy-unversioned-sparse.json"),
      ...untouched,
    });
    const store = await loadStore(storage);
    const ids = store
      .list()
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual([
      "thr_bom00000001",
      "thr_k3j9x0q2m1ab",
      "thr_legacy00001",
      "thr_minimal0001",
      "thr_partial0001",
      "thr_sparse00001",
    ]);
    const after = await sidecar(storage);
    expect(Object.keys(after).filter((p) => p.startsWith(".daily-do-list/threads/"))).toEqual(
      Object.keys(untouched).sort(),
    );
    for (const [path, content] of Object.entries(untouched)) expect(after[path]).toBe(content);
    const reloaded = await loadStore(storage);
    for (const id of ids) expect(reloaded.get(id)).toEqual(store.get(id));
  });
});

describe("a snapshot next to a journal merges as it always did", () => {
  const base = thread("thr_both", {
    taskId: "tsk_1",
    notePath: "Daily/2026-09-23.md",
    title: "Book",
    status: "working",
    updatedAt: T + 2,
    messages: [text("m1", T + 1), text("m2", T + 2)],
  });

  it("a journal ahead of its snapshot wins, and nothing is appended", async () => {
    const storage = vault();
    await journaled(storage, { ...base, status: "done" });
    const journal = (await storage.read(threadJournalPath(base.id)))!.content;
    const stale = { ...base, messages: [text("m1", T + 1)], updatedAt: T + 1 };
    await storage.write(snapshotPath(base.id), encodePersistedThread(stale));
    const store = await loadStore(storage);
    expect(store.get(base.id)).toMatchObject({
      status: "done",
      messages: [{ id: "m1" }, { id: "m2" }],
    });
    expect(await sidecar(storage)).toEqual({ [threadJournalPath(base.id)]: journal });
  });

  it("a stale snapshot never brings trimmed messages back", async () => {
    const storage = vault();
    await journaled(storage, base);
    const trimming = await loadStore(storage);
    trimming.trimMessages(base.id, 1);
    await trimming.flush();
    await storage.write(snapshotPath(base.id), encodePersistedThread(base));
    const store = await loadStore(storage);
    expect(store.get(base.id)!.messages.map((m) => m.id)).toEqual(["m2"]);
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([]);
  });

  it("a snapshot ahead of its journal (an older app, text streamed before a crash) is imported last", async () => {
    const storage = vault();
    await journaled(storage, base);
    const fromJournal = (await loadStore(storage)).get(base.id)!;
    const ahead = {
      ...base,
      status: "waiting_user" as const,
      updatedAt: T + 50,
      messages: [
        ...base.messages,
        text("from-old-app", T + 5),
        { ...text("s1", T + 6, "half a"), streaming: true },
      ],
    };
    await storage.write(snapshotPath(base.id), encodePersistedThread(ahead));
    const store = await loadStore(storage);
    const expected = mergePersistedThreads(fromJournal, {
      ...ahead,
      messages: ahead.messages.map((m) => ({
        ...m,
        ...(m.kind === "text" && m.streaming ? { streaming: false } : {}),
      })),
    });
    expect(store.get(base.id)).toEqual(expected);
    expect(store.get(base.id)).toMatchObject({ status: "waiting_user" });
    const journal = (await journalOf(storage, base.id))!;
    expect(journal.events.at(-1)).toMatchObject({ type: "thread.imported", seq: journal.maxSeq });
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([]);
    expect((await loadStore(storage)).get(base.id)).toEqual(expected);
  });

  it("sync conflict copies merge in after the thread's own file, newest first", async () => {
    const ours = thread("thr_c", {
      messages: [text("a", 1), text("b", 2)],
      title: "ours",
      updatedAt: 5,
    });
    const theirs = thread("thr_c", {
      messages: [text("a", 1), text("c", 3)],
      title: "theirs",
      updatedAt: 9,
    });
    const older = thread("thr_c", { messages: [text("d", 4)], title: "older", updatedAt: 7 });
    const storage = vault({
      [snapshotPath("thr_c")]: encodePersistedThread(ours),
      [snapshotPath(`thr_c${COPY}`)]: encodePersistedThread(theirs),
      [snapshotPath("thr_c 2")]: encodePersistedThread(older),
    });
    const store = await loadStore(storage);
    const merged = mergePersistedThreads(mergePersistedThreads(ours, theirs), older);
    expect(store.get("thr_c")).toEqual(merged);
    expect(merged).toMatchObject({ title: "theirs", updatedAt: 9 });
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(await paths(storage)).toEqual([threadJournalPath("thr_c")]);
    expect((await journalOf(storage, "thr_c"))!.events.map((e) => e.type)).toEqual([
      "thread.imported",
      "thread.imported",
      "thread.imported",
    ]);
  });

  it.each(["corrupt-garbage.jsonl", "corrupt-empty.jsonl"])(
    "%s next to a snapshot: the import goes after what's there, on a fresh line",
    async (name) => {
      const garbage = readFixture("thread-journal", name);
      const storage = vault({
        [threadJournalPath("thr_minimal0001")]: garbage,
        [snapshotPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      });
      const store = await loadStore(storage);
      expect(store.get("thr_minimal0001")).toEqual(thread("thr_minimal0001", { title: "" }));
      const journal = (await storage.read(threadJournalPath("thr_minimal0001")))!.content;
      expect(journal.startsWith(garbage)).toBe(true);
      expect(journal.slice(garbage.length)).toMatch(/^\n?\{"v":1/);
      expect(await paths(storage, ".daily-do-list/threads")).toEqual([]);
    },
  );

  it("a journal a newer app wrote keeps its snapshot, and nothing about the thread is written", async () => {
    const files = {
      [threadJournalPath("thr_journal00005")]: readFixture(
        "thread-journal",
        "future-version.jsonl",
      ),
      [snapshotPath("thr_journal00005")]: encodePersistedThread(thread("thr_journal00005")),
    };
    const storage = vault(files);
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    expect(await sidecar(storage)).toEqual(files);
  });
});

describe("conflict copies of journals a third-party sync made", () => {
  const line = (id: string, seq: number, message: ThreadMessage) =>
    `${JSON.stringify({ v: 1, id, epoch: 0, seq, at: T + seq, type: "message", message })}\n`;

  it("merge into the journal as a union of events, then go", async () => {
    const storage = vault();
    await journaled(storage, thread("thr_a", { messages: [text("m1", T + 1)] }));
    const shared = (await storage.read(threadJournalPath("thr_a")))!.content;
    await storage.append!(threadJournalPath("thr_a"), line("evt_ours", 9, text("ours", T + 9)));
    await storage.write(
      ".daily-do-list/state/journal/threads/thr_a 2.jsonl",
      shared + line("evt_theirs", 9, text("theirs", T + 8)),
    );
    const store = await loadStore(storage);
    expect(store.get("thr_a")!.messages.map((m) => m.id)).toEqual(["m1", "ours", "theirs"]);
    expect(await paths(storage)).toEqual([threadJournalPath("thr_a")]);
    expect((await loadStore(storage)).get("thr_a")).toEqual(store.get("thr_a"));
  });

  it("are left alone when they don't say which thread they belong to", async () => {
    const orphan = ".daily-do-list/state/journal/threads/thr_a (conflicted copy).jsonl";
    const storage = vault({ [orphan]: line("evt_1", 1, text("m1", T)) });
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.list()).toEqual([]);
    expect(await paths(storage)).toEqual([orphan]);
    expect(logger.entries.map((e) => e.message)).toContain("Left a thread journal copy alone");
  });
});

describe("the migration never loses anything", () => {
  it("is idempotent, even after a crash between the append and the removal", async () => {
    const snapshot = encodePersistedThread(thread("thr_a", { messages: [text("m1", T)] }));
    const storage = vault({ [snapshotPath("thr_a")]: snapshot });
    const context = { storage, logger: recordingLogger(), now: () => NOW };
    await migrateThreadFiles(context);
    const migrated = await sidecar(storage);
    await migrateThreadFiles(context);
    expect(await sidecar(storage)).toEqual(migrated);
    // The snapshot is back, as if the process died before removing it: it goes, nothing is added.
    await storage.write(snapshotPath("thr_a"), snapshot);
    await migrateThreadFiles(context);
    expect(await sidecar(storage)).toEqual(migrated);
  });

  it("removes a snapshot found again whose import the journal already holds, even superseded", async () => {
    const snapshot = encodePersistedThread(
      thread("thr_a", { sources: [{ url: "https://old.example" }] }),
    );
    const storage = vault({ [snapshotPath("thr_a")]: snapshot });
    const store = await loadStore(storage);
    // Fifty newer pages push the snapshot's out of the capped list.
    store.addSources(
      "thr_a",
      Array.from({ length: 50 }, (_, i) => ({ url: `https://new.example/${i}` })),
    );
    await store.flush();
    const journal = (await storage.read(threadJournalPath("thr_a")))!.content;
    await storage.write(snapshotPath("thr_a"), snapshot);
    const reloaded = await loadStore(storage);
    expect(reloaded.get("thr_a")!.sources).toHaveLength(50);
    expect(await sidecar(storage)).toEqual({ [threadJournalPath("thr_a")]: journal });
  });

  it("keeps a snapshot rewritten while it was migrated, and moves it at the next load", async () => {
    const storage = vault({ [snapshotPath("thr_a")]: encodePersistedThread(thread("thr_a")) });
    const rewritten = thread("thr_a", { messages: [text("late", T + 1)], updatedAt: T + 1 });
    const remove = storage.delete.bind(storage);
    vi.spyOn(storage, "delete").mockImplementationOnce(async (path, options) => {
      await storage.write(path, encodePersistedThread(rewritten));
      return remove(path, options);
    });
    const first = await loadStore(storage);
    expect(first.get("thr_a")!.messages).toEqual([]);
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([snapshotPath("thr_a")]);
    const second = await loadStore(storage);
    expect(second.get("thr_a")).toEqual(rewritten);
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([]);
  });

  it("two stores loading one vault at once write each import once", async () => {
    const storage = vault({
      [snapshotPath(V1_ID)]: readFixture("threads", "v1.json"),
      [snapshotPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
    });
    const [a, b] = await Promise.all([loadStore(storage), loadStore(storage)]);
    expect(a.list()).toEqual(b.list());
    expect(await paths(storage)).toEqual([
      threadJournalPath(V1_ID),
      threadJournalPath("thr_minimal0001"),
    ]);
    for (const id of [V1_ID, "thr_minimal0001"]) {
      expect((await storage.read(threadJournalPath(id)))!.content.split("\n")).toHaveLength(2);
    }
  });

  it("two devices migrating at once through the sync engine end with the same journals, each import once", async () => {
    const only = thread("thr_only", { messages: [text("o1", T + 1)], updatedAt: T + 1 });
    const onlyCopy = thread("thr_only", { messages: [text("o2", T + 2)], updatedAt: T + 2 });
    const behind = thread("thr_behind", {
      taskId: "tsk_b",
      messages: [text("b1", T + 1)],
      updatedAt: T + 1,
    });
    const seed = vault();
    await journaled(seed, behind);
    const journalFold = (await loadStore(seed)).get("thr_behind")!;
    const ahead = {
      ...journalFold,
      status: "done" as const,
      updatedAt: T + 9,
      messages: [...journalFold.messages, text("b2", T + 9)],
    };
    const files = {
      ...(await sidecar(seed)),
      [snapshotPath("thr_only")]: encodePersistedThread(only),
      [snapshotPath(`thr_only${COPY}`)]: encodePersistedThread(onlyCopy),
      [snapshotPath("thr_behind")]: encodePersistedThread(ahead),
    };
    const target = new MemoryStorageProvider({ now: () => NOW });
    const devices = [vault(files), vault(files)];
    const engines = devices.map((primary) => new SyncEngine({ primary, target, now: () => NOW }));
    const syncAll = async () => {
      for (let round = 0; round < 2; round++) for (const engine of engines) await engine.syncOnce();
    };
    await syncAll();

    const stores = await Promise.all(devices.map((storage) => loadStore(storage)));
    await syncAll();

    const expected = {
      thr_only: mergePersistedThreads(only, onlyCopy),
      thr_behind: mergePersistedThreads(journalFold, ahead),
    };
    const imports = { thr_only: 2, thr_behind: 1 };
    const synced = await Promise.all(
      devices.map(async (storage) =>
        Object.fromEntries(
          Object.entries(await sidecar(storage)).filter(([path]) => !path.includes("/sync/")),
        ),
      ),
    );
    expect(synced[1]).toEqual(synced[0]);
    expect(Object.keys(synced[0]!).sort()).toEqual([
      threadJournalPath("thr_behind"),
      threadJournalPath("thr_only"),
    ]);
    for (const [i, storage] of devices.entries()) {
      for (const [id, want] of Object.entries(expected)) {
        expect(stores[i]!.get(id)).toEqual(want);
        const raw = (await storage.read(threadJournalPath(id)))!.content.trimEnd().split("\n");
        const events = (await journalOf(storage, id))!.events;
        expect(raw.length).toBe(events.length);
        expect(events.filter((e) => e.type === "thread.imported")).toHaveLength(
          imports[id as keyof typeof imports],
        );
        expect((await loadStore(storage)).get(id)).toEqual(want);
      }
    }
  });

  it("never follows a crafted thread id out of the threads folder (regression)", async () => {
    // Before ids were validated, a thread with id "../state/records" was saved over records.json.
    const records = '{"version":1,"records":[],"specs":{}}\n';
    const crafted = JSON.stringify({
      ...thread("x"),
      id: "../state/records",
      messages: [text("m", T)],
    });
    const storage = vault({
      ".daily-do-list/state/records.json": records,
      [snapshotPath(`crafted${COPY}`)]: crafted,
    });
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    expect(await sidecar(storage)).toEqual({
      ".daily-do-list/state/records.json": records,
      [snapshotPath(`crafted${COPY}`)]: crafted,
    });
  });

  it("leaves a file named after another thread alone instead of guessing its owner", async () => {
    const storage = vault({ [snapshotPath("thr_a")]: encodePersistedThread(thread("thr_b")) });
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    expect(await paths(storage)).toEqual([snapshotPath("thr_a")]);
  });

  it("migrates a 10,000-message thread quickly", async () => {
    const messages = Array.from({ length: 10_000 }, (_, i) =>
      text(`m${i}`, T + i, `message ${i} ✓ ünïcødé`),
    );
    const storage = vault({
      [snapshotPath("thr_huge")]: encodePersistedThread(thread("thr_huge", { messages })),
    });
    const started = performance.now();
    const store = await loadStore(storage);
    const elapsed = performance.now() - started;
    expect(store.get("thr_huge")!.messages).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(1_500 * TIME_SCALE);
  });
});
