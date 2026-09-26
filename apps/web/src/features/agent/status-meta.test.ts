import { ORCHESTRATOR_THREAD_ID, type ThreadSummary } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { authorLabel, inboxGroupOf, isInboxThread } from "./status-meta";

const now = new Date(2026, 8, 23, 15, 0).getTime();

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

describe("what the inbox lists", () => {
  it("lists task threads, but not the orchestrator's chat (pinned above them)", () => {
    expect(isInboxThread(thread({}))).toBe(true);
    expect(isInboxThread(thread({ id: ORCHESTRATOR_THREAD_ID, taskId: null }))).toBe(false);
  });

  it("leaves a routine's runs under their routine, unless one waits for you", () => {
    const run = (patch: Partial<ThreadSummary>) =>
      thread({ routineId: "rtn_1", taskId: "run_1", notePath: "Routines/Watch.md", ...patch });
    expect(isInboxThread(run({ status: "done" }))).toBe(false);
    expect(isInboxThread(run({ status: "working" }))).toBe(false);
    expect(isInboxThread(run({ status: "failed" }))).toBe(false);
    expect(isInboxThread(run({ status: "waiting_approval" }))).toBe(true);
    expect(isInboxThread(run({ status: "working", pendingApprovals: 1 }))).toBe(true);
    expect(isInboxThread(run({ status: "waiting_user" }))).toBe(true);
  });
});

describe("inbox grouping", () => {
  it("puts anything waiting on the user first", () => {
    expect(inboxGroupOf(thread({ status: "waiting_user" }))).toBe("needs_you");
    expect(inboxGroupOf(thread({ status: "working", pendingApprovals: 1 }))).toBe("needs_you");
    expect(inboxGroupOf(thread({ status: "queued" }))).toBe("working");
    expect(inboxGroupOf(thread({ status: "cancelled" }))).toBe("other");
  });

  it("labels authors", () => {
    expect(authorLabel("subagent:research")).toBe("Research agent");
    expect(authorLabel("orchestrator")).toBe("Orchestrator");
  });
});
