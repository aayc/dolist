import type { TaskAgentRecord } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { badgeLabel, buildAnnotations } from "./annotations";

function record(patch: Partial<TaskAgentRecord>): TaskAgentRecord {
  return {
    taskId: "t1",
    notePath: "Daily/2026-09-23.md",
    date: "2026-09-23",
    text: "Find a plumber",
    line: 0,
    status: "working",
    threadId: "thr_1",
    updatedAt: 1,
    unread: 0,
    ...patch,
  };
}

describe("badgeLabel", () => {
  it("maps statuses to short pill text", () => {
    expect(badgeLabel({ status: "triaging" })).toBe("Triaging…");
    expect(badgeLabel({ status: "working", summary: "Researching…" })).toBe("Researching…");
    expect(badgeLabel({ status: "working" })).toBe("Working…");
    expect(badgeLabel({ status: "waiting_approval", summary: "anything" })).toBe("Needs approval");
    expect(badgeLabel({ status: "done", summary: "3 options" })).toBe("Done · 3 options");
    expect(badgeLabel({ status: "done" })).toBe("Done");
    expect(badgeLabel({ status: "failed", summary: "timeout" })).toBe("Failed · timeout");
    expect(badgeLabel({ status: "idle" })).toBeNull();
    expect(badgeLabel({ status: "ignored" })).toBeNull();
  });
});

describe("buildAnnotations", () => {
  it("re-resolves lines against the locally edited document", () => {
    const doc = [
      "# Today",
      "",
      "- [ ] Call the bank",
      "- [ ] Find a plumber",
      "- [ ] Renew books",
    ].join("\n");
    const annotations = buildAnnotations(doc, [
      record({ taskId: "plumber", text: "Find a plumber", line: 0, summary: "Researching…" }),
      record({ taskId: "books", text: "Renew books", line: 1, status: "done", summary: "Renewed" }),
    ]);
    expect(annotations).toEqual([
      {
        id: "plumber",
        line: 3,
        status: "working",
        label: "Researching…",
        unread: 0,
        threadId: "thr_1",
      },
      {
        id: "books",
        line: 4,
        status: "done",
        label: "Done · Renewed",
        unread: 0,
        threadId: "thr_1",
      },
    ]);
  });

  it("drops hidden statuses and tasks that no longer exist", () => {
    const doc = "- [ ] Find a plumber";
    expect(
      buildAnnotations(doc, [
        record({ taskId: "idle", status: "idle" }),
        record({ taskId: "missing", text: "Walk the dog on Tuesday morning", line: 5 }),
      ]),
    ).toEqual([]);
  });
});
