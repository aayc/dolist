import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decodePersistedThread,
  encodePersistedThread,
  mergePersistedThreads,
  type PersistedThread,
  PersistedThreadFileSchema,
  persistedThreadIdFromPath,
} from "../../src/persisted";
import { messageArb, threadArb } from "./arbitraries";

const base: PersistedThread = {
  id: "thr_a",
  taskId: "tsk_1",
  notePath: "Daily/2026-09-23.md",
  title: "Book a dentist appointment",
  status: "working",
  createdAt: 1_000,
  updatedAt: 2_000,
  messages: [],
  artifacts: [],
  surfaces: [],
};

const text = (id: string, createdAt: number, body = id) => ({
  id,
  author: "orchestrator" as const,
  createdAt,
  kind: "text" as const,
  role: "agent" as const,
  text: body,
});

function encodeRaw(value: unknown): string {
  return JSON.stringify(value);
}

describe("decodePersistedThread", () => {
  it("reads a v1 file", () => {
    const result = decodePersistedThread(
      encodePersistedThread({ ...base, messages: [text("m1", 5)] }),
    );
    expect(result).toEqual({
      ok: true,
      value: { ...base, messages: [text("m1", 5)] },
      fromVersion: 1,
      issues: [],
    });
  });

  it("reads legacy unversioned files, defaulting what the old reader defaulted", () => {
    const { taskId: _t, notePath: _n, artifacts: _a, surfaces: _s, ...legacy } = base;
    expect(decodePersistedThread(encodeRaw(legacy))).toEqual({
      ok: true,
      value: { ...base, taskId: null, notePath: null },
      fromVersion: null,
      issues: [],
    });
  });

  it("finishes messages that were interrupted mid-stream", () => {
    const streaming = { ...text("s1", 5, "partial"), streaming: true };
    const result = decodePersistedThread(encodeRaw({ version: 1, ...base, messages: [streaming] }));
    expect(result.ok && result.value.messages).toEqual([{ ...streaming, streaming: false }]);
  });

  it("drops invalid messages, artifacts and surfaces one by one", () => {
    const result = decodePersistedThread(
      encodeRaw({
        version: 1,
        ...base,
        messages: [
          text("m1", 1),
          { id: "m2", kind: "poll", author: "system", createdAt: 2 },
          { ...text("m3", 3), role: "robot" },
          { ...text("m4", 4), author: "stranger" },
          "not an object",
          text("m5", 5),
        ],
        artifacts: [
          {
            id: "art_1",
            threadId: "thr_a",
            title: "t",
            kind: "text",
            mimeType: "text/plain",
            path: ".daily-do-list/artifacts/thr_a/art_1.txt",
            size: 1,
            createdAt: 1,
          },
          {
            id: "art_2",
            threadId: "thr_a",
            title: "t",
            kind: "text",
            mimeType: "text/plain",
            path: "Notes/secret.md",
            size: 1,
            createdAt: 1,
          },
          {
            id: "art_3",
            threadId: "thr_a",
            title: "t",
            kind: "text",
            mimeType: "text/plain",
            path: ".daily-do-list/artifacts/../state/records.json",
            size: 1,
            createdAt: 1,
          },
          {
            id: "art_4",
            threadId: "thr_a",
            title: "t",
            kind: "text",
            mimeType: "text/plain",
            path: ".daily-do-list/artifacts/thr_a/art_4.txt",
            size: -1,
            createdAt: 1,
          },
        ],
        surfaces: ["browser", "hologram", "browser"],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.messages.map((m) => m.id)).toEqual(["m1", "m5"]);
    expect(result.value.artifacts.map((a) => a.id)).toEqual(["art_1"]);
    expect(result.value.surfaces).toEqual(["browser"]);
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "messages[1]",
      "messages[2]",
      "messages[3]",
      "messages[4]",
      "artifacts[1]",
      "artifacts[2]",
      "artifacts[3]",
      "surfaces[1]",
    ]);
  });

  it("keeps the first position and the last copy of a duplicated message id", () => {
    const result = decodePersistedThread(
      encodeRaw({
        version: 1,
        ...base,
        messages: [text("m1", 1, "old"), text("m2", 2), text("m1", 1, "new")],
      }),
    );
    expect(
      result.ok && result.value.messages.map((m) => (m.kind === "text" ? m.text : "")),
    ).toEqual(["new", "m2"]);
    expect(result.ok && result.issues).toHaveLength(1);
  });

  it("accepts every message kind, unicode everywhere and tool calls without input", () => {
    const messages = [
      { ...text("m1", 1, "Réservé 🦷 — שלום — 予約"), author: "subagent:dentist-🦷" },
      {
        id: "m2",
        author: "system",
        createdAt: 2,
        kind: "tool_call",
        toolCallId: "c1",
        toolName: "browser_click",
        status: "ok",
      },
      { id: "m3", author: "system", createdAt: 3, kind: "approval", approvalId: "apr_1" },
      { id: "m4", author: "system", createdAt: 4, kind: "artifact", artifactId: "art_1" },
      { id: "m5", author: "orchestrator", createdAt: 5, kind: "status", status: "done", text: "✓" },
    ];
    const result = decodePersistedThread(encodeRaw({ version: 1, ...base, messages }));
    expect(result).toMatchObject({ ok: true, issues: [] });
    expect(result.ok && result.value.messages).toEqual(messages);
  });

  it.each([
    ["missing id", { ...base, id: undefined }],
    ["an id that escapes the threads folder", { ...base, id: "../state/records" }],
    ["an id with a slash", { ...base, id: "a/b" }],
    ["an unknown status", { ...base, status: "paused" }],
    ["messages that are not a list", { ...base, messages: {} }],
    ["a non-numeric timestamp", { ...base, updatedAt: "yesterday" }],
    ["a taskId that is a number", { ...base, taskId: 7 }],
  ])("treats a thread with %s as corrupt", (_label, doc) => {
    expect(decodePersistedThread(encodeRaw({ version: 1, ...doc }))).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
  });

  it("ignores unknown fields on read (they are not part of the in-memory thread)", () => {
    const result = decodePersistedThread(
      encodeRaw({
        version: 1,
        ...base,
        pinned: true,
        messages: [{ ...text("m1", 1), reactions: ["👍"] }],
      }),
    );
    expect(result.ok && result.value).toEqual({ ...base, messages: [text("m1", 1)] });
  });

  it("refuses a canonical file that holds another thread", () => {
    const text = encodePersistedThread(base);
    expect(decodePersistedThread(text, "thr_a")).toMatchObject({ ok: true });
    expect(decodePersistedThread(text, "thr_b")).toEqual({
      ok: false,
      kind: "corrupt",
      reason: "thread id does not match the file name",
    });
  });

  it("reports a newer version without looking inside", () => {
    expect(decodePersistedThread('{"version":2,"id":"thr_a","shape":"unknown"}')).toEqual({
      ok: false,
      kind: "newer",
      version: 2,
    });
  });
});

describe("persistedThreadIdFromPath", () => {
  it.each([
    [".daily-do-list/threads/thr_k3j9x0q2m1ab.json", "thr_k3j9x0q2m1ab"],
    [".daily-do-list/threads/thread-1.json", "thread-1"],
    [".daily-do-list/threads/thr_a (conflict 2026-09-23 1830).json", null],
    [".daily-do-list/threads/thr_a.json.bak", null],
    [".daily-do-list/threads/.json", null],
  ])("%s → %s", (path, id) => {
    expect(persistedThreadIdFromPath(path)).toBe(id);
  });
});

describe("encodePersistedThread", () => {
  it("writes exactly the v1 fields, version first, newline-terminated", () => {
    const withExtra = { ...base, extra: "not persisted" } as PersistedThread;
    const out = encodePersistedThread(withExtra);
    expect(out.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(out))).toEqual([
      "version",
      "id",
      "taskId",
      "notePath",
      "title",
      "status",
      "createdAt",
      "updatedAt",
      "messages",
      "artifacts",
      "surfaces",
    ]);
  });

  test.prop([threadArb])("output always parses with the v1 schema", (thread) => {
    expect(
      PersistedThreadFileSchema.safeParse(JSON.parse(encodePersistedThread(thread))).success,
    ).toBe(true);
  });

  test.prop([threadArb])("round-trips any valid thread exactly", (thread) => {
    expect(decodePersistedThread(encodePersistedThread(thread))).toEqual({
      ok: true,
      value: thread,
      fromVersion: 1,
      issues: [],
    });
  });

  test.prop([threadArb, fc.nat({ max: 40 })])(
    "a truncated file is always corrupt, never half-loaded",
    (thread, cut) => {
      const full = encodePersistedThread(thread).trimEnd();
      const truncated = full.slice(0, Math.max(0, full.length - 1 - cut));
      expect(decodePersistedThread(truncated)).toMatchObject({ ok: false, kind: "corrupt" });
    },
  );
});

describe("mergePersistedThreads", () => {
  it("unions messages by id, interleaving theirs by createdAt", () => {
    const ours = { ...base, messages: [text("a", 1), text("c", 3), text("e", 5)] };
    const theirs = { ...base, messages: [text("b", 2), text("c", 3, "their c"), text("d", 4)] };
    const merged = mergePersistedThreads(ours, theirs);
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(merged.messages[2]).toEqual(text("c", 3));
  });

  it("takes title and status from the copy updated last", () => {
    const ours = { ...base, title: "ours", status: "working" as const, updatedAt: 10 };
    const theirs = {
      ...base,
      title: "theirs",
      status: "done" as const,
      updatedAt: 20,
      createdAt: 5,
    };
    expect(mergePersistedThreads(ours, theirs)).toMatchObject({
      title: "theirs",
      status: "done",
      updatedAt: 20,
      createdAt: 5,
    });
    expect(mergePersistedThreads(theirs, ours)).toMatchObject({ title: "theirs" });
    expect(mergePersistedThreads(ours, { ...theirs, updatedAt: 10 })).toMatchObject({
      title: "ours",
    });
  });

  const pair = threadArb.chain((ours) =>
    fc
      .record({
        messages: fc.uniqueArray(messageArb(), { maxLength: 8, selector: (m) => m.id }),
        title: fc.string(),
        updatedAt: fc.integer(),
      })
      .map((theirs) => [ours, { ...ours, ...theirs }] as const),
  );

  test.prop([pair])(
    "loses nothing: every message id from either side survives",
    ([ours, theirs]) => {
      const merged = mergePersistedThreads(ours, theirs);
      const ids = new Set(merged.messages.map((m) => m.id));
      for (const m of [...ours.messages, ...theirs.messages]) expect(ids.has(m.id)).toBe(true);
      expect(merged.messages).toHaveLength(ids.size);
      for (const m of ours.messages) expect(merged.messages).toContainEqual(m);
    },
  );

  test.prop([pair])("is idempotent", ([ours, theirs]) => {
    const once = mergePersistedThreads(ours, theirs);
    expect(mergePersistedThreads(once, theirs)).toEqual(once);
    expect(mergePersistedThreads(once, once)).toEqual(once);
  });

  test.prop([pair])("keeps ours' relative message order", ([ours, theirs]) => {
    const merged = mergePersistedThreads(ours, theirs).messages.map((m) => m.id);
    const positions = ours.messages.map((m) => merged.indexOf(m.id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
