import type { ThreadSummary } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { authorLabel, groupThreads, inboxGroupOf } from "./status-meta";

const now = new Date(2026, 8, 23, 15, 0).getTime();
const yesterday = new Date(2026, 8, 22, 15, 0).getTime();

function thread(patch: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "t",
    taskId: "k",
    notePath: "Daily/2026-09-23.md",
    title: "Task",
    status: "done",
    createdAt: now - 1000,
    updatedAt: now - 1000,
    messageCount: 1,
    artifactCount: 0,
    surfaces: [],
    pendingApprovals: 0,
    ...patch,
  };
}

describe("inbox grouping", () => {
  it("puts anything waiting on the user first", () => {
    expect(inboxGroupOf(thread({ status: "waiting_user" }))).toBe("needs_you");
    expect(inboxGroupOf(thread({ status: "working", pendingApprovals: 1 }))).toBe("needs_you");
    expect(inboxGroupOf(thread({ status: "queued" }))).toBe("working");
    expect(inboxGroupOf(thread({ status: "cancelled" }))).toBe("other");
  });

  it("shows today's threads plus older ones that still need attention, newest first", () => {
    const groups = groupThreads(
      [
        thread({ id: "old-done", updatedAt: yesterday, createdAt: yesterday }),
        thread({
          id: "old-waiting",
          status: "waiting_approval",
          updatedAt: yesterday,
          createdAt: yesterday,
        }),
        thread({ id: "done-a", updatedAt: now - 5000 }),
        thread({ id: "done-b", updatedAt: now - 100 }),
        thread({ id: "working", status: "working" }),
      ],
      now,
    );
    expect(groups.needs_you.map((t) => t.id)).toEqual(["old-waiting"]);
    expect(groups.working.map((t) => t.id)).toEqual(["working"]);
    expect(groups.done.map((t) => t.id)).toEqual(["done-b", "done-a"]);
    expect(groups.other).toEqual([]);
  });

  it("labels authors", () => {
    expect(authorLabel("subagent:research")).toBe("Research agent");
    expect(authorLabel("orchestrator")).toBe("Orchestrator");
  });
});
