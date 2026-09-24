import {
  decodePersistedThread,
  encodePersistedThread,
  PersistedThreadFileSchema,
} from "@ddl/contract";
import type { Thread, ThreadMessage } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { messageArb } from "../../../contract/test/persisted/arbitraries";
import { ARTIFACTS_DIR, createThreadStore, threadPath } from "../../src/threads/store";
import type { ThreadStoreEvent } from "../../src/threads/types";
import { NOW, paths, readFixture, recordingLogger, STAMP, sidecar, vault } from "./helpers";

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

async function loadStore(storage: ReturnType<typeof vault>, logger = recordingLogger()) {
  const store = createThreadStore({ storage, now: () => NOW, logger, flushDelayMs: 1 });
  await store.load();
  return store;
}

describe("golden thread fixtures through the real thread store", () => {
  it("v1.json loads exactly, with its artifact bodies, and is not rewritten", async () => {
    const files = { [threadPath(V1_ID)]: readFixture("threads", "v1.json"), ...artifactFiles };
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
    expect(await sidecar(storage)).toEqual(files);
  });

  it("v1-minimal.json and the BOM + CRLF v1-bom.json load exactly", async () => {
    const storage = vault({
      [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      [threadPath("thr_bom00000001")]: readFixture("threads", "v1-bom.json"),
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
  });

  it("v1-invalid-entries.json drops what it must, keeps a copy, then repairs the file", async () => {
    const original = readFixture("threads", "v1-invalid-entries.json");
    const storage = vault({ [threadPath("thr_partial0001")]: original });
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

    await store.flush();
    const after = await sidecar(storage);
    expect(Object.keys(after).sort()).toEqual([
      `.daily-do-list/corrupt/threads/thr_partial0001.${STAMP}.json`,
      threadPath("thr_partial0001"),
    ]);
    expect(after[`.daily-do-list/corrupt/threads/thr_partial0001.${STAMP}.json`]).toBe(original);
    expect(JSON.parse(after[threadPath("thr_partial0001")]!)).toEqual({ version: 1, ...expected });
    expect(logger.text()).not.toContain("renewal form");
  });

  it("legacy-unversioned.json loads, finishes interrupted messages, and is upgraded on the next write", async () => {
    const storage = vault({
      [threadPath("thr_legacy00001")]: readFixture("threads", "legacy-unversioned.json"),
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
    await store.flush();
    expect((await storage.read(threadPath("thr_legacy00001")))!.content).toBe(
      readFixture("threads", "legacy-unversioned.json"),
    );
    store.setTitle("thr_legacy00001", "Email the landlord");
    await store.flush();
    const upgraded = JSON.parse((await storage.read(threadPath("thr_legacy00001")))!.content);
    expect(upgraded.version).toBe(1);
    expect(PersistedThreadFileSchema.safeParse(upgraded).success).toBe(true);
  });

  it("legacy-unversioned-sparse.json gets the defaults the old reader applied", async () => {
    const storage = vault({
      [threadPath("thr_sparse00001")]: readFixture("threads", "legacy-unversioned-sparse.json"),
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
  ])(
    "%s is moved aside byte for byte and does not stop other threads from loading",
    async (name) => {
      const content = readFixture("threads", name);
      const storage = vault({
        [`.daily-do-list/threads/${name}`]: content,
        [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      });
      const store = await loadStore(storage);
      expect(store.list().map((t) => t.id)).toEqual(["thr_minimal0001"]);
      const stem = name.replace(/\.json$/, "");
      expect(await sidecar(storage)).toEqual({
        [`.daily-do-list/corrupt/threads/${stem}.${STAMP}.json`]: content,
        [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      });
    },
  );

  it("future-version.json is skipped and never overwritten, even by a copy of the same thread", async () => {
    const future = readFixture("threads", "future-version.json");
    const copy = encodePersistedThread(thread("thr_future00001", { messages: [text("m1", T)] }));
    const storage = vault({
      [threadPath("thr_future00001")]: future,
      ".daily-do-list/threads/thr_future00001 (conflict 2026-09-23 1830).json": copy,
    });
    const logger = recordingLogger();
    const store = await loadStore(storage, logger);
    expect(store.get("thr_future00001")?.messages).toEqual([text("m1", T)]);
    store.upsertMessage("thr_future00001", text("m2", T + 1));
    await store.flush();
    expect((await storage.read(threadPath("thr_future00001")))!.content).toBe(future);
    expect(await paths(storage)).toEqual([
      ".daily-do-list/threads/thr_future00001 (conflict 2026-09-23 1830).json",
      threadPath("thr_future00001"),
    ]);
    expect(logger.entries.some((e) => e.message.includes("newer version"))).toBe(true);
  });

  it("loads a whole vault of fixtures: good ones in, corrupt ones aside, future ones untouched", async () => {
    const files: Record<string, string> = {
      [threadPath(V1_ID)]: readFixture("threads", "v1.json"),
      [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
      [threadPath("thr_partial0001")]: readFixture("threads", "v1-invalid-entries.json"),
      [threadPath("thr_bom00000001")]: readFixture("threads", "v1-bom.json"),
      [threadPath("thr_legacy00001")]: readFixture("threads", "legacy-unversioned.json"),
      [threadPath("thr_sparse00001")]: readFixture("threads", "legacy-unversioned-sparse.json"),
      [threadPath("thr_future00001")]: readFixture("threads", "future-version.json"),
      ".daily-do-list/threads/corrupt-truncated.json": readFixture(
        "threads",
        "corrupt-truncated.json",
      ),
      ".daily-do-list/threads/corrupt-empty.json": readFixture("threads", "corrupt-empty.json"),
    };
    const storage = vault(files);
    const store = await loadStore(storage);
    expect(
      store
        .list()
        .map((t) => t.id)
        .sort(),
    ).toEqual([
      "thr_bom00000001",
      "thr_k3j9x0q2m1ab",
      "thr_legacy00001",
      "thr_minimal0001",
      "thr_partial0001",
      "thr_sparse00001",
    ]);
    await store.flush();
    const after = await sidecar(storage);
    expect(after[threadPath("thr_future00001")]).toBe(files[threadPath("thr_future00001")]);
    expect(
      Object.keys(after)
        .filter((p) => p.includes("/corrupt/"))
        .sort(),
    ).toEqual([
      `.daily-do-list/corrupt/threads/corrupt-empty.${STAMP}.json`,
      `.daily-do-list/corrupt/threads/corrupt-truncated.${STAMP}.json`,
      `.daily-do-list/corrupt/threads/thr_partial0001.${STAMP}.json`,
    ]);
  });
});

describe("thread store edge cases", () => {
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
      ".daily-do-list/threads/crafted (conflict 2026-09-23 1830).json": crafted,
    });
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    store.upsertMessage("../state/records", text("reply", T + 1));
    await store.flush();
    expect((await storage.read(".daily-do-list/state/records.json"))!.content).toBe(records);
  });

  it("quarantines a thread file named after another thread instead of guessing its owner", async () => {
    const storage = vault({ [threadPath("thr_a")]: encodePersistedThread(thread("thr_b")) });
    const store = await loadStore(storage);
    expect(store.list()).toEqual([]);
    expect(await paths(storage)).toEqual([`.daily-do-list/corrupt/threads/thr_a.${STAMP}.json`]);
  });

  it("merges a sync conflict copy into its thread and writes the result back once", async () => {
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
    const copyPath = ".daily-do-list/threads/thr_c (conflict 2026-09-23 1830).json";
    const storage = vault({
      [threadPath("thr_c")]: encodePersistedThread(ours),
      [copyPath]: encodePersistedThread(theirs),
    });
    const store = await loadStore(storage);
    const merged = store.get("thr_c")!;
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(merged).toMatchObject({ title: "theirs", updatedAt: 9 });
    await store.flush();
    expect(decodePersistedThread((await storage.read(threadPath("thr_c")))!.content)).toMatchObject(
      {
        ok: true,
        value: merged,
      },
    );
    expect((await storage.read(copyPath))!.content).toBe(encodePersistedThread(theirs));

    const again = await loadStore(storage);
    const before = await sidecar(storage);
    await again.flush();
    expect(await sidecar(storage)).toEqual(before);
    expect(again.get("thr_c")).toEqual(merged);
  });

  it("keeps threads whose task no longer exists", async () => {
    const orphan = thread("thr_orphan", { taskId: "tsk_deleted", notePath: "Daily/2026-01-01.md" });
    const storage = vault({ [threadPath("thr_orphan")]: encodePersistedThread(orphan) });
    const store = await loadStore(storage);
    expect(store.findByTask("tsk_deleted")).toEqual(orphan);
    expect(store.list({ notePath: "Daily/2026-01-01.md" }).map((t) => t.id)).toEqual([
      "thr_orphan",
    ]);
  });

  it("returns null for a binary body that is not base64 instead of garbage bytes", async () => {
    const withBinary = thread("thr_bin", {
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
    });
    const logger = recordingLogger();
    const storage = vault({
      [threadPath("thr_bin")]: encodePersistedThread(withBinary),
      ".daily-do-list/artifacts/thr_bin/art_1.zip.b64": "not base64 at all!",
    });
    const store = await loadStore(storage, logger);
    expect(await store.readArtifact("thr_bin", "art_1")).toBeNull();
    expect(logger.entries.map((e) => e.message)).toContain("Artifact body is not valid base64");
  });

  test.prop([fc.uint8Array({ maxLength: 2048 })])(
    "round-trips any binary artifact through storage and a reload",
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
    "round-trips any text artifact byte for byte",
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

  it("loads the same vault from two stores at once without writing anything", async () => {
    const storage = vault({
      [threadPath(V1_ID)]: readFixture("threads", "v1.json"),
      [threadPath("thr_minimal0001")]: readFixture("threads", "v1-minimal.json"),
    });
    const before = await sidecar(storage);
    const [a, b] = await Promise.all([loadStore(storage), loadStore(storage)]);
    expect(a.list()).toEqual(b.list());
    await Promise.all([a.flush(), b.flush()]);
    expect(await sidecar(storage)).toEqual(before);
  });

  it("two stores loading a corrupt file at once move it aside exactly once", async () => {
    const corrupt = readFixture("threads", "corrupt-truncated.json");
    const storage = vault({ ".daily-do-list/threads/corrupt-truncated.json": corrupt });
    const [a, b] = await Promise.all([loadStore(storage), loadStore(storage)]);
    expect([a.list(), b.list()]).toEqual([[], []]);
    expect(await sidecar(storage)).toEqual({
      [`.daily-do-list/corrupt/threads/corrupt-truncated.${STAMP}.json`]: corrupt,
    });
    const created = a.create({ taskId: null, notePath: null, title: "still writable" });
    await a.flush();
    expect(await paths(storage, ".daily-do-list/threads")).toEqual([threadPath(created.id)]);
  });

  it("two writers on one thread keep both sides' messages (conditional writes + merge)", async () => {
    const storage = vault({ [threadPath("thr_w")]: encodePersistedThread(thread("thr_w")) });
    const a = await loadStore(storage);
    const b = await loadStore(storage);
    const seenByB: ThreadStoreEvent[] = [];
    b.on((event) => seenByB.push(event));
    a.upsertMessage("thr_w", text("from-a", 1));
    b.upsertMessage("thr_w", text("from-b", 2));
    await a.flush();
    await b.flush();
    const saved = decodePersistedThread((await storage.read(threadPath("thr_w")))!.content);
    expect(saved.ok && saved.value.messages.map((m) => m.id)).toEqual(["from-a", "from-b"]);
    expect(b.get("thr_w")!.messages.map((m) => m.id)).toEqual(["from-a", "from-b"]);
    expect(seenByB).toContainEqual({
      type: "thread.message",
      threadId: "thr_w",
      message: text("from-a", 1),
    });
  });
});

describe("external changes while the runtime runs (e.g. sync from another device)", () => {
  async function running() {
    const storage = vault();
    const logger = recordingLogger();
    const store = createThreadStore({ storage, now: () => NOW, logger, flushDelayMs: 1 });
    await store.load();
    const created = store.create({ taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "t" });
    store.upsertMessage(created.id, text("ours-1", 1));
    await store.flush();
    return { storage, store, id: created.id, path: threadPath(created.id), logger };
  }

  it("keeps the in-memory copy until its next write (no live reload)", async () => {
    const { storage, store, id, path } = await running();
    const theirs = { ...store.get(id)!, title: "renamed elsewhere", updatedAt: NOW + 10 };
    storage.simulateExternalChange(path, encodePersistedThread(theirs));
    expect(store.get(id)!.title).toBe("t");
  });

  it("merges another device's messages at the next write instead of clobbering them", async () => {
    const { storage, store, id, path } = await running();
    const events: ThreadStoreEvent[] = [];
    store.on((event) => events.push(event));
    const current = store.get(id)!;
    storage.simulateExternalChange(
      path,
      encodePersistedThread({ ...current, messages: [...current.messages, text("theirs-1", 2)] }),
    );
    store.upsertMessage(id, text("ours-2", 3));
    await store.flush();
    const expectedIds = ["ours-1", "theirs-1", "ours-2"];
    expect(store.get(id)!.messages.map((m) => m.id)).toEqual(expectedIds);
    const saved = decodePersistedThread((await storage.read(path))!.content);
    expect(saved.ok && saved.value.messages.map((m) => m.id)).toEqual(expectedIds);
    expect(events).toContainEqual({
      type: "thread.message",
      threadId: id,
      message: text("theirs-1", 2),
    });
  });

  it("stops writing a thread whose file was replaced by a newer app version", async () => {
    const { storage, store, id, path } = await running();
    const newer = `{"version":2,"id":"${id}","future":true}`;
    storage.simulateExternalChange(path, newer);
    store.upsertMessage(id, text("ours-2", 3));
    await store.flush();
    store.upsertMessage(id, text("ours-3", 4));
    await store.flush();
    expect((await storage.read(path))!.content).toBe(newer);
    expect(store.get(id)!.messages.map((m) => m.id)).toEqual(["ours-1", "ours-2", "ours-3"]);
  });

  it("moves a file that got corrupted meanwhile aside and rewrites it from memory", async () => {
    const { storage, store, id, path } = await running();
    storage.simulateExternalChange(path, '{"version":1,"id":');
    store.upsertMessage(id, text("ours-2", 3));
    await store.flush();
    expect(
      (await storage.read(`.daily-do-list/corrupt/threads/${id}.${STAMP}.json`))!.content,
    ).toBe('{"version":1,"id":');
    const saved = decodePersistedThread((await storage.read(path))!.content);
    expect(saved.ok && saved.value.messages.map((m) => m.id)).toEqual(["ours-1", "ours-2"]);
  });

  it("recreates a thread file deleted meanwhile at its next change", async () => {
    const { storage, store, id, path } = await running();
    storage.simulateExternalChange(path, null);
    store.setStatus(id, "done");
    await store.flush();
    expect(decodePersistedThread((await storage.read(path))!.content)).toMatchObject({
      ok: true,
      value: { status: "done" },
    });
  });
});

describe("thread writer", () => {
  const change = fc.oneof(
    messageArb().map((message) => ({ kind: "message" as const, message })),
    fc
      .constantFrom("idle", "working", "done", "failed", "waiting_user")
      .map((status) => ({ kind: "status" as const, status })),
    fc
      .string({ unit: "binary", maxLength: 30 })
      .map((title) => ({ kind: "title" as const, title })),
    fc
      .constantFrom("browser", "computer")
      .map((surface) => ({ kind: "surface" as const, surface })),
  );

  test.prop([fc.array(change, { maxLength: 25 })])(
    "always writes a schema-valid file that loads back to the same thread",
    async (changes) => {
      const storage = vault();
      const store = createThreadStore({ storage, now: () => NOW });
      const { id } = store.create({ taskId: "tsk_p", notePath: "Daily/2026-09-23.md", title: "p" });
      for (const c of changes) {
        if (c.kind === "message") store.upsertMessage(id, c.message);
        else if (c.kind === "status") store.setStatus(id, c.status);
        else if (c.kind === "title") store.setTitle(id, c.title);
        else store.addSurface(id, c.surface);
      }
      await store.flush();
      const raw = JSON.parse((await storage.read(threadPath(id)))!.content);
      expect(PersistedThreadFileSchema.safeParse(raw).success).toBe(true);
      const reloaded = await loadStore(storage);
      expect(reloaded.get(id)).toEqual(store.get(id));
    },
  );

  it("handles a 10,000-message thread quickly (load, append, write, reload)", async () => {
    const messages = Array.from({ length: 10_000 }, (_, i) =>
      text(`m${i}`, T + i, `message ${i} ✓ ünïcødé`),
    );
    const storage = vault({
      [threadPath("thr_huge")]: encodePersistedThread(thread("thr_huge", { messages })),
    });
    const started = performance.now();
    const store = await loadStore(storage);
    store.upsertMessage("thr_huge", text("m-last", T + 10_001));
    await store.flush();
    const reloaded = await loadStore(storage);
    const elapsed = performance.now() - started;
    expect(reloaded.get("thr_huge")!.messages).toHaveLength(10_001);
    expect(reloaded.get("thr_huge")!.messages[9_999]).toEqual(messages[9_999]);
    expect(elapsed).toBeLessThan(1_500);
  });
});
