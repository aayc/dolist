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

  it("places line anchors on their (moved or edited) line and highlights them", () => {
    const doc = [
      "- [ ] Book a table for Friday dinner",
      "\t- Trattoria Sole has a table at 7 %%agent:thr_1%%",
      "- [ ] Call the restaurant to confirm %%agent:thr_1%%",
      "What's the tallest building in New York?",
    ].join("\n");
    const annotations = buildAnnotations(doc, [
      record({ taskId: "book", text: "Book a table for Friday dinner", line: 0, status: "done" }),
      record({
        taskId: "anc_q",
        text: "What's the tallest building in NYC?",
        line: 1,
        status: "done",
        summary: "One World Trade Center",
        threadId: "thr_q",
        anchor: "line",
      }),
    ]);
    expect(annotations).toEqual([
      { id: "book", line: 0, status: "done", label: "Done", unread: 0, threadId: "thr_1" },
      {
        id: "anc_q",
        line: 3,
        status: "done",
        label: "Done · One World Trade Center",
        unread: 0,
        threadId: "thr_q",
        lineAnchor: true,
      },
    ]);
    // A task and a line anchor never claim each other's lines.
    expect(
      buildAnnotations("What's the tallest building in NYC?", [
        record({ taskId: "t", text: "What's the tallest building in NYC?", line: 0 }),
      ]),
    ).toEqual([]);
  });

  it("drops a line anchor whose line was deleted", () => {
    const anchor = record({ taskId: "anc_q", text: "Where to eat?", line: 1, anchor: "line" });
    expect(buildAnnotations("- [ ] a\nWhere to eat?", [anchor])).toHaveLength(1);
    expect(buildAnnotations("- [ ] a\n", [anchor])).toEqual([]);
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
