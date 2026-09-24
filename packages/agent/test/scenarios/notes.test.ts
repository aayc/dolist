/**
 * The vault changing under the agent: tasks moved between daily notes, notes deleted or renamed
 * while work runs, edits made by another app (Obsidian), and the day rolling over at midnight.
 */
import { addDays, dailyNotePath, today } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

afterEach(() => {
  vi.useRealTimers();
});

describe("notes changing under the agent", () => {
  it("a task moved to tomorrow's note becomes new work there; today's copy is forgotten", async () => {
    const t = await fakeRuntime();
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`, "- [ ] Water the plants"]);
    const first = await t.waitForStatus(task, "done");
    // Removing the task while its report is queued would stall the orchestrator (reported-bugs).
    await t.waitFor(() => t.digests().some((d) => d.includes(`[report] ${first.taskId}`)), {
      what: "the report digest",
    });
    await t.writeDailyNote(["- [ ] Water the plants"]);
    const tomorrow = await t.writeDailyNote([`- [ ] ${task}`], { day: 1 });
    await t.waitFor(
      () =>
        t.records().some((r) => r.notePath === tomorrow && r.text === task && r.status === "done"),
      {
        what: "the moved task to be done on tomorrow's note",
      },
    );
    const moved = t.records().find((r) => r.notePath === tomorrow)!;
    expect(moved.taskId).not.toBe(first.taskId);
    expect(t.records().filter((r) => r.text === task)).toHaveLength(1);
    expect(t.digests().some((d) => d.includes(`## ${tomorrow} (tomorrow)`))).toBe(true);
    expect(t.kickoffs().at(-1)).toContain(`From the note: ${tomorrow} (tomorrow)`);
  });

  it("deleting the whole note while work waits for approval cancels it", async () => {
    const t = await fakeRuntime();
    const task = "Book a table for two on Friday";
    const path = await t.writeDailyNote([`- [ ] ${task}`]);
    const waiting = await t.waitForStatus(task, "waiting_approval");
    await t.storage.delete(path);
    await t.waitFor(() => t.record(task) === undefined, { what: "the record to go" });
    expect(t.runtime.listApprovals()[0]?.status).toBe("cancelled");
    expect(t.runtime.getThread(waiting.threadId!)?.thread.status).toBe("cancelled");
    await t.idle();
    expect(t.runtime.status()).toMatchObject({ running: 0, pendingApprovals: 0 });
  });

  it("renaming the note away from the daily folder while a subagent runs cancels the work", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "subagent" });
    const task = "Research ergonomic office chairs";
    const path = await t.writeDailyNote([`- [ ] ${task}`]);
    const working = await t.waitForStatus(task, "working");
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), { what: "the hang" });
    await t.storage.rename(path, "Archive/old-list.md");
    await t.waitFor(() => t.runtime.getThread(working.threadId!)?.thread.status === "cancelled", {
      what: "the work to be cancelled",
    });
    expect(t.runtime.status().running).toBe(0);
  });

  it("edits made by another app (Obsidian) are picked up like the app's own", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Research standing desks", "- [ ] Go to the gym"], {
      external: true,
    });
    await t.waitForStatus("Research standing desks", "done");
    await t.waitForStatus("Go to the gym", "ignored");
    await t.writeDailyNote(
      [
        "- [ ] Research standing desks",
        "- [ ] Go to the gym",
        "- [ ] What's the capital of Kenya?",
      ],
      {
        external: true,
      },
    );
    const answered = await t.waitForStatus("What's the capital of Kenya?", "done");
    expect(answered.summary).toBe("Nairobi");
    expectAllGated(t);
  });

  it("a note that exists before the agent starts is triaged with actOnExistingTasks", async () => {
    const t = await fakeRuntime({ start: false });
    await t.writeDailyNote(["- [ ] Research standing desks", "- [x] Already done", "- [ ] "]);
    await t.runtime.start();
    await t.waitForStatus("Research standing desks", "done");
    expect(t.records().map((r) => r.text)).toEqual(["Research standing desks"]);
  });

  it("ignores existing tasks when actOnExistingTasks is off, but acts on new ones", async () => {
    const t = await fakeRuntime({
      start: false,
      settings: { agent: { actOnExistingTasks: false } },
    });
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await t.runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.records()).toEqual([]);
    await t.writeDailyNote(["- [ ] Research standing desks", "- [ ] Research monitor arms"]);
    await t.waitForStatus("Research monitor arms", "done");
    expect(t.record("Research standing desks")).toBeUndefined();
  });

  it("notes outside the watch window are left alone", async () => {
    const t = await fakeRuntime({ settings: { agent: { watch: { pastDays: 0, futureDays: 1 } } } });
    await t.writeDailyNote(["- [ ] Research standing desks"], { day: 3 });
    await t.writeDailyNote(["- [ ] Research monitor arms"], { day: -1 });
    await t.writeDailyNote(["- [ ] Research desk lamps"], { day: 1 });
    await t.waitForStatus("Research desk lamps", "done");
    expect(t.record("Research standing desks")).toBeUndefined();
    expect(t.record("Research monitor arms")).toBeUndefined();
  });

  it("at midnight tomorrow's note becomes today's and its tasks are triaged (fake timers)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const beforeMidnight = new Date();
    beforeMidnight.setHours(23, 59, 59, 0);
    vi.setSystemTime(beforeMidnight);
    const t = await fakeRuntime({ settings: { agent: { watch: { pastDays: 0, futureDays: 0 } } } });
    const tomorrow = dailyNotePath(addDays(today(beforeMidnight), 1), t.settings.dailyNotes);
    await t.writeDailyNote(["- [ ] Research the offsite venue"], { day: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(t.records()).toEqual([]);

    await vi.advanceTimersByTimeAsync(3_000);
    await t.waitFor(() => t.runtime.getTaskRecords(tomorrow).find((r) => r.status === "done"), {
      what: "the task to be done after midnight",
    });
    expect(t.digests().find((d) => d.includes("[added]"))).toContain(`## ${tomorrow} (today)`);
  });
});
