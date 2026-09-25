import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoutineConflictError, RoutineInputError, UnknownRoutineError } from "./files";
import { EXTRA_RUNS_PER_DAY } from "./library";
import { isRoutineRunId, MAX_ROUTINE_RUN_MS, shouldNotify } from "./scheduler";
import { MINUTE, routineFile, type SchedulerHarness, schedulerHarness, sept } from "./test-helpers";

const harnesses: SchedulerHarness[] = [];

async function harness(...args: Parameters<typeof schedulerHarness>): Promise<SchedulerHarness> {
  const h = await schedulerHarness(...args);
  harnesses.push(h);
  return h;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const h of harnesses.splice(0)) h.stop();
  vi.useRealTimers();
});

/** Real time passing: the clock moves a minute at a time and the scheduler's timer fires. */
function pass(h: SchedulerHarness, until: number): void {
  while (h.clock.now < until) {
    const step = Math.min(MINUTE, until - h.clock.now);
    h.clock.now += step;
    vi.advanceTimersByTime(step);
  }
}

const WATCH = routineFile({ schedule: "every hour", uses: "[web]" });

describe("scheduling", () => {
  it("plans a routine's next run when it first sees it and starts it when it's due", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Price watch",
      routineFile({ schedule: "every day at 11:00", uses: "[web]" }),
    );
    h.scheduler.activate({ catchUp: true });
    expect(h.state("Price watch")).toMatchObject({
      scheduleKey: "every day at 11:00",
      nextRunAt: sept(23, 11),
    });
    expect(h.library.get(id)?.nextRunAt).toBe(sept(23, 11));

    pass(h, sept(23, 10, 59));
    expect(h.runs("Price watch")).toEqual([]);
    pass(h, sept(23, 11, 1));
    const [run] = h.runs("Price watch");
    expect(run).toMatchObject({
      routineId: id,
      title: "Price watch",
      notePath: "Routines/Price watch.md",
    });
    expect(isRoutineRunId(run!.taskId)).toBe(true);
    expect(h.subagents.spawned).toEqual([
      { taskId: run!.taskId, goal: "Run the routine “Price watch”", capabilities: ["web"] },
    ]);
    expect(run!.messages).toContainEqual(
      expect.objectContaining({ kind: "status", text: "Scheduled run · Every day at 11:00 AM" }),
    );
    expect(h.state("Price watch")).toMatchObject({
      nextRunAt: sept(24, 11),
      lastRun: {
        runId: run!.taskId,
        threadId: run!.id,
        trigger: "schedule",
        startedAt: sept(23, 11),
      },
      runs: [run!.id],
    });
    expect(h.library.get(id)?.lastRun).toMatchObject({ status: "working", trigger: "schedule" });
  });

  it("catches up a missed run once after the Mac sleeps, however many slots went by", async () => {
    const h = await harness();
    await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });
    expect(h.state("Kettle")?.nextRunAt).toBe(sept(23, 11));

    // Asleep from 10:00 to 17:30: six hourly slots missed, one timer fires late on waking.
    h.clock.now = sept(23, 17, 30);
    vi.advanceTimersByTime(MINUTE);
    const [run] = h.runs("Kettle");
    expect(h.runs("Kettle")).toHaveLength(1);
    expect(h.state("Kettle")).toMatchObject({
      nextRunAt: sept(23, 18),
      lastRun: { trigger: "catch_up" },
    });
    expect(run!.messages).toContainEqual(
      expect.objectContaining({
        text: "Catch-up run · missed at 11:00 AM while the agent wasn't running",
      }),
    );
    h.finish(h.runOf(run!.id));
    pass(h, sept(23, 17, 59));
    expect(h.runs("Kettle")).toHaveLength(1);
    pass(h, sept(23, 18, 1));
    expect(h.runs("Kettle")).toHaveLength(2);
    expect(h.state("Kettle")?.lastRun?.trigger).toBe("schedule");
  });

  it("catches up once after a restart, from the state the last run saved", async () => {
    const storage = new MemoryStorageProvider();
    const before = await harness({ storage });
    await before.write("Kettle", WATCH);
    before.scheduler.activate({ catchUp: true });
    await before.library.state.flush();
    before.stop();

    const after = await harness({ storage, now: sept(23, 14, 30) });
    after.scheduler.reconcileAfterRestart();
    after.scheduler.activate({ catchUp: true });
    expect(after.runs("Kettle")).toHaveLength(1);
    expect(after.state("Kettle")).toMatchObject({
      nextRunAt: sept(23, 15),
      lastRun: { trigger: "catch_up" },
    });
  });

  it("fails runs a restart interrupted before they started", async () => {
    const storage = new MemoryStorageProvider();
    const before = await harness({ storage });
    const { id } = await before.write("Digest", routineFile({ schedule: "every day at 18:00" }));
    before.scheduler.activate({ catchUp: true });
    const { threadId } = before.scheduler.runNow(id);
    const runId = before.runOf(threadId);
    expect(before.records.get(runId)?.status).toBe("triaging");
    await Promise.all([
      before.library.state.flush(),
      before.records.flush(),
      before.threads.flush(),
    ]);
    before.stop();

    const after = await harness({ storage, now: sept(23, 10, 5) });
    after.scheduler.reconcileAfterRestart();
    expect(after.records.get(runId)).toMatchObject({ status: "failed", summary: "Interrupted" });
    expect(after.state("Digest")?.lastRun).toMatchObject({ runId, status: "failed" });
    expect(after.notifications).toEqual([
      expect.objectContaining({ routineId: id, threadId, status: "failed" }),
    ]);
  });

  it("starts from the next slot, without catching up, when the agent is switched back on", async () => {
    const h = await harness();
    await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });
    h.scheduler.deactivate();
    h.clock.now = sept(23, 13, 30);
    h.scheduler.activate({ catchUp: false });
    expect(h.runs("Kettle")).toEqual([]);
    expect(h.state("Kettle")?.nextRunAt).toBe(sept(23, 14));
    pass(h, sept(23, 14, 1));
    expect(h.runs("Kettle")).toHaveLength(1);
    expect(h.state("Kettle")?.lastRun?.trigger).toBe("schedule");
  });

  it("does nothing while inactive, and never again once stopped", async () => {
    const h = await harness();
    await h.write("Kettle", WATCH);
    h.at(sept(23, 12));
    expect(h.scheduler.isActive).toBe(false);
    expect(h.state("Kettle")).toBeUndefined();

    h.scheduler.activate({ catchUp: true });
    expect(h.state("Kettle")?.nextRunAt).toBe(sept(23, 13));
    h.scheduler.deactivate();
    pass(h, sept(23, 15));
    h.at(sept(23, 15, 30));
    expect(h.runs("Kettle")).toEqual([]);

    h.scheduler.stop();
    h.scheduler.activate({ catchUp: true });
    expect(h.scheduler.isActive).toBe(false);
    h.at(sept(23, 18));
    expect(h.runs("Kettle")).toEqual([]);
  });

  it("follows edits of a routine's schedule", async () => {
    const h = await harness();
    await h.write("Kettle", routineFile({ schedule: "every day at 11:00", uses: "[web]" }));
    h.scheduler.activate({ catchUp: true });
    await h.write("Kettle", routineFile({ schedule: "every day at 15:30", uses: "[web]" }));
    h.scheduler.tick();
    expect(h.state("Kettle")).toMatchObject({
      scheduleKey: "every day at 15:30",
      nextRunAt: sept(23, 15, 30),
    });
    pass(h, sept(23, 12));
    expect(h.runs("Kettle")).toEqual([]);
  });

  it("never schedules a routine whose file has a problem", async () => {
    const h = await harness();
    const { id } = await h.write("Broken", routineFile({ schedule: "whenever I feel like it" }));
    h.scheduler.activate({ catchUp: true });
    pass(h, sept(23, 12));
    expect(h.runs("Broken")).toEqual([]);
    expect(h.library.get(id)).toMatchObject({ error: expect.any(String) });
    expect(h.library.get(id)?.nextRunAt).toBeUndefined();
    expect(() => h.scheduler.runNow(id)).toThrow(RoutineInputError);
  });

  it("skips a slot while the previous run is still going", async () => {
    const h = await harness();
    await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });
    pass(h, sept(23, 11, 1));
    const [first] = h.runs("Kettle");
    pass(h, sept(23, 12, 1));
    expect(h.runs("Kettle")).toHaveLength(1);
    expect(h.state("Kettle")?.nextRunAt).toBe(sept(23, 13));
    h.finish(h.runOf(first!.id));
    pass(h, sept(23, 13, 1));
    expect(h.runs("Kettle")).toHaveLength(2);
  });
});

describe("pause and resume", () => {
  it("a paused routine never runs; resumed, it starts again from its next slot", async () => {
    const h = await harness();
    const { id } = await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });

    const paused = await h.library.setPaused(id, true);
    h.scheduler.tick();
    expect(paused.paused).toBe(true);
    expect((await h.storage.read("Routines/Kettle.md"))?.content).toContain("paused: true");
    expect(h.state("Kettle")).toMatchObject({ scheduleKey: null, nextRunAt: null });
    expect(h.library.get(id)?.nextRunAt).toBeUndefined();
    pass(h, sept(23, 12, 30));
    expect(h.runs("Kettle")).toEqual([]);

    await h.library.setPaused(id, false);
    h.scheduler.tick();
    expect(h.runs("Kettle")).toEqual([]);
    expect(h.state("Kettle")?.nextRunAt).toBe(sept(23, 13));
    pass(h, sept(23, 13, 1));
    expect(h.runs("Kettle")).toHaveLength(1);
  });
});

describe("run now", () => {
  it("allows EXTRA_RUNS_PER_DAY a day, one at a time; scheduled runs don't count", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Briefing",
      routineFile({ schedule: "every day at 7:30", uses: "[web]" }),
    );
    h.scheduler.activate({ catchUp: true });
    expect(h.library.get(id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY);
    for (let i = 1; i <= EXTRA_RUNS_PER_DAY; i++) {
      const { routineId, threadId } = h.scheduler.runNow(i === 1 ? "briefing" : id);
      expect(routineId).toBe(id);
      expect(() => h.scheduler.runNow(id)).toThrow(RoutineConflictError);
      expect(() => h.scheduler.runNow(id)).toThrow("“Briefing” is running right now.");
      h.finish(h.runOf(threadId));
      expect(h.library.get(id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY - i);
      h.clock.now += MINUTE;
    }
    expect(() => h.scheduler.runNow(id)).toThrow(RoutineConflictError);
    expect(() => h.scheduler.runNow(id)).toThrow(/most extra times allowed today/);
    expect(h.state("Briefing")?.lastRun?.trigger).toBe("manual");

    // Tomorrow's scheduled run still happens, and the budget starts over.
    pass(h, sept(24, 7, 31));
    const scheduled = h.runs("Briefing")[0]!;
    expect(h.state("Briefing")?.lastRun).toMatchObject({
      threadId: scheduled.id,
      trigger: "schedule",
    });
    h.finish(h.runOf(scheduled.id));
    expect(h.library.get(id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY);
    h.scheduler.runNow(id);
    expect(h.library.get(id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY - 1);
    expect(h.runs("Briefing")).toHaveLength(EXTRA_RUNS_PER_DAY + 2);
  });

  it("refuses unknown routines", async () => {
    const h = await harness();
    h.scheduler.activate({ catchUp: true });
    expect(() => h.scheduler.runNow("Nope")).toThrow(UnknownRoutineError);
  });

  it("hands a routine without uses to the orchestrator to triage", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Digest",
      routineFile({ schedule: "every day at 18:00" }, "Summarize today's news about bikes."),
    );
    const { threadId } = h.scheduler.runNow(id);
    const runId = h.runOf(threadId);
    expect(h.triaged).toEqual([
      {
        taskId: runId,
        name: "Digest",
        scheduleText: "Every day at 6:00 PM",
        instructions: "Summarize today's news about bikes.",
      },
    ]);
    expect(h.subagents.spawned).toEqual([]);
    expect(h.records.get(runId)?.status).toBe("triaging");
  });

  it("fails at once when none of the routine's capabilities is available here", async () => {
    const h = await harness({ capabilities: ["web"] });
    const { id } = await h.write(
      "Screens",
      routineFile({ schedule: "every hour", uses: "[browser]" }),
    );
    const { threadId } = h.scheduler.runNow(id);
    const runId = h.runOf(threadId);
    expect(h.records.get(runId)).toMatchObject({ status: "failed", summary: "Can't run here" });
    expect(h.subagents.spawned).toEqual([]);
    expect(h.state("Screens")?.lastRun).toMatchObject({ status: "failed" });
    expect(h.notifications).toEqual([
      expect.objectContaining({ routineId: id, status: "failed", body: "Failed: Can't run here" }),
    ]);
  });
});

describe("time limit", () => {
  it("stops a run over its working time; time waiting for approval doesn't count", async () => {
    const h = await harness();
    const { id } = await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });
    const { threadId } = h.scheduler.runNow(id);
    const runId = h.runOf(threadId);

    pass(h, sept(23, 10, 9));
    h.board.setStatus(runId, "waiting_approval");
    pass(h, sept(23, 10, 45));
    h.board.setStatus(runId, "working");
    // 9 minutes before the approval and 5 after: still under the limit.
    pass(h, sept(23, 10, 50));
    expect(h.subagents.cancelled).toEqual([]);

    pass(h, sept(23, 10, 45) + MAX_ROUTINE_RUN_MS - 9 * MINUTE + MINUTE);
    const note = "Stopped: this run went over the 15-minute limit for a routine's run.";
    expect(h.subagents.cancelled).toEqual([{ taskId: runId, reason: note }]);
    expect(h.dropped).toEqual([runId]);
    await vi.waitFor(() => expect(h.records.get(runId)?.status).toBe("failed"));
    expect(h.records.get(runId)?.summary).toBe("Took too long");
    expect(h.state("Kettle")?.lastRun).toMatchObject({
      status: "failed",
      summary: "Took too long",
    });
    expect(h.notifications).toEqual([
      expect.objectContaining({ status: "failed", body: "Failed: Took too long" }),
    ]);
    // The routine can run again right away.
    expect(() => h.scheduler.runNow(id)).not.toThrow();
  });

  it("honors a shorter limit", async () => {
    const h = await harness({ maxRunMs: 5 * MINUTE });
    const { id } = await h.write("Kettle", WATCH);
    h.scheduler.activate({ catchUp: true });
    h.scheduler.runNow(id);
    pass(h, sept(23, 10, 5));
    expect(h.subagents.cancelled).toEqual([]);
    pass(h, sept(23, 10, 6));
    expect(h.subagents.cancelled).toHaveLength(1);
    expect(h.subagents.cancelled[0]!.reason).toContain("5-minute limit");
  });
});

describe("run threads", () => {
  it("each run is a thread; the next one is told what the previous one found", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Briefing",
      routineFile(
        { schedule: "every day at 7:30", uses: "[web]" },
        "Brief me: calendar and weather.",
      ),
    );
    h.scheduler.activate({ catchUp: true });
    const first = h.scheduler.runNow(id);
    const firstRun = h.runOf(first.threadId);
    expect(h.scheduler.brief(firstRun)).toEqual({
      routineId: id,
      name: "Briefing",
      scheduleText: "Every day at 7:30 AM",
      trigger: "manual",
      startedAt: sept(23, 10),
      instructions: "Brief me: calendar and weather.",
      notify: "always",
    });
    h.clock.now = sept(23, 10, 2);
    h.finish(firstRun, { text: "3 meetings; 68°F and sunny.", summary: "3 meetings · sunny" });
    expect(h.state("Briefing")?.lastRun).toMatchObject({
      runId: firstRun,
      status: "done",
      finishedAt: sept(23, 10, 2),
      summary: "3 meetings · sunny",
      result: "3 meetings; 68°F and sunny.",
      notified: true,
    });

    h.clock.now = sept(23, 11);
    const second = h.scheduler.runNow(id);
    const secondRun = h.runOf(second.threadId);
    expect(h.scheduler.brief(secondRun)?.previous).toEqual({
      startedAt: sept(23, 10),
      status: "done",
      result: "3 meetings; 68°F and sunny.",
    });
    expect(h.state("Briefing")?.runs).toEqual([second.threadId, first.threadId]);
    expect(h.library.get(id)).toMatchObject({
      runCount: 2,
      lastRun: { threadId: second.threadId },
    });
    expect(h.runs("Briefing").map((t) => t.id)).toEqual([second.threadId, first.threadId]);
  });

  it("a run's thread gets the routine's name when the routine is gone", async () => {
    const h = await harness();
    const { id } = await h.write("Kettle", WATCH);
    const { threadId } = h.scheduler.runNow(id);
    const runId = h.runOf(threadId);
    await h.storage.delete("Routines/Kettle.md");
    await h.library.catalog.reload("Routines/Kettle.md");
    expect(h.scheduler.brief(runId)).toMatchObject({ routineId: id, name: "Kettle" });
  });
});

describe("notifications", () => {
  it.each([
    ["always", "done", undefined, true],
    ["always", "done", false, true],
    ["when_changed", "done", true, true],
    ["when_changed", "done", false, false],
    ["when_changed", "done", undefined, true],
    ["when_changed", "failed", false, true],
    ["when_changed", "waiting_user", false, true],
    ["never", "failed", true, false],
    ["never", "done", true, false],
    ["always", "cancelled", undefined, false],
  ] as const)("notify %s, run %s, changed %s → %s", (notify, status, changed, expected) => {
    expect(shouldNotify(notify, { status, ...(changed !== undefined ? { changed } : {}) })).toBe(
      expected,
    );
  });

  it("notify: when changed tells the user only about runs that found something new", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Kettle",
      routineFile({ schedule: "every hour", uses: "[web]", notify: "when changed" }),
    );
    const run = (finish: Parameters<SchedulerHarness["finish"]>[1]) => {
      const { threadId } = h.scheduler.runNow(id);
      h.finish(h.runOf(threadId), finish);
      h.clock.now += MINUTE;
      return threadId;
    };
    const dropped = run({ text: "Now $39 (was $45).", changed: true });
    run({ text: "Still $39.", changed: false });
    expect(h.notifications).toEqual([
      {
        routineId: id,
        title: "Kettle",
        body: "Now $39 (was $45).",
        threadId: dropped,
        status: "done",
        at: sept(23, 10),
      },
    ]);
    expect(h.state("Kettle")?.lastRun).toMatchObject({ changed: false, notified: true });
    const failed = run({ status: "failed", summary: "Site down" });
    expect(h.notifications.at(-1)).toMatchObject({
      threadId: failed,
      status: "failed",
      body: "Failed: Site down",
    });
    expect(h.notifications).toHaveLength(2);
  });

  it("notifies once per run, however many turns it ends", async () => {
    const h = await harness();
    const { id } = await h.write("Kettle", WATCH);
    const { threadId } = h.scheduler.runNow(id);
    const runId = h.runOf(threadId);
    h.finish(runId, { text: "Now $39." });
    // The user replies in the run's thread; its second turn ends too.
    h.finish(runId, { text: "Checked again: still $39." });
    expect(h.notifications).toHaveLength(1);
  });

  it("notify: never stays quiet, even about failures", async () => {
    const h = await harness();
    const { id } = await h.write(
      "Kettle",
      routineFile({ schedule: "every hour", uses: "[web]", notify: "never" }),
    );
    const { threadId } = h.scheduler.runNow(id);
    h.finish(h.runOf(threadId), { status: "failed", summary: "Site down" });
    expect(h.notifications).toEqual([]);
    expect(h.state("Kettle")?.lastRun?.status).toBe("failed");
  });
});
