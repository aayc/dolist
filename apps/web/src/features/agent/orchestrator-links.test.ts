import type { TaskAgentRecord, ThreadMessage, ThreadSummary } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { type AgentState, initialAgentState } from "../../state/agent-reducer";
import { resolveTask, taskIdOf } from "./orchestrator-links";

function toolCall(input: unknown): ThreadMessage {
  return {
    id: "msg_1",
    kind: "tool_call",
    author: "orchestrator",
    createdAt: 1,
    toolCallId: "call_1",
    toolName: "spawn_subagent",
    input,
    status: "ok",
  };
}

function summary(id: string, taskId: string | null, updatedAt: number, title = id): ThreadSummary {
  return {
    id,
    taskId,
    notePath: "Daily/2026-09-24.md",
    title,
    status: "working",
    createdAt: 1,
    updatedAt,
    messageCount: 0,
    artifactCount: 0,
    surfaces: [],
    pendingApprovals: 0,
  };
}

const record: TaskAgentRecord = {
  taskId: "tsk_gym",
  notePath: "Daily/2026-09-24.md",
  date: "2026-09-24",
  text: "Go to the gym",
  line: 3,
  status: "ignored",
  threadId: null,
  updatedAt: 1,
  unread: 0,
};

describe("orchestrator task links", () => {
  it("reads the task id a tool call acts on", () => {
    expect(taskIdOf(toolCall({ taskId: "tsk_a", goal: "x" }))).toBe("tsk_a");
    expect(taskIdOf(toolCall({ query: "desks" }))).toBeNull();
    expect(taskIdOf(toolCall({ taskId: 42 }))).toBeNull();
    expect(taskIdOf(toolCall(undefined))).toBeNull();
    expect(
      taskIdOf({
        id: "m",
        kind: "text",
        role: "agent",
        author: "orchestrator",
        text: "",
        createdAt: 1,
      }),
    ).toBeNull();
  });

  it("finds the task's newest thread, or its record when it has none", () => {
    const state: AgentState = {
      ...initialAgentState,
      threads: {
        thr_old: summary("thr_old", "tsk_desk", 1, "Old title"),
        thr_new: summary("thr_new", "tsk_desk", 5, "Research standing desks"),
        thr_orchestrator: summary("thr_orchestrator", null, 9),
      },
      records: { "Daily/2026-09-24.md": { tsk_gym: record } },
    };
    expect(resolveTask(state, "tsk_desk")).toEqual({
      taskId: "tsk_desk",
      threadId: "thr_new",
      title: "Research standing desks",
    });
    expect(resolveTask(state, "tsk_gym")).toEqual({
      taskId: "tsk_gym",
      threadId: null,
      title: "Go to the gym",
    });
    expect(resolveTask(state, "tsk_unknown")).toBeNull();
  });
});
