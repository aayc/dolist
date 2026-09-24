import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decodePersistedRecords,
  encodePersistedRecords,
  mergePersistedRecords,
  PersistedRecordsFileSchema,
  type PersistedSubagentSpec,
  type PersistedTaskAgentRecord,
} from "../../src/persisted";
import { recordArb, recordsArb } from "./arbitraries";

const record: PersistedTaskAgentRecord = {
  taskId: "tsk_1",
  notePath: "Daily/2026-09-23.md",
  date: "2026-09-23",
  text: "Renew passport",
  line: 3,
  status: "done",
  summary: "Appointment booked",
  threadId: "thr_1",
  updatedAt: 1_000,
  unread: 2,
};
const spec: PersistedSubagentSpec = {
  taskId: "tsk_1",
  goal: "Book it",
  capabilities: ["web", "browser"],
};

describe("decodePersistedRecords", () => {
  it("reads v1 files", () => {
    expect(
      decodePersistedRecords(encodePersistedRecords({ records: [record], specs: { tsk_1: spec } })),
    ).toEqual({
      ok: true,
      value: { records: [record], specs: { tsk_1: spec } },
      fromVersion: 1,
      issues: [],
    });
  });

  it("reads files without `version`, defaulting date/threadId/unread like the old reader", () => {
    const { date: _d, threadId: _t, unread: _u, ...sparse } = record;
    expect(decodePersistedRecords(JSON.stringify({ records: [sparse] }))).toEqual({
      ok: true,
      value: { records: [{ ...record, date: null, threadId: null, unread: 0 }], specs: {} },
      fromVersion: null,
      issues: [],
    });
  });

  it("drops invalid records and specs one by one", () => {
    const result = decodePersistedRecords(
      JSON.stringify({
        version: 1,
        records: [
          record,
          { ...record, taskId: "tsk_2", status: "sleeping" },
          { ...record, taskId: "tsk_3", line: -1 },
          { ...record, taskId: "tsk_4", date: "23/09/2026" },
          { ...record, taskId: "tsk_5", unread: 1.5 },
          { ...record, taskId: "" },
        ],
        specs: {
          tsk_1: spec,
          tsk_2: { ...spec, taskId: "tsk_other" },
          tsk_3: { ...spec, taskId: "tsk_3", capabilities: ["teleport"] },
        },
      }),
    );
    expect(result.ok && result.value.records.map((r) => r.taskId)).toEqual(["tsk_1"]);
    expect(result.ok && Object.keys(result.value.specs)).toEqual(["tsk_1"]);
    expect(result.ok && result.issues.map((issue) => issue.path)).toEqual([
      "records[1]",
      "records[2]",
      "records[3]",
      "records[4]",
      "records[5]",
      "specs.tsk_2",
      "specs.tsk_3",
    ]);
  });

  it("keeps the last copy of a duplicated task id", () => {
    const result = decodePersistedRecords(
      JSON.stringify({ version: 1, records: [record, { ...record, text: "later" }], specs: {} }),
    );
    expect(result.ok && result.value.records).toEqual([{ ...record, text: "later" }]);
  });

  it.each([
    ["records that are not a list", { version: 1, records: {}, specs: {} }],
    ["specs that are a list", { version: 1, records: [], specs: [] }],
    ["no records at all", { version: 1, specs: {} }],
  ])("treats %s as corrupt", (_label, doc) => {
    expect(decodePersistedRecords(JSON.stringify(doc))).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
  });
});

describe("encodePersistedRecords", () => {
  test.prop([recordsArb])("output parses with the v1 schema and round-trips exactly", (state) => {
    const text = encodePersistedRecords(state);
    expect(PersistedRecordsFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
    expect(decodePersistedRecords(text)).toEqual({
      ok: true,
      value: state,
      fromVersion: 1,
      issues: [],
    });
  });
});

describe("mergePersistedRecords", () => {
  it("keeps the record updated last and adds theirs-only records and specs", () => {
    const ours = { records: [record, { ...record, taskId: "tsk_2", updatedAt: 50 }], specs: {} };
    const theirs = {
      records: [
        { ...record, text: "newer", updatedAt: 2_000 },
        { ...record, taskId: "tsk_2", text: "older", updatedAt: 10 },
        { ...record, taskId: "tsk_3" },
      ],
      specs: { tsk_3: { ...spec, taskId: "tsk_3" } },
    };
    const merged = mergePersistedRecords(ours, theirs);
    expect(merged.records.map((r) => [r.taskId, r.text])).toEqual([
      ["tsk_1", "newer"],
      ["tsk_2", "Renew passport"],
      ["tsk_3", "Renew passport"],
    ]);
    expect(Object.keys(merged.specs)).toEqual(["tsk_3"]);
  });

  const records = fc.uniqueArray(recordArb(), { maxLength: 6, selector: (r) => r.taskId });

  test.prop([records, records])("is idempotent and loses no task id", (a, b) => {
    const ours = { records: a, specs: {} };
    const theirs = { records: b, specs: {} };
    const merged = mergePersistedRecords(ours, theirs);
    expect(mergePersistedRecords(merged, theirs)).toEqual(merged);
    const ids = new Set(merged.records.map((r) => r.taskId));
    for (const r of [...a, ...b]) expect(ids.has(r.taskId)).toBe(true);
  });
});
