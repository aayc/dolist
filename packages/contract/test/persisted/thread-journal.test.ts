import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  comparePersistedJournalEvents,
  decodePersistedJournalLine,
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  PERSISTED_FORMATS,
  type PersistedJournalEvent,
  persistedThreadIdFromJournalPath,
  persistedThreadJournalPath,
} from "../../src/persisted";
import {
  anyText,
  artifactArb,
  fileId,
  jsonInput,
  messageArb,
  threadArb,
  timestamp,
} from "./arbitraries";
import { fixtureKind, listFixtures, readFixture } from "./fixtures";

const T = 1790154000000;

const envelope = fc.record({
  v: fc.constant(1 as const),
  id: fc.stringMatching(/^evt_[A-Za-z0-9]{1,12}$/),
  epoch: fc.nat({ max: 1_000 }),
  seq: fc.nat({ max: 1_000_000 }),
  at: timestamp,
});

const payload: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  fc.record({ type: fc.constant("message"), message: messageArb() }),
  fc.record({
    type: fc.constant("status"),
    status: fc.constantFrom("idle", "working", "done", "failed", "waiting_user"),
  }),
  fc.record({ type: fc.constant("title"), title: anyText(40) }),
  fc.record({ type: fc.constant("trim"), keep: fc.nat({ max: 600 }) }),
  fc.record({ type: fc.constant("surface"), surface: fc.constantFrom("browser", "computer") }),
  fc.record({ type: fc.constant("artifact"), artifact: artifactArb("thr_a") }),
  fc.record({
    type: fc.constant("tool.requested"),
    call: fc.stringMatching(/^call_[a-z0-9]{1,8}$/),
    tool: anyText(20),
    session: anyText(20),
    input: jsonInput,
  }),
  fc.record({
    type: fc.constant("tool.finished"),
    call: fc.stringMatching(/^call_[a-z0-9]{1,8}$/),
    outcome: fc.constantFrom("ok", "error", "blocked"),
    output: anyText(60),
  }),
  fc.record({ type: fc.constant("run.prompted"), session: anyText(20), text: anyText(200) }),
);

const eventArb: fc.Arbitrary<PersistedJournalEvent> = fc
  .tuple(envelope, payload)
  .map(([e, p]) => ({ ...e, ...p }) as PersistedJournalEvent);

describe("thread journal fixtures", () => {
  const names = listFixtures("thread-journal");

  it("cover valid, corrupt and future journals (journals have no legacy form)", () => {
    expect([...new Set(names.map(fixtureKind))].sort()).toEqual(["corrupt", "future", "v1"]);
  });

  it.each(names)("%s decodes as its name promises", (name) => {
    const read = decodePersistedThreadJournal(readFixture("thread-journal", name));
    switch (fixtureKind(name)) {
      case "v1":
        expect(read.newer).toBeNull();
        expect(read.events.length).toBeGreaterThan(0);
        if (name.includes("invalid")) expect(read.issues.length).toBeGreaterThan(0);
        else expect(read.issues).toEqual([]);
        break;
      case "corrupt":
        expect(read.events).toEqual([]);
        break;
      case "future":
        expect(read.newer).toBe(2);
        break;
      default:
        throw new Error(`unclassified fixture ${name}`);
    }
  });

  it("v1.jsonl holds every event type, in order", () => {
    const read = decodePersistedThreadJournal(readFixture("thread-journal", "v1.jsonl"));
    expect(read.endsWithNewline).toBe(true);
    expect(read.maxSeq).toBe(25);
    expect(new Set(read.events.map((e) => e.type))).toEqual(
      new Set([
        "thread.created",
        "status",
        "run.prompted",
        "message",
        "tool.requested",
        "tool.decided",
        "tool.started",
        "tool.finished",
        "surface",
        "artifact",
        "sources",
        "title",
        "tool.interrupted",
        "trim",
      ]),
    );
    expect(read.events.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("v1-imported.jsonl carries the snapshot it migrated, messages saved mid-stream finished", () => {
    const read = decodePersistedThreadJournal(
      readFixture("thread-journal", "v1-imported.jsonl"),
      "thr_journal00002",
    );
    const imported = read.events[0]!;
    expect(imported.type).toBe("thread.imported");
    if (imported.type !== "thread.imported") return;
    expect(imported.thread).toMatchObject({
      id: "thr_journal00002",
      routineId: "rtn_weekly01",
      status: "waiting_user",
    });
    expect(imported.thread.messages.map((m) => m.kind === "text" && m.streaming === true)).toEqual([
      false,
      false,
    ]);
  });

  it("v1-invalid-lines.jsonl skips exactly the bad lines and reports where, never what", () => {
    const text = readFixture("thread-journal", "v1-invalid-lines.jsonl");
    const read = decodePersistedThreadJournal(text, "thr_journal00004");
    expect(read.events.map((e) => e.id)).toEqual(["evt_b01", "evt_b02", "evt_b10", "evt_b11"]);
    expect(read.issues.map((i) => i.path)).toEqual([
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 10 sources[1]",
      "line 12",
    ]);
    expect(read.endsWithNewline).toBe(false);
    const sources = read.events.find((e) => e.type === "sources");
    expect(sources?.type === "sources" && sources.sources).toEqual([
      { url: "https://example.org/passport" },
    ]);
    const reported = JSON.stringify(read.issues);
    for (const secret of ["Renew pass", "Not mine", "thr_other000001", "nope", "launch"]) {
      expect(reported).not.toContain(secret);
    }
  });

  it("v1-two-writers.jsonl folds in (epoch, seq, id) order whatever order the lines are in", () => {
    const read = decodePersistedThreadJournal(
      readFixture("thread-journal", "v1-two-writers.jsonl"),
    );
    expect(read.events.map((e) => [e.epoch, e.seq, e.id])).toEqual([
      [0, 1, "evt_w01"],
      [0, 2, "evt_w02"],
      [0, 3, "evt_w03"],
      [1, 1, "evt_w04"],
      [1, 2, "evt_w05"],
    ]);
  });
});

describe("thread journal lines", () => {
  test.prop([eventArb])("encode → decode is the identity", (event) => {
    const line = encodePersistedJournalEvent(event);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    const decoded = decodePersistedJournalLine(line);
    expect(decoded).toEqual({ ok: true, event, issues: [] });
  });

  test.prop([threadArb])("thread.imported round-trips a whole thread", (thread) => {
    const event = {
      v: 1,
      id: "evt_1",
      epoch: 0,
      seq: 1,
      at: T,
      type: "thread.imported",
      thread,
    } as const;
    const read = decodePersistedThreadJournal(encodePersistedJournalEvent(event), thread.id);
    expect(read.issues).toEqual([]);
    expect(read.events).toEqual([event]);
  });

  test.prop([fc.array(eventArb, { maxLength: 30 })])(
    "a journal decodes to its unique events in canonical order",
    (events) => {
      const text = events.map(encodePersistedJournalEvent).join("");
      const read = decodePersistedThreadJournal(text);
      const unique = [...new Map(events.reverse().map((e) => [e.id, e])).values()];
      expect(read.events.map((e) => e.id).sort()).toEqual(unique.map((e) => e.id).sort());
      for (let i = 1; i < read.events.length; i++) {
        expect(comparePersistedJournalEvents(read.events[i - 1]!, read.events[i]!)).toBeLessThan(0);
      }
      expect(read.issues).toEqual([]);
    },
  );

  test.prop([fc.string({ unit: "binary", maxLength: 400 })])(
    "never throws, whatever the bytes",
    (text) => {
      const read = decodePersistedThreadJournal(text);
      expect(Array.isArray(read.events)).toBe(true);
    },
  );

  test.prop([eventArb, fc.nat(), fc.string({ unit: "binary", maxLength: 3 })])(
    "a damaged line never takes the rest of the journal down",
    (event, cut, junk) => {
      const good = {
        v: 1,
        id: "evt_keep",
        epoch: 0,
        seq: 999_999_999,
        at: T,
        type: "title",
        title: "kept",
      } as const;
      const line = encodePersistedJournalEvent(event);
      const damaged = line.slice(0, cut % line.length) + junk;
      const read = decodePersistedThreadJournal(
        `${damaged.replaceAll("\n", "")}\n${encodePersistedJournalEvent(good)}`,
      );
      expect(read.events).toContainEqual(good);
    },
  );

  it("marks lines from a newer app instead of reading them", () => {
    expect(decodePersistedJournalLine('{"v":2,"id":"x","type":"hologram"}')).toEqual({
      ok: false,
      kind: "newer",
      version: 2,
    });
    for (const v of ["0", '"1"', "1.5", "null"]) {
      expect(decodePersistedJournalLine(`{"v":${v},"id":"x"}`)).toMatchObject({
        ok: false,
        kind: "corrupt",
      });
    }
  });

  it("tolerates a byte order mark and CRLF line ends", () => {
    const line = encodePersistedJournalEvent({
      v: 1,
      id: "evt_1",
      epoch: 0,
      seq: 1,
      at: T,
      type: "title",
      title: "x",
    });
    const read = decodePersistedThreadJournal(`\ufeff${line.replace("\n", "\r\n")}`);
    expect(read.events.map((e) => e.id)).toEqual(["evt_1"]);
    expect(read.issues).toEqual([]);
  });
});

describe("thread journal paths", () => {
  test.prop([fileId])("round-trip every valid thread id", (id) => {
    expect(persistedThreadIdFromJournalPath(persistedThreadJournalPath(id))).toBe(id);
  });

  it("live under the agent's state folder and never name anything else", () => {
    expect(persistedThreadJournalPath("thr_a")).toBe(
      ".daily-do-list/state/journal/threads/thr_a.jsonl",
    );
    for (const path of [
      ".daily-do-list/threads/thr_a.json",
      ".daily-do-list/state/journal/threads/../records.jsonl",
      ".daily-do-list/state/journal/threads/a/b.jsonl",
      ".daily-do-list/state/journal/threads/thr_a.json",
    ]) {
      expect(persistedThreadIdFromJournalPath(path)).toBeNull();
    }
    expect(PERSISTED_FORMATS.find((f) => f.name === "thread-journal")).toMatchObject({
      path: ".daily-do-list/state/journal/threads/<threadId>.jsonl",
      version: 1,
      syncs: true,
    });
  });
});
