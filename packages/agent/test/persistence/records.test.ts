import {
  decodePersistedRecords,
  encodePersistedRecords,
  PersistedRecordsFileSchema,
} from "@ddl/contract";
import type { TaskAgentRecord } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { recordArb, specArb } from "../../../contract/test/persisted/arbitraries";
import { RECORDS_PATH, TaskRecords } from "../../src/orchestrator/records";
import type { SubagentSpec } from "../../src/orchestrator/types";
import { NOW, readFixture, recordingLogger, STAMP, sidecar, vault } from "./helpers";

const CORRUPT_COPY = `.daily-do-list/corrupt/state/records.${STAMP}.json`;

async function loadRecords(storage: ReturnType<typeof vault>, logger = recordingLogger()) {
  const records = new TaskRecords({ storage, now: () => NOW, logger, flushDelayMs: 1 });
  await records.load();
  return records;
}

const record = (taskId: string, extra: Partial<TaskAgentRecord> = {}): TaskAgentRecord => ({
  taskId,
  notePath: "Daily/2026-09-23.md",
  date: "2026-09-23",
  text: taskId,
  line: 0,
  status: "idle",
  threadId: null,
  updatedAt: NOW - 1_000,
  unread: 0,
  ...extra,
});

describe("golden records fixtures through the real TaskRecords loader", () => {
  it("v1.json loads exactly, minus records past retention and specs without a record", async () => {
    const storage = vault({ [RECORDS_PATH]: readFixture("records", "v1.json") });
    const records = await loadRecords(storage);
    expect(records.all()).toEqual([
      {
        taskId: "tsk_7fq2m9x0ab",
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
        text: "Book a dentist appointment for next week 🦷",
        line: 2,
        status: "done",
        summary: "Booked for Tue 09:30",
        threadId: "thr_k3j9x0q2m1ab",
        updatedAt: 1790154007000,
        unread: 1,
      },
      {
        taskId: "tsk_wait000001",
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
        text: "Order printer ink",
        line: 3,
        status: "waiting_approval",
        summary: "Approve: Place order",
        threadId: "thr_ink0000001",
        updatedAt: 1790154006000,
        unread: 0,
      },
      {
        taskId: "tsk_idle000001",
        notePath: "Notes/Someday.md",
        date: null,
        text: "Learn to juggle",
        line: 0,
        status: "idle",
        threadId: null,
        updatedAt: 1790154000000,
        unread: 0,
      },
    ]);
    expect(records.getSpec("tsk_7fq2m9x0ab")).toEqual({
      taskId: "tsk_7fq2m9x0ab",
      goal: "Book a dentist appointment next week near the user's home",
      instructions: "Mornings preferred.",
      capabilities: ["web", "browser"],
    });
    expect(records.getSpec("tsk_wait000001")).toEqual({
      taskId: "tsk_wait000001",
      goal: "Order the usual printer ink",
      capabilities: ["browser"],
    });
    expect(records.getSpec("tsk_gone000001")).toBeUndefined();
    expect(records.get("tsk_old0000001")).toBeUndefined();
    // Records of notes that do not exist (anymore) are kept: only retention prunes records.
    expect(records.list("Notes/Someday.md")).toHaveLength(1);
    await records.flush();
    expect(await sidecar(storage)).toEqual({ [RECORDS_PATH]: readFixture("records", "v1.json") });
  });

  it("v1-invalid-entries.json keeps the valid records, then repairs the file and keeps a copy", async () => {
    const original = readFixture("records", "v1-invalid-entries.json");
    const storage = vault({ [RECORDS_PATH]: original });
    const records = await loadRecords(storage);
    const expected = record("tsk_good000001", {
      text: "Pay rent (edited)",
      status: "done",
      updatedAt: 1790154001000,
      unread: 2,
    });
    expect(records.all()).toEqual([expected]);
    expect(records.getSpec("tsk_good000001")).toBeUndefined();
    await records.flush();
    const after = await sidecar(storage);
    expect(after[CORRUPT_COPY]).toBe(original);
    expect(decodePersistedRecords(after[RECORDS_PATH]!)).toEqual({
      ok: true,
      value: { records: [expected], specs: {} },
      fromVersion: 1,
      issues: [],
    });
  });

  it("legacy-unversioned.json loads with the old defaults and gains `version` on the next save", async () => {
    const storage = vault({ [RECORDS_PATH]: readFixture("records", "legacy-unversioned.json") });
    const records = await loadRecords(storage);
    expect(records.all()).toEqual([
      record("tsk_legacy0001", {
        notePath: "Daily/2026-09-22.md",
        date: null,
        text: "Email the landlord about the faucet",
        line: 4,
        status: "waiting_user",
        updatedAt: 1790067660000,
      }),
    ]);
    records.markRead("tsk_legacy0001");
    records.bumpUnread("tsk_legacy0001");
    await records.flush();
    const saved = JSON.parse((await storage.read(RECORDS_PATH))!.content);
    expect(saved.version).toBe(1);
    expect(PersistedRecordsFileSchema.safeParse(saved).success).toBe(true);
  });

  it.each(["corrupt-truncated.json", "corrupt-wrong-shape.json"])(
    "%s is moved aside; records start empty and a fresh file is written",
    async (name) => {
      const content = readFixture("records", name);
      const storage = vault({ [RECORDS_PATH]: content });
      const records = await loadRecords(storage);
      expect(records.all()).toEqual([]);
      records.ensure({
        taskId: "tsk_new",
        notePath: "Daily/2026-09-23.md",
        date: "2026-09-23",
        text: "New",
        line: 0,
      });
      await records.flush();
      const after = await sidecar(storage);
      expect(after[CORRUPT_COPY]).toBe(content);
      expect(decodePersistedRecords(after[RECORDS_PATH]!)).toMatchObject({
        ok: true,
        value: { records: [{ taskId: "tsk_new" }] },
      });
    },
  );

  it("future-version.json is left untouched and never overwritten; records live in memory", async () => {
    const future = readFixture("records", "future-version.json");
    const logger = recordingLogger();
    const storage = vault({ [RECORDS_PATH]: future });
    const records = await loadRecords(storage, logger);
    expect(records.all()).toEqual([]);
    records.ensure({
      taskId: "tsk_new",
      notePath: "Daily/2026-09-23.md",
      date: "2026-09-23",
      text: "New",
      line: 0,
    });
    await records.flush();
    expect(records.get("tsk_new")).toMatchObject({ status: "idle" });
    expect(await sidecar(storage)).toEqual({ [RECORDS_PATH]: future });
    expect(logger.entries.some((e) => e.message === "Not writing a file this run")).toBe(true);
  });
});

describe("records.json edge cases", () => {
  it("stops saving when a newer version arrives through sync while running", async () => {
    const storage = vault();
    const records = await loadRecords(storage);
    records.ensure({
      taskId: "tsk_a",
      notePath: "Daily/2026-09-23.md",
      date: null,
      text: "A",
      line: 0,
    });
    await records.flush();
    storage.simulateExternalChange(RECORDS_PATH, '{"version":2,"records":"elsewhere"}');
    records.update("tsk_a", { status: "done" });
    await records.flush();
    expect((await storage.read(RECORDS_PATH))!.content).toBe('{"version":2,"records":"elsewhere"}');
  });

  it("merges records another device saved meanwhile instead of overwriting them", async () => {
    const storage = vault();
    const records = await loadRecords(storage);
    const seen: TaskAgentRecord[] = [];
    records.on("task.record", (r) => seen.push(r));
    records.ensure({
      taskId: "tsk_mine",
      notePath: "Daily/2026-09-23.md",
      date: null,
      text: "Mine",
      line: 0,
    });
    await records.flush();
    const theirs = record("tsk_theirs", { status: "done", summary: "Done on the phone" });
    storage.simulateExternalChange(
      RECORDS_PATH,
      encodePersistedRecords({
        records: [record("tsk_mine", { updatedAt: 1 }), theirs],
        specs: {},
      }),
    );
    records.update("tsk_mine", { status: "working" });
    await records.flush();
    expect(records.get("tsk_theirs")).toEqual(theirs);
    expect(records.get("tsk_mine")).toMatchObject({ status: "working" });
    expect(seen).toContainEqual(theirs);
    const saved = decodePersistedRecords((await storage.read(RECORDS_PATH))!.content);
    expect(saved.ok && saved.value.records.map((r) => r.taskId).sort()).toEqual([
      "tsk_mine",
      "tsk_theirs",
    ]);
  });

  it("does not overwrite records it failed to read at startup", async () => {
    const storage = vault({
      [RECORDS_PATH]: encodePersistedRecords({ records: [record("tsk_disk")], specs: {} }),
    });
    const read = vi.spyOn(storage, "read").mockRejectedValueOnce(new Error("EIO"));
    const records = await loadRecords(storage);
    expect(records.all()).toEqual([]);
    records.ensure({
      taskId: "tsk_new",
      notePath: "Daily/2026-09-23.md",
      date: null,
      text: "New",
      line: 1,
    });
    await records.flush();
    read.mockRestore();
    const saved = decodePersistedRecords((await storage.read(RECORDS_PATH))!.content);
    expect(saved.ok && saved.value.records.map((r) => r.taskId).sort()).toEqual([
      "tsk_disk",
      "tsk_new",
    ]);
  });

  it("recreates records.json after it was deleted meanwhile", async () => {
    const storage = vault();
    const records = await loadRecords(storage);
    records.ensure({
      taskId: "tsk_a",
      notePath: "Daily/2026-09-23.md",
      date: null,
      text: "A",
      line: 0,
    });
    await records.flush();
    storage.simulateExternalChange(RECORDS_PATH, null);
    records.update("tsk_a", { text: "A!" });
    await records.flush();
    expect(decodePersistedRecords((await storage.read(RECORDS_PATH))!.content)).toMatchObject({
      value: { records: [{ taskId: "tsk_a", text: "A!" }] },
    });
  });
});

describe("records writer", () => {
  const scenario = fc
    .uniqueArray(recordArb(fc.stringMatching(/^tsk_[a-z0-9]{1,10}$/)), {
      maxLength: 8,
      selector: (r) => r.taskId,
    })
    .chain((list) =>
      fc.tuple(
        fc.constant(list),
        fc
          .subarray(list.map((r) => r.taskId))
          .chain((ids) => fc.tuple(...ids.map((id) => specArb(id)))),
      ),
    );

  test.prop([scenario])(
    "always writes a schema-valid file that loads back to the same records and specs",
    async ([list, specs]) => {
      const storage = vault();
      const records = new TaskRecords({ storage, now: () => NOW, retentionDays: 100_000 });
      for (const r of list) {
        records.ensure({
          taskId: r.taskId,
          notePath: r.notePath,
          date: r.date,
          text: r.text,
          line: r.line,
        });
        records.update(r.taskId, {
          status: r.status,
          summary: r.summary ?? null,
          threadId: r.threadId,
        });
        if (r.unread > 0) records.bumpUnread(r.taskId, r.unread);
      }
      for (const spec of specs) records.setSpec(spec as SubagentSpec);
      await records.flush();
      const file = await storage.read(RECORDS_PATH);
      if (!file) {
        expect(records.all()).toEqual([]);
        return;
      }
      const raw = JSON.parse(file.content);
      expect(PersistedRecordsFileSchema.safeParse(raw).success).toBe(true);
      const reloaded = new TaskRecords({ storage, now: () => NOW, retentionDays: 100_000 });
      await reloaded.load();
      expect(reloaded.all()).toEqual(records.all());
      for (const spec of specs) expect(reloaded.getSpec(spec.taskId)).toEqual(spec);
    },
  );
});
