import { describe, expect, it } from "vitest";
import {
  decodePersistedRoutines,
  encodePersistedRoutines,
  mergePersistedRoutines,
  type PersistedRoutineState,
  PersistedRoutinesFileSchema,
} from "../../src/persisted";

const state: PersistedRoutineState = {
  path: "Routines/Morning briefing.md",
  scheduleKey: "every weekday at 7:30",
  nextRunAt: 2_000,
  lastRun: {
    runId: "run_1",
    threadId: "thr_1",
    trigger: "schedule",
    status: "done",
    startedAt: 1_000,
    finishedAt: 1_500,
    summary: "3 meetings",
    result: "Three meetings today.",
    changed: true,
    notified: true,
  },
  runs: ["thr_1"],
  extraRuns: { date: "2026-09-25", count: 2 },
  updatedAt: 1_500,
};

describe("decodePersistedRoutines", () => {
  it("round-trips v1 files exactly", () => {
    const text = encodePersistedRoutines({ routines: { rtn_a: state } });
    expect(PersistedRoutinesFileSchema.parse(JSON.parse(text))).toEqual({
      version: 1,
      routines: { rtn_a: state },
    });
    expect(decodePersistedRoutines(text)).toEqual({
      ok: true,
      value: { routines: { rtn_a: state } },
      fromVersion: 1,
      issues: [],
    });
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("drops invalid routines one by one", () => {
    const result = decodePersistedRoutines(
      JSON.stringify({
        version: 1,
        routines: {
          rtn_a: state,
          rtn_b: { ...state, nextRunAt: "soon" },
          rtn_c: { ...state, lastRun: { ...state.lastRun, trigger: "cron" } },
        },
      }),
    );
    expect(result.ok && Object.keys(result.value.routines)).toEqual(["rtn_a"]);
    expect(result.ok && result.issues.map((issue) => issue.path)).toEqual([
      "routines.rtn_b",
      "routines.rtn_c",
    ]);
  });

  it("leaves files from a newer app alone and quarantines broken ones", () => {
    expect(decodePersistedRoutines('{"version":7,"routines":{}}')).toMatchObject({
      ok: false,
      kind: "newer",
      version: 7,
    });
    expect(decodePersistedRoutines('{"version":1,"routines":[]}')).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
    expect(decodePersistedRoutines("")).toMatchObject({ ok: false, kind: "corrupt" });
  });
});

describe("mergePersistedRoutines", () => {
  it("keeps each routine's most recently updated state", () => {
    const newer = { ...state, nextRunAt: 9_000, updatedAt: 3_000 };
    const other = { ...state, path: "Routines/Other.md", updatedAt: 10 };
    const merged = mergePersistedRoutines(
      { routines: { rtn_a: state, rtn_b: other } },
      { routines: { rtn_a: newer, rtn_c: other } },
    );
    expect(merged.routines).toEqual({ rtn_a: newer, rtn_b: other, rtn_c: other });
    expect(mergePersistedRoutines(merged, { routines: { rtn_a: state } })).toEqual(merged);
  });
});
