import { encodePersistedRoutines } from "@ddl/contract";
import { routineIdForPath } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutineConflictError, RoutineInputError, UnknownRoutineError } from "./files";
import { EXTRA_RUNS_PER_DAY, RoutineLibrary } from "./library";
import { ROUTINES_STATE_PATH } from "./state";
import { LA, routineFile, sept } from "./test-helpers";

const libraries: RoutineLibrary[] = [];

async function library(
  storage = new MemoryStorageProvider(),
  options: { now?: () => number; readOnly?: boolean } = {},
): Promise<RoutineLibrary> {
  const created = new RoutineLibrary({
    storage,
    calendar: LA,
    now: options.now ?? (() => sept(23, 10)),
    ...(options.readOnly ? { readOnly: true } : {}),
  });
  libraries.push(created);
  await created.start();
  return created;
}

afterEach(() => {
  for (const created of libraries.splice(0)) created.stop();
});

const BRIEFING = {
  name: "Morning briefing",
  schedule: "every weekday at 7:30",
  instructions: "Brief me for the day: calendar, weather, leftovers.",
};

describe("RoutineLibrary", () => {
  it("creates a routine as a plain markdown file", async () => {
    const storage = new MemoryStorageProvider();
    const routines = await library(storage);
    const routine = await routines.create({ ...BRIEFING, notify: "when_changed", uses: ["web"] });
    expect(await storage.read("Routines/Morning briefing.md")).toMatchObject({
      content:
        "---\nschedule: every weekday at 7:30\nnotify: when changed\nuses: [web]\n---\nBrief me for the day: calendar, weather, leftovers.\n",
    });
    expect(routine).toEqual({
      id: routineIdForPath("Routines/Morning briefing.md"),
      path: "Routines/Morning briefing.md",
      name: "Morning briefing",
      schedule: "every weekday at 7:30",
      scheduleText: "Every weekday at 7:30 AM",
      notify: "when_changed",
      uses: ["web"],
      paused: false,
      instructions: "Brief me for the day: calendar, weather, leftovers.",
      nextRunAt: sept(24, 7, 30),
      runCount: 0,
      extraRunsLeft: EXTRA_RUNS_PER_DAY,
    });
  });

  it("refuses what it can't write as asked, and writes nothing", async () => {
    const storage = new MemoryStorageProvider();
    const routines = await library(storage);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ schedule: "when the mood strikes" }, /schedule|understand|read/i],
      [{ schedule: "every 5 minutes" }, /15/],
      [{ instructions: "   " }, /what the routine should do/],
      [{ name: "a/b" }, /can't contain/],
      [{ name: ".hidden" }, /dot/],
      [{ name: " padded " }, /name/],
    ];
    for (const [patch, message] of cases) {
      const attempt = routines.create({ ...BRIEFING, ...patch } as typeof BRIEFING);
      await expect(attempt, JSON.stringify(patch)).rejects.toThrow(RoutineInputError);
      await expect(routines.create({ ...BRIEFING, ...patch } as typeof BRIEFING)).rejects.toThrow(
        message,
      );
    }
    expect(await storage.list({ prefix: "Routines" })).toEqual([]);
  });

  it("never overwrites an existing routine", async () => {
    const storage = new MemoryStorageProvider();
    const routines = await library(storage);
    await routines.create(BRIEFING);
    await expect(
      routines.create({ ...BRIEFING, instructions: "Something else entirely." }),
    ).rejects.toThrow(RoutineConflictError);
    expect((await storage.read("Routines/Morning briefing.md"))?.content).toContain(
      BRIEFING.instructions,
    );
  });

  it("pauses and resumes by changing only that line of the file", async () => {
    const storage = new MemoryStorageProvider();
    const written = [
      "---",
      "# my weekday briefing",
      "schedule: every weekday at 7:30",
      "tags: [daily]",
      "---",
      "Brief me.",
      "",
    ].join("\n");
    await storage.write("Routines/Briefing.md", written);
    const routines = await library(storage);
    const id = routineIdForPath("Routines/Briefing.md");
    expect(routines.get(id)?.nextRunAt).toBe(sept(24, 7, 30));

    const paused = await routines.setPaused(id, true);
    expect(paused).toMatchObject({ paused: true });
    expect(paused.nextRunAt).toBeUndefined();
    expect((await storage.read("Routines/Briefing.md"))?.content).toBe(
      written.replace("tags: [daily]\n", "tags: [daily]\npaused: true\n"),
    );
    const resumed = await routines.setPaused(id, false);
    expect(resumed).toMatchObject({ paused: false, nextRunAt: sept(24, 7, 30) });
    expect((await storage.read("Routines/Briefing.md"))?.content).toContain("paused: false");
    await expect(routines.setPaused("rtn_missing", true)).rejects.toThrow(UnknownRoutineError);
  });

  it("reports a routine that can't run with its first problem and no next run", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Routines/Broken.md", routineFile({ schedule: "at some point" }));
    const routines = await library(storage);
    const [broken] = routines.list();
    expect(broken).toMatchObject({ name: "Broken", schedule: "at some point" });
    expect(broken!.error).toEqual(expect.any(String));
    expect(broken!.scheduleText).toBeUndefined();
    expect(broken!.nextRunAt).toBeUndefined();
  });

  it("counts today's extra runs only", async () => {
    const storage = new MemoryStorageProvider();
    const clock = { now: sept(23, 10) };
    const routines = await library(storage, { now: () => clock.now });
    const routine = await routines.create(BRIEFING);
    routines.state.update(routine.id, routine.path, () => ({
      extraRuns: { date: routines.todayISO(), count: 2 },
    }));
    expect(routines.get(routine.id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY - 2);
    clock.now = sept(24, 10);
    expect(routines.get(routine.id)?.extraRunsLeft).toBe(EXTRA_RUNS_PER_DAY);
  });

  it("tells listeners once per burst of changes", async () => {
    const routines = await library();
    const listener = vi.fn();
    routines.on(listener);
    routines.changed();
    routines.changed();
    await routines.create(BRIEFING);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    const calls = listener.mock.calls.length;
    await Promise.resolve();
    expect(listener.mock.calls.length).toBe(calls);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("read-only (the agent runs elsewhere): follows the state file and never writes it", async () => {
    const storage = new MemoryStorageProvider();
    const routines = await library(storage, { readOnly: true });
    const routine = await routines.create(BRIEFING);
    routines.state.update(routine.id, routine.path, () => ({ nextRunAt: sept(24, 7, 30) }));
    await routines.state.flush();
    expect(await storage.read(ROUTINES_STATE_PATH)).toBeNull();

    // The device running the agent saves a finished run; sync brings the file here.
    storage.simulateExternalChange(
      ROUTINES_STATE_PATH,
      encodePersistedRoutines({
        routines: {
          [routine.id]: {
            path: routine.path,
            scheduleKey: routine.schedule,
            nextRunAt: sept(24, 7, 30),
            lastRun: {
              runId: "run_1",
              threadId: "thr_1",
              trigger: "schedule",
              status: "done",
              startedAt: sept(23, 7, 30),
              finishedAt: sept(23, 7, 31),
              summary: "3 meetings · sunny",
              notified: true,
            },
            runs: ["thr_1"],
            updatedAt: sept(23, 10, 1),
          },
        },
      }),
    );
    await vi.waitFor(() =>
      expect(routines.get(routine.id)?.lastRun).toEqual({
        threadId: "thr_1",
        trigger: "schedule",
        status: "done",
        startedAt: sept(23, 7, 30),
        finishedAt: sept(23, 7, 31),
        summary: "3 meetings · sunny",
      }),
    );
    expect(routines.get(routine.id)?.runCount).toBe(1);
  });
});
