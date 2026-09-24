import { test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decodePersistedTaskState,
  encodePersistedTaskState,
  type PersistedTaskState,
  PersistedTaskStateFileSchema,
  type PersistedTrackedTask,
} from "../../src/persisted";
import { taskStateArb } from "./arbitraries";

const task: PersistedTrackedTask = {
  id: "tsk_a",
  text: "Renew passport",
  status: "open",
  line: 0,
  depth: 0,
  parentId: null,
  notes: ["before June"],
  firstSeenAt: 1,
  updatedAt: 2,
};
const state: PersistedTaskState = {
  notePath: "Daily/2026-09-23.md",
  contentVersion: "0a1b2c3d4e5f60",
  tasks: [task],
  settled: { tsk_a: { task, announced: true } },
};

describe("decodePersistedTaskState", () => {
  it("reads v1 files", () => {
    expect(decodePersistedTaskState(encodePersistedTaskState(state))).toEqual({
      ok: true,
      value: state,
      fromVersion: 1,
      issues: [],
    });
  });

  it("refuses state recorded for another note when the expected note is given", () => {
    const text = encodePersistedTaskState(state);
    expect(decodePersistedTaskState(text, "Daily/2026-09-23.md")).toMatchObject({ ok: true });
    expect(decodePersistedTaskState(text, "Daily/2026-09-24.md")).toEqual({
      ok: false,
      kind: "corrupt",
      reason: "tracker state belongs to a different note",
    });
  });

  it("drops invalid tasks and settled snapshots one by one", () => {
    const result = decodePersistedTaskState(
      JSON.stringify({
        version: 1,
        ...state,
        tasks: [
          task,
          { ...task, id: "tsk_b", status: "blocked" },
          { ...task, id: "tsk_c", depth: undefined },
        ],
        settled: {
          tsk_a: { task, announced: true },
          tsk_b: { task: { ...task, id: "tsk_other" }, announced: true },
          tsk_c: { task: { ...task, id: "tsk_c" }, announced: "yes" },
        },
      }),
    );
    expect(result.ok && result.value.tasks.map((t) => t.id)).toEqual(["tsk_a"]);
    expect(result.ok && Object.keys(result.value.settled)).toEqual(["tsk_a"]);
    expect(result.ok && result.issues.map((issue) => issue.path)).toEqual([
      "tasks[1]",
      "tasks[2]",
      "settled.tsk_b",
      "settled.tsk_c",
    ]);
  });

  it.each([
    ["no note path", { ...state, notePath: "" }],
    ["a numeric content version", { ...state, contentVersion: 5 }],
    ["tasks that are not a list", { ...state, tasks: null }],
  ])("treats state with %s as corrupt", (_label, doc) => {
    expect(decodePersistedTaskState(JSON.stringify({ version: 1, ...doc }))).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
  });

  it("reports a newer version", () => {
    expect(decodePersistedTaskState('{"version":2}')).toEqual({
      ok: false,
      kind: "newer",
      version: 2,
    });
  });
});

describe("encodePersistedTaskState", () => {
  test.prop([taskStateArb()])(
    "output parses with the v1 schema and round-trips exactly",
    (value) => {
      const text = encodePersistedTaskState(value);
      expect(PersistedTaskStateFileSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(decodePersistedTaskState(text, value.notePath)).toEqual({
        ok: true,
        value,
        fromVersion: 1,
        issues: [],
      });
    },
  );
});
