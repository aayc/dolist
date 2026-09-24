import type {
  ApprovalRequest,
  TaskAgentRecord,
  TextMessage,
  Thread,
  ThreadSummary,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  type AgentState,
  applyRecordsSnapshot,
  applyThreadResponse,
  countPendingApprovals,
  findRecordIn,
  initialAgentState,
  reduceAgentEvent,
} from "./agent-reducer";

function record(patch: Partial<TaskAgentRecord> = {}): TaskAgentRecord {
  return {
    taskId: "tsk_1",
    notePath: "Daily/2026-09-23.md",
    date: "2026-09-23",
    text: "Buy milk",
    line: 0,
    status: "triaging",
    threadId: null,
    updatedAt: 10,
    unread: 0,
    ...patch,
  };
}

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: "thr_1",
    taskId: "tsk_1",
    notePath: "Daily/2026-09-23.md",
    title: "Buy milk",
    status: "working",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    artifacts: [],
    surfaces: [],
    ...patch,
  };
}

function summary(patch: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thr_1",
    taskId: "tsk_1",
    notePath: "Daily/2026-09-23.md",
    title: "Buy milk",
    status: "working",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    artifactCount: 0,
    surfaces: [],
    pendingApprovals: 0,
    ...patch,
  };
}

function textMessage(patch: Partial<TextMessage> = {}): TextMessage {
  return {
    id: "msg_1",
    kind: "text",
    role: "agent",
    author: "orchestrator",
    createdAt: 1,
    text: "",
    streaming: true,
    ...patch,
  };
}

function loaded(): AgentState {
  return applyThreadResponse(initialAgentState, { thread: thread(), approvals: [] });
}

describe("records", () => {
  it("applies task.record upserts and ignores stale updates", () => {
    let state = reduceAgentEvent(initialAgentState, { type: "task.record", record: record() });
    state = reduceAgentEvent(state, {
      type: "task.record",
      record: record({ status: "working", threadId: "thr_1", updatedAt: 20 }),
    });
    expect(state.records["Daily/2026-09-23.md"]?.tsk_1?.status).toBe("working");
    const stale = reduceAgentEvent(state, {
      type: "task.record",
      record: record({ updatedAt: 5 }),
    });
    expect(stale).toBe(state);
  });

  it("moves a record between notes when its notePath changes", () => {
    let state = reduceAgentEvent(initialAgentState, { type: "task.record", record: record() });
    state = reduceAgentEvent(state, {
      type: "task.record",
      record: record({ notePath: "Journal/2026-09-23.md", updatedAt: 30 }),
    });
    expect(state.records["Daily/2026-09-23.md"]?.tsk_1).toBeUndefined();
    expect(findRecordIn(state.records, "tsk_1")?.notePath).toBe("Journal/2026-09-23.md");
  });

  it("replaces a note's records with a snapshot but keeps newer known records", () => {
    let state = reduceAgentEvent(initialAgentState, {
      type: "task.record",
      record: record({ status: "done", updatedAt: 50 }),
    });
    state = reduceAgentEvent(state, {
      type: "task.record",
      record: record({ taskId: "tsk_gone", updatedAt: 1 }),
    });
    state = applyRecordsSnapshot(state, "Daily/2026-09-23.md", [
      record({ status: "working", updatedAt: 40 }),
    ]);
    const bucket = state.records["Daily/2026-09-23.md"]!;
    expect(bucket.tsk_1?.status).toBe("done");
    expect(bucket.tsk_gone).toBeUndefined();
  });

  it("ignores a stale task.record for a task that has moved to another note", () => {
    let state = reduceAgentEvent(initialAgentState, {
      type: "task.record",
      record: record({ notePath: "Journal/2026-09-23.md", status: "done", updatedAt: 50 }),
    });
    state = reduceAgentEvent(state, { type: "task.record", record: record({ updatedAt: 40 }) });
    expect(findRecordIn(state.records, "tsk_1")?.notePath).toBe("Journal/2026-09-23.md");
    expect(state.records["Daily/2026-09-23.md"]?.tsk_1).toBeUndefined();
  });

  it("keeps a task in one note when another note's snapshot contains it", () => {
    // A rename: the new path's snapshot arrives while the old path still lists the task.
    let state = reduceAgentEvent(initialAgentState, { type: "task.record", record: record() });
    state = applyRecordsSnapshot(state, "Journal/2026-09-23.md", [
      record({ notePath: "Journal/2026-09-23.md", updatedAt: 10 }),
    ]);
    expect(state.records["Daily/2026-09-23.md"]?.tsk_1).toBeUndefined();
    expect(state.records["Journal/2026-09-23.md"]?.tsk_1).toBeDefined();
    // A stale snapshot of the old path doesn't pull the task back.
    state = applyRecordsSnapshot(state, "Daily/2026-09-23.md", [record({ updatedAt: 5 })]);
    expect(state.records["Daily/2026-09-23.md"]?.tsk_1).toBeUndefined();
    expect(findRecordIn(state.records, "tsk_1")?.notePath).toBe("Journal/2026-09-23.md");
  });

  it("task.records replaces the bucket", () => {
    const state = reduceAgentEvent(initialAgentState, {
      type: "task.records",
      notePath: "Daily/2026-09-23.md",
      records: [record({ taskId: "a" }), record({ taskId: "b" })],
    });
    expect(Object.keys(state.records["Daily/2026-09-23.md"]!)).toEqual(["a", "b"]);
  });
});

describe("threads", () => {
  it("tracks summaries and keeps loaded details in sync", () => {
    const state = reduceAgentEvent(loaded(), {
      type: "thread.upsert",
      thread: summary({ status: "waiting_approval", surfaces: ["browser"], title: "Buy oat milk" }),
    });
    expect(state.threads.thr_1?.status).toBe("waiting_approval");
    expect(state.details.thr_1?.status).toBe("waiting_approval");
    expect(state.details.thr_1?.surfaces).toEqual(["browser"]);
    expect(state.details.thr_1?.title).toBe("Buy oat milk");
  });

  it("ignores messages for threads that are not loaded", () => {
    const state = reduceAgentEvent(initialAgentState, {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage(),
    });
    expect(state).toBe(initialAgentState);
  });

  it("streams deltas into a message and replaces it with the final version", () => {
    let state = reduceAgentEvent(loaded(), {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage(),
    });
    for (const delta of ["Looking ", "for ", "options…"]) {
      state = reduceAgentEvent(state, {
        type: "thread.delta",
        threadId: "thr_1",
        messageId: "msg_1",
        delta,
      });
    }
    const streaming = state.details.thr_1?.messages[0];
    expect(streaming?.kind === "text" && streaming.text).toBe("Looking for options…");
    state = reduceAgentEvent(state, {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage({ text: "Looking for options…", streaming: false }),
    });
    expect(state.details.thr_1?.messages).toHaveLength(1);
    const final = state.details.thr_1?.messages[0];
    expect(final?.kind === "text" && final.streaming).toBe(false);
  });

  it("only copies the changed message on a delta (others keep identity)", () => {
    let state = reduceAgentEvent(loaded(), {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage({ id: "msg_0", text: "done", streaming: false }),
    });
    state = reduceAgentEvent(state, {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage(),
    });
    const before = state.details.thr_1!.messages[0];
    state = reduceAgentEvent(state, {
      type: "thread.delta",
      threadId: "thr_1",
      messageId: "msg_1",
      delta: "x",
    });
    expect(state.details.thr_1!.messages[0]).toBe(before);
  });

  it("ignores deltas that arrive after the message finished streaming", () => {
    // E.g. a thread refetch returned the final text before in-flight deltas were delivered.
    let state = reduceAgentEvent(loaded(), {
      type: "thread.message",
      threadId: "thr_1",
      message: textMessage({ text: "Found 3 options", streaming: false }),
    });
    const final = state;
    state = reduceAgentEvent(state, {
      type: "thread.delta",
      threadId: "thr_1",
      messageId: "msg_1",
      delta: " options",
    });
    expect(state).toBe(final);
  });

  it("returns the same state for deltas to unknown messages", () => {
    const state = loaded();
    expect(
      reduceAgentEvent(state, {
        type: "thread.delta",
        threadId: "thr_1",
        messageId: "nope",
        delta: "x",
      }),
    ).toBe(state);
  });
});

describe("approvals and status", () => {
  const approval: ApprovalRequest = {
    id: "apr_1",
    threadId: "thr_1",
    taskId: "tsk_1",
    toolName: "browser_click",
    input: { element: "Place order button" },
    summary: "Place order",
    risk: "high",
    categories: ["payment"],
    reason: "Spends money",
    status: "pending",
    createdAt: 1,
  };

  it("upserts approvals and counts pending ones", () => {
    let state = reduceAgentEvent(initialAgentState, { type: "approval.upsert", approval });
    expect(countPendingApprovals(state)).toBe(1);
    state = reduceAgentEvent(state, {
      type: "approval.upsert",
      approval: { ...approval, status: "approved", scope: "once", decidedAt: 2 },
    });
    expect(countPendingApprovals(state)).toBe(0);
  });

  it("merges approvals from a thread response", () => {
    const state = applyThreadResponse(initialAgentState, {
      thread: thread(),
      approvals: [approval],
    });
    expect(state.approvals.apr_1?.status).toBe("pending");
    expect(state.threads.thr_1?.pendingApprovals).toBe(1);
  });

  it("stores agent status", () => {
    const status = {
      mode: "mock" as const,
      enabled: true,
      model: "m",
      running: 1,
      queued: 0,
      pendingApprovals: 0,
      connectors: [],
      execution: {
        provider: "mock",
        capabilities: { shell: false, browser: true, computer: true },
      },
    };
    expect(reduceAgentEvent(initialAgentState, { type: "agent.status", status }).status).toEqual(
      status,
    );
  });
});
