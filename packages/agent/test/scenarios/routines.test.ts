/**
 * Routines through the whole runtime (ScriptedHarness, real evaluator, gate and broker): created
 * by saying it under each approval policy, a watch that only notifies when something changed, and
 * the orchestrator listing, running, pausing and resuming routines through the gate.
 */
import type { RoutineNotification } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

const BRIEFING = "Every morning at 7:30, brief me on the weather in SF and my calendar";
const WATCH =
  "Check the price of the blue kettle every 2 hours and tell me when it drops below $40";

function verdictsOf(t: FakeAgentRuntime, toolName: string) {
  return t.audit.gate.filter((g) => g.toolName === toolName).map((g) => g.verdict);
}

function notifications(t: FakeAgentRuntime): RoutineNotification[] {
  return t.events.flatMap((e) => (e.type === "routine.notification" ? [e.payload] : []));
}

describe("a routine created by saying it", () => {
  it("asks first under the default policy, then writes the routine's file", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${BRIEFING}`]);
    const approval = await t.waitForApproval();
    expect(approval.toolName).toBe("create_routine");
    expect(approval.summary).toMatch(
      /^Create routine “Morning briefing”: every day at 7:30 \(Every day at 7:30 AM\) — /,
    );
    expect(await t.storage.read("Routines/Morning briefing.md")).toBeNull();
    await t.approveNext();
    const done = await t.waitForStatus(BRIEFING, "done");
    expect(done.summary).toBe("Routine created");
    expect((await t.storage.read("Routines/Morning briefing.md"))?.content).toMatch(
      /^---\nschedule: every day at 7:30\nnotify: always\n/,
    );
    expect(t.runtime.listRoutines()).toEqual([
      expect.objectContaining({
        name: "Morning briefing",
        scheduleText: "Every day at 7:30 AM",
        paused: false,
        uses: expect.arrayContaining(["web"]),
      }),
    ]);
    expect(t.texts(BRIEFING).at(-1)).toContain("Routine “Morning briefing”");
    expect(t.events.some((e) => e.type === "routines.changed" && e.payload.length === 1)).toBe(
      true,
    );
    expectAllGated(t);
  });

  it("creates it without asking when the policy runs everything", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "run_everything" } } });
    await t.writeDailyNote([`- [ ] ${BRIEFING}`]);
    await t.waitForStatus(BRIEFING, "done");
    expect(t.runtime.listApprovals()).toEqual([]);
    expect(verdictsOf(t, "create_routine")).toEqual([
      expect.objectContaining({ decision: "allow", source: "policy" }),
    ]);
    expect(await t.storage.read("Routines/Morning briefing.md")).not.toBeNull();
  });

  it("never writes a routine the user declined", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "ask_every_action" } } });
    await t.writeDailyNote([`- [ ] ${BRIEFING}`]);
    await t.waitForApproval();
    await t.denyNext("Not now");
    await t.waitForStatus(BRIEFING, "ignored");
    expect(t.texts(BRIEFING).at(-1)).toContain("I won't set up that routine");
    expect(await t.storage.read("Routines/Morning briefing.md")).toBeNull();
    expect(t.runtime.listRoutines()).toEqual([]);
    expectAllGated(t);
  });
});

describe("a watch that only notifies on change", () => {
  it("tells the user only about the runs that found something new", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "run_everything" } } });
    await t.writeDailyNote([`- [ ] ${WATCH}`]);
    await t.waitForStatus(WATCH, "done");
    const [watch] = t.runtime.listRoutines();
    expect(watch).toMatchObject({
      name: "Price watch",
      schedule: "every 2 hours",
      notify: "when_changed",
    });

    let finding = { changed: false, summary: "Still $45: no change." };
    t.brain.when(
      (request, info) =>
        info.role === "subagent" &&
        request.messages.some(
          (m) => m.role === "user" && m.content.includes('Routine run: "Price watch"'),
        ),
      (_request, info) =>
        info.callsSinceUser.some((call) => call.name === "finish_task")
          ? { text: "" }
          : {
              toolCalls: [
                {
                  name: "finish_task",
                  arguments: {
                    status: "done",
                    summary: finding.summary,
                    shortSummary: finding.changed ? "Price dropped" : "No change",
                    changed: finding.changed,
                  },
                },
              ],
            },
      { name: "price watch run" },
    );
    const finished = (threadId: string) =>
      t.waitFor(() => {
        const last = t.runtime.getRoutine(watch!.id)?.lastRun;
        return last?.threadId === threadId && last.finishedAt !== undefined ? last : undefined;
      });

    const quiet = await t.runtime.runRoutine(watch!.id);
    expect(await finished(quiet.threadId)).toMatchObject({ status: "done", changed: false });
    expect(notifications(t)).toEqual([]);

    finding = { changed: true, summary: "Now $38 at the store: below your $40." };
    const news = await t.runtime.runRoutine(watch!.id);
    expect(await finished(news.threadId)).toMatchObject({ changed: true });
    await t.waitFor(() => notifications(t).length === 1);
    expect(notifications(t)).toEqual([
      expect.objectContaining({
        routineId: watch!.id,
        title: "Price watch",
        body: "Now $38 at the store: below your $40.",
        threadId: news.threadId,
        status: "done",
      }),
    ]);
    // Runs live under their routine, not in the task inbox.
    expect(
      t.runtime
        .listThreads({ routineId: watch!.id })
        .map((th) => th.id)
        .sort(),
    ).toEqual([quiet.threadId, news.threadId].sort());
    expect(t.records().some((r) => r.taskId.startsWith("run_"))).toBe(false);
    expect(t.runtime.getRoutine(watch!.id)?.extraRunsLeft).toBe(3);
    expectAllGated(t);
  });
});

describe("the orchestrator's routine tools", () => {
  it("lists, pauses, runs and resumes routines, asking only where the policy says", async () => {
    const t = await fakeRuntime();
    const digest = await t.runtime.createRoutine({
      name: "News digest",
      schedule: "every day at 18:00",
      instructions: "Summarize today's news about bikes, with links.",
      uses: ["web"],
    });
    /** The orchestrator answers `message` (written to it just now) with `calls`. */
    const say = async (message: string, calls: Array<{ name: string; arguments: unknown }>) => {
      t.brain.when(
        (_request, info) =>
          info.role === "orchestrator" && info.lastUserText.includes(`[direct] "${message}"`),
        (_request, info) =>
          info.callsSinceUser.length === 0 ? { toolCalls: calls } : { text: "Done." },
        { name: message },
      );
      await t.writeToOrchestrator(message);
    };

    await say("Please pause my news digest", [
      { name: "list_routines", arguments: {} },
      { name: "update_routine", arguments: { name: "News digest", paused: true } },
    ]);
    await t.waitFor(() => t.runtime.getRoutine(digest.id)?.paused);
    expect(verdictsOf(t, "list_routines")).toEqual([
      expect.objectContaining({ decision: "allow" }),
    ]);
    expect(verdictsOf(t, "update_routine")).toEqual([
      expect.objectContaining({ decision: "allow", risk: "low" }),
    ]);
    expect((await t.storage.read("Routines/News digest.md"))?.content).toContain("paused: true");

    await say("And run the news digest now", [
      { name: "run_routine", arguments: { name: "news digest" } },
    ]);
    await t.waitFor(() => t.runtime.listThreads({ routineId: digest.id }).length === 1);
    expect(verdictsOf(t, "run_routine")).toEqual([expect.objectContaining({ decision: "allow" })]);
    expect(t.runtime.listApprovals()).toEqual([]);

    await say("Actually, resume the news digest", [
      { name: "update_routine", arguments: { name: "News digest", paused: false } },
    ]);
    const approval = await t.waitForApproval();
    expect(approval).toMatchObject({
      toolName: "update_routine",
      summary: "Resume routine “News digest”",
    });
    expect(t.runtime.getRoutine(digest.id)?.paused).toBe(true);
    await t.approveNext();
    await t.waitFor(() => t.runtime.getRoutine(digest.id)?.paused === false);
    expectAllGated(t);
  });
});
