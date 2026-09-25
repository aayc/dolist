import {
  ORCHESTRATOR_ACTIVITY_LIMITS,
  ORCHESTRATOR_THREAD_ID,
  type OrchestratorActivity,
} from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveOutcome,
  noteTrigger,
  OrchestratorActivityPublisher,
  type TurnEffect,
} from "./activity";

const NOTE = "Daily/2026-09-25.md";

function publisher(now = () => 1_000) {
  const events: OrchestratorActivity[] = [];
  const pub = new OrchestratorActivityPublisher({
    emit: (activity) => events.push(activity),
    now,
    lingerMs: 300,
    outcomeStatusMs: 5_000,
  });
  return { pub, events, phases: () => events.map((e) => e.phase) };
}

describe("OrchestratorActivityPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks a turn through reading, thinking, acting and idle with its outcome", () => {
    const { pub, events, phases } = publisher();
    const trigger = noteTrigger("note", NOTE, [{ line: 3, text: "find a plumber" }]);
    pub.beginTurn("msg_1", trigger);
    pub.thinking();
    pub.toolStarted();
    pub.toolEnded();
    vi.advanceTimersByTime(300);
    pub.endTurn({ kind: "no_action" });
    expect(phases()).toEqual(["reading", "thinking", "acting", "thinking", "idle"]);
    expect(events.every((e) => e.turnId === "msg_1" && e.trigger === trigger)).toBe(true);
    expect(events.at(-1)).toEqual({
      phase: "idle",
      turnId: "msg_1",
      trigger,
      startedAt: 1_000,
      outcome: { kind: "no_action" },
    });
  });

  it("reads tool calls in a row as one stretch of acting", () => {
    const { pub, phases } = publisher();
    pub.beginTurn("msg_1", { kind: "task", summary: "2 tasks" });
    pub.thinking();
    for (let i = 0; i < 5; i++) {
      pub.toolStarted();
      vi.advanceTimersByTime(20);
      pub.toolEnded();
      vi.advanceTimersByTime(100);
    }
    pub.thinking();
    expect(phases()).toEqual(["reading", "thinking", "acting"]);
    vi.advanceTimersByTime(300);
    expect(phases()).toEqual(["reading", "thinking", "acting", "thinking"]);
  });

  it("drops repeats", () => {
    const { pub, phases } = publisher();
    pub.beginTurn("msg_1", { kind: "message", summary: "your message" });
    pub.thinking();
    pub.thinking();
    pub.notice(NOTE, [{ line: 1, text: "call mom?" }]);
    pub.notice(NOTE, [{ line: 1, text: "call mom?" }]);
    expect(phases()).toEqual(["reading", "thinking", "noticed"]);
  });

  it("shows an approval the turn waits for while acting, and drops it once decided", () => {
    const { pub, events } = publisher();
    pub.beginTurn("msg_1", { kind: "routine", summary: "routine “Morning briefing”" });
    pub.toolStarted();
    pub.approval("apr_1", "Create routine “Morning briefing”", true);
    expect(events.at(-1)).toMatchObject({
      phase: "acting",
      outcome: {
        kind: "asked_approval",
        threadId: ORCHESTRATOR_THREAD_ID,
        text: "Create routine “Morning briefing”",
      },
    });
    expect(pub.pendingApproval()).toBe("Create routine “Morning briefing”");
    pub.approval("apr_1", "Create routine “Morning briefing”", false);
    expect(events.at(-1)).toMatchObject({ phase: "acting" });
    expect(events.at(-1)?.outcome).toBeUndefined();
    expect(pub.pendingApproval()).toBeUndefined();
  });

  it("keeps noticed lines until a turn takes them, and withdraws the ones that went away", () => {
    const { pub, events } = publisher();
    pub.notice(NOTE, [
      { line: 2, text: "find a plumber" },
      { line: 5, text: "book a table?" },
    ]);
    expect(pub.current()).toMatchObject({ phase: "noticed", trigger: { notePath: NOTE } });
    pub.beginTurn("msg_1", noteTrigger("note", NOTE, [{ line: 2, text: "find a plumber" }]));
    pub.endTurn({ kind: "no_action" });
    expect(pub.current()).toMatchObject({
      phase: "noticed",
      trigger: { lines: [{ line: 5, text: "book a table?" }] },
    });
    pub.notice(NOTE, []);
    expect(events.at(-1)).toEqual({
      phase: "idle",
      trigger: { kind: "note", notePath: NOTE, lines: [], summary: "your note" },
    });
  });

  it("reports the last outcome to joining clients for a while, then idle", () => {
    let now = 1_000;
    const { pub } = publisher(() => now);
    pub.beginTurn("msg_1", { kind: "message", summary: "your message" });
    expect(pub.current()).toMatchObject({ phase: "reading", turnId: "msg_1" });
    pub.endTurn({ kind: "replied", threadId: ORCHESTRATOR_THREAD_ID });
    expect(pub.current()).toMatchObject({ phase: "idle", outcome: { kind: "replied" } });
    now += 5_000;
    expect(pub.current()).toEqual({ phase: "idle" });
  });

  it("ends a failed or stopped turn without an outcome", () => {
    const { pub, events } = publisher();
    pub.beginTurn("msg_1", { kind: "task", summary: "“Renew passport”" });
    pub.endTurn(undefined);
    expect(events.at(-1)).toMatchObject({ phase: "idle", turnId: "msg_1" });
    expect(events.at(-1)?.outcome).toBeUndefined();
  });
});

describe("noteTrigger", () => {
  it("quotes a single line and counts several", () => {
    expect(noteTrigger("note", NOTE, [{ line: 0, text: "call mom tomorrow" }]).summary).toBe(
      "“call mom tomorrow”",
    );
    expect(
      noteTrigger("note", NOTE, [
        { line: 4, text: "b" },
        { line: 1, text: "a" },
      ]),
    ).toMatchObject({
      lines: [
        { line: 1, text: "a" },
        { line: 4, text: "b" },
      ],
      summary: "2 lines in your note",
    });
    expect(
      noteTrigger("task", NOTE, [
        { line: 0, text: "x" },
        { line: 1, text: "y" },
      ]).summary,
    ).toBe("2 tasks");
  });

  it("stays within the limits", () => {
    const long = `Could you look into ${"a very long request ".repeat(40)}?`;
    const lines = Array.from({ length: 30 }, (_, line) => ({ line, text: long }));
    const trigger = noteTrigger("note", NOTE, lines);
    expect(trigger.lines).toHaveLength(ORCHESTRATOR_ACTIVITY_LIMITS.lines);
    for (const line of trigger.lines ?? []) {
      expect(line.text.length).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.lineChars);
    }
    const one = noteTrigger("note", NOTE, [{ line: 0, text: long }]);
    expect(one.summary.length).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.summaryChars);
    expect(one.summary).toMatch(/^“Could you look into a very long request .*…”$/);
  });
});

describe("deriveOutcome", () => {
  const threads: Record<string, string> = { anc_1: "thr_anc1", tsk_1: "thr_tsk1" };
  const outcome = (
    effects: TurnEffect[],
    extra: Partial<Parameters<typeof deriveOutcome>[0]> = {},
  ) => deriveOutcome({ effects, threadOf: (id) => threads[id] ?? null, ...extra });
  const call = (toolName: string, input: unknown): TurnEffect => ({ toolName, input });

  it("is nothing to do without effects, with the turn's last words as its tooltip", () => {
    expect(outcome([])).toEqual({ kind: "no_action" });
    expect(outcome([], { finalText: "\nJust a note to self — leaving it.\nMore." })).toEqual({
      kind: "no_action",
      text: "Just a note to self — leaving it.",
    });
    expect(outcome([call("anchor_line", { line: 2 }), call("list_tasks", {})]).kind).toBe(
      "no_action",
    );
  });

  it("counts the tasks it wrote into the note", () => {
    expect(
      outcome([
        call("edit_note", {
          taskId: "anc_1",
          edits: [
            { op: "add_under", taskId: "anc_1", lines: ["- [ ] Send the invitations", "notes"] },
            { op: "append", lines: ["- [ ] Buy balloons", "* [ ] Order the cake"] },
          ],
        }),
      ]),
    ).toEqual({ kind: "tasks_added", count: 3, text: "Send the invitations" });
  });

  it("tells other note edits apart", () => {
    expect(
      outcome([
        call("edit_note", {
          taskId: "anc_1",
          edits: [{ op: "add_under", taskId: "anc_1", lines: ["541 m ([CTBUH](https://x.test))"] }],
        }),
      ]),
    ).toEqual({
      kind: "note_edited",
      count: 1,
      threadId: "thr_anc1",
      text: "541 m ([CTBUH](https://x.test))",
    });
  });

  it("replies on a line or task, or in its chat", () => {
    expect(
      outcome([
        call("post_comment", { taskId: "anc_1", text: "Nairobi.\n\nSource: …" }),
        call("set_task_status", { taskId: "anc_1", status: "done" }),
        call("edit_note", { taskId: "anc_1", edits: [{ op: "add_under", lines: ["Nairobi"] }] }),
      ]),
    ).toEqual({ kind: "replied", count: 1, threadId: "thr_anc1", text: "Nairobi." });
    expect(outcome([call("ask_user", { taskId: "tsk_1", question: "Which dentist?" })])).toEqual({
      kind: "replied",
      count: 1,
      threadId: "thr_tsk1",
      text: "Which dentist?",
    });
    expect(outcome([], { chatReply: "Nothing is running right now." })).toEqual({
      kind: "replied",
      threadId: ORCHESTRATOR_THREAD_ID,
      text: "Nothing is running right now.",
    });
  });

  it("prefers subagents started, then a routine made, then tasks added", () => {
    const edit = call("edit_note", { edits: [{ op: "append", lines: ["- [ ] Pack"] }] });
    const routine = call("create_routine", { name: "Morning briefing" });
    const spawn = (taskId: string) =>
      call("spawn_subagent", { taskId, goal: "Find a plumber available on Saturday" });
    expect(outcome([edit, routine, spawn("anc_1"), spawn("tsk_1"), spawn("anc_1")])).toEqual({
      kind: "delegated",
      count: 2,
      threadId: "thr_anc1",
      text: "Find a plumber available on Saturday",
    });
    expect(outcome([edit, routine])).toEqual({
      kind: "routine_created",
      count: 1,
      text: "Routine “Morning briefing”",
    });
    expect(outcome([call("post_comment", { taskId: "tsk_1", text: "On it" }), edit]).kind).toBe(
      "tasks_added",
    );
  });

  it("says it needs approval above everything while an approval waits", () => {
    expect(
      outcome([call("spawn_subagent", { taskId: "tsk_1", goal: "x" })], {
        pendingApproval: "Change your line “call mom”",
      }),
    ).toEqual({
      kind: "asked_approval",
      threadId: ORCHESTRATOR_THREAD_ID,
      text: "Change your line “call mom”",
    });
  });

  it("keeps its tooltip short", () => {
    const long = "word ".repeat(100);
    const result = outcome([call("post_comment", { taskId: "tsk_1", text: long })]);
    expect(result.text!.length).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.outcomeTextChars);
  });
});
