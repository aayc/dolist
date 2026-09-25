/**
 * What the orchestrator is doing, as the editor sees it (`orchestrator.activity`): lines noticed
 * before they settle, each turn's phases per kind of trigger (a line of prose, a task, a message,
 * a routine run), the outcome derived from the turn's tool calls, and the bounds and coalescing
 * that keep it cheap.
 */
import {
  ORCHESTRATOR_ACTIVITY_LIMITS,
  ORCHESTRATOR_THREAD_ID,
  type OrchestratorActivity,
  truncate,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

type Timed = OrchestratorActivity & { at: number };

function activities(t: FakeAgentRuntime): Timed[] {
  return t.events.flatMap((e) =>
    e.type === "orchestrator.activity" ? [{ ...e.payload, at: e.at }] : [],
  );
}

function turn(t: FakeAgentRuntime, turnId: string | undefined): Timed[] {
  return activities(t).filter((a) => a.turnId === turnId);
}

/** Waits for the first activity matching `check`, after `after` events. */
function nextActivity(
  t: FakeAgentRuntime,
  check: (activity: Timed) => boolean,
  what: string,
): Promise<Timed> {
  return t.waitFor(() => activities(t).find(check), { what });
}

function endOf(t: FakeAgentRuntime, turnId: string | undefined): Promise<Timed> {
  return nextActivity(t, (a) => a.turnId === turnId && a.phase === "idle", "the turn to end");
}

/** A turn's phases: reading, thinking, acting at most in alternation, then idle, never repeated. */
function expectTurnShape(phases: readonly string[], options: { acts: boolean }): void {
  expect(phases.slice(0, 2)).toEqual(["reading", "thinking"]);
  expect(phases.at(-1)).toBe("idle");
  expect(phases.includes("acting")).toBe(options.acts);
  for (let i = 1; i < phases.length; i++) expect(phases[i]).not.toBe(phases[i - 1]);
  for (const phase of phases.slice(2, -1)) expect(["thinking", "acting"]).toContain(phase);
}

describe("orchestrator activity", () => {
  it("a question written as prose: noticed before it settles, then the turn and its reply", async () => {
    const settleMs = 400;
    const t = await fakeRuntime({ settings: { agent: { settleMs } } });
    const line = "What's the capital of Kenya?";
    const path = await t.writeDailyNote(["Notes for today", line]);
    const noticed = await nextActivity(t, (a) => a.phase === "noticed", "the line noticed");
    expect(noticed).toMatchObject({
      phase: "noticed",
      trigger: {
        kind: "note",
        notePath: path,
        lines: [{ line: 1, text: line }],
        summary: `“${line}”`,
      },
    });
    expect(noticed.turnId).toBeUndefined();

    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    expect(reading.at - noticed.at).toBeGreaterThanOrEqual(settleMs - 5);
    expect(reading.trigger).toEqual(noticed.trigger);
    const opening = t.chat().messages.find((m) => m.id === reading.turnId);
    expect(opening).toMatchObject({ kind: "status", status: "working" });

    const end = await endOf(t, reading.turnId);
    expectTurnShape(
      turn(t, reading.turnId).map((a) => a.phase),
      { acts: true },
    );
    const anchor = t.record(line)!;
    expect(end.outcome).toEqual({
      kind: "replied",
      count: 1,
      threadId: anchor.threadId,
      text: expect.stringContaining("Nairobi"),
    });
    expect(end.trigger).toEqual(reading.trigger);
    expectAllGated(t);
  });

  it("plain prose never wakes it", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 20 } } });
    await t.writeDailyNote(["Had a lovely walk by the river today.", "The café was busy."]);
    await t.advance(300);
    expect(activities(t)).toEqual([]);
    expect(t.digests()).toEqual([]);
  });

  it("a line that only looks like a request ends with nothing to do", async () => {
    const t = await fakeRuntime();
    const line = "find a plumber for Saturday";
    await t.writeDailyNote([line]);
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    const end = await endOf(t, reading.turnId);
    expect(turn(t, reading.turnId).map((a) => a.phase)).toEqual(["reading", "thinking", "idle"]);
    expect(end.outcome).toEqual({ kind: "no_action" });
    expect(activities(t)[0]?.phase).toBe("noticed");
  });

  it("typing a line out is noticed once per line, not per save", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 500 } } });
    for (const text of ["find a plu", "find a plumb", "find a plumber for Sat"]) {
      await t.writeDailyNote([text]);
      await t.advance(40);
    }
    await t.writeDailyNote(["find a plumber for Saturday", "Could you book a table?"]);
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    const noticed = activities(t).filter((a) => a.phase === "noticed");
    expect(noticed.map((a) => a.trigger?.lines?.map((l) => l.line))).toEqual([[0], [0, 1]]);
    expect(reading.trigger?.lines).toEqual([
      { line: 0, text: "find a plumber for Saturday" },
      { line: 1, text: "Could you book a table?" },
    ]);
    expect(reading.trigger?.summary).toBe("2 lines in your note");
    await endOf(t, reading.turnId);
  });

  it("a line deleted before it settles is withdrawn and never gets a turn", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 300 } } });
    const path = await t.writeDailyNote(["Groceries", "find a plumber for Saturday"]);
    await nextActivity(t, (a) => a.phase === "noticed", "the line noticed");
    await t.writeDailyNote(["Groceries"]);
    const withdrawn = await nextActivity(t, (a) => a.phase === "idle", "the line withdrawn");
    expect(withdrawn).toMatchObject({
      phase: "idle",
      trigger: { kind: "note", notePath: path, lines: [] },
    });
    expect(withdrawn.turnId).toBeUndefined();
    await t.advance(500);
    expect(activities(t).some((a) => a.phase === "reading")).toBe(false);
    expect(t.runtime.status().orchestrator).toEqual({ phase: "idle" });
  });

  it("a task: the turn names its line, and ends with the subagent it started", async () => {
    const t = await fakeRuntime();
    const task = "Research standing desks under $500";
    const path = await t.writeDailyNote(["Today", `- [ ] ${task}`]);
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    expect(reading.trigger).toEqual({
      kind: "task",
      notePath: path,
      lines: [{ line: 1, text: task }],
      summary: `“${task}”`,
    });
    const end = await endOf(t, reading.turnId);
    expectTurnShape(
      turn(t, reading.turnId).map((a) => a.phase),
      { acts: true },
    );
    expect(end.outcome).toMatchObject({
      kind: "delegated",
      count: 1,
      threadId: t.record(task)!.threadId,
    });
    expect(activities(t).some((a) => a.phase === "noticed")).toBe(false);
  });

  it("a message in its chat: replied there", async () => {
    const t = await fakeRuntime();
    await t.writeToOrchestrator("What are you working on?");
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    expect(reading.trigger).toEqual({ kind: "message", summary: "your message" });
    const end = await endOf(t, reading.turnId);
    expect(end.outcome).toMatchObject({ kind: "replied", threadId: ORCHESTRATOR_THREAD_ID });
    expect(end.outcome?.text).toBeTruthy();
  });

  it("a routine run: triaged like a task, it starts a subagent", async () => {
    const t = await fakeRuntime();
    const routine = await t.runtime.createRoutine({
      name: "News digest",
      schedule: "every day at 18:00",
      instructions: "Summarize today's news about bikes, with links.",
    });
    const run = await t.runtime.runRoutine(routine.id);
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    expect(reading.trigger).toEqual({ kind: "routine", summary: "routine “News digest”" });
    const end = await endOf(t, reading.turnId);
    expect(end.outcome).toMatchObject({ kind: "delegated", count: 1, threadId: run.threadId });
  });

  it("shows the approval it waits for, then what it did once approved", async () => {
    const t = await fakeRuntime();
    const task = "Every morning at 7:30, brief me on the weather in SF and my calendar";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval();
    const waiting = await nextActivity(
      t,
      (a) => a.outcome?.kind === "asked_approval",
      "the approval shown",
    );
    expect(waiting).toMatchObject({
      phase: "acting",
      outcome: {
        kind: "asked_approval",
        threadId: ORCHESTRATOR_THREAD_ID,
        text: truncate(approval.summary, ORCHESTRATOR_ACTIVITY_LIMITS.outcomeTextChars),
      },
    });
    expect(waiting.outcome?.text?.length).toBeLessThanOrEqual(
      ORCHESTRATOR_ACTIVITY_LIMITS.outcomeTextChars,
    );
    expect(t.runtime.status().orchestrator).toMatchObject({
      phase: "acting",
      outcome: { kind: "asked_approval" },
    });
    await t.approveNext();
    const end = await endOf(t, waiting.turnId);
    expect(end.outcome).toEqual({
      kind: "routine_created",
      count: 1,
      text: "Routine “Morning briefing”",
    });
    expectAllGated(t);
  });

  it("keeps summaries and lines within bounds", async () => {
    const t = await fakeRuntime();
    const long = `Could you look into ${"a very long request ".repeat(40)}?`;
    const lines = Array.from({ length: 25 }, (_, i) => `${long} ${i}`);
    await t.writeDailyNote(lines);
    const reading = await nextActivity(t, (a) => a.phase === "reading", "the turn to start");
    for (const activity of [...activities(t)]) {
      const trigger = activity.trigger;
      if (!trigger) continue;
      expect(trigger.summary.length).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.summaryChars);
      expect(trigger.lines?.length ?? 0).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.lines);
      for (const line of trigger.lines ?? []) {
        expect(line.text.length).toBeLessThanOrEqual(ORCHESTRATOR_ACTIVITY_LIMITS.lineChars);
      }
    }
    expect(reading.trigger?.lines?.[0]?.line).toBe(0);
    await endOf(t, reading.turnId);
  });

  it("status says what it is doing for a client joining mid-turn; a stopped turn ends quietly", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "orchestrator" });
    await t.writeDailyNote(["- [ ] Renew passport"]);
    const thinking = await nextActivity(t, (a) => a.phase === "thinking", "the model to think");
    expect(t.runtime.status().orchestrator).toMatchObject({
      phase: "thinking",
      turnId: thinking.turnId,
      trigger: { kind: "task", summary: "“Renew passport”" },
    });
    await t.runtime.cancelThread(ORCHESTRATOR_THREAD_ID);
    const end = await endOf(t, thinking.turnId);
    expect(end.outcome).toBeUndefined();
  });
});
