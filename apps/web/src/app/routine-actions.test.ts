import { ROUTINE_TEMPLATES } from "@ddl/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../api/client";
import { HttpError } from "../api/errors";
import { MockDaemonClient } from "../api/mock/mock-client";
import { routineFixture } from "../features/routines/testing";
import { initialAgentState } from "../state/agent-reducer";
import { useAgentStore } from "../state/agent-store";
import {
  applyRoutinesChanged,
  findRoutine,
  initialRoutinesState,
  updateRoutines,
  useRoutinesStore,
} from "../state/routines-store";
import { useToastStore } from "../state/toast-store";
import { RoutineActions } from "./routine-actions";

const REQUEST = {
  name: "Kettle watch",
  schedule: "every 2 hours",
  instructions: "Check the kettle's price.",
  notify: "when_changed" as const,
};

function setup(client: DaemonClient = new MockDaemonClient(options())) {
  const actions = new RoutineActions(client);
  const openNote = vi.fn(async () => true);
  actions.attach({ openNote });
  return { actions, client, openNote };
}

function options() {
  return { speed: 50, installHooks: false, persistSettings: false };
}

function routines() {
  return useRoutinesStore.getState();
}

beforeEach(() => {
  useRoutinesStore.setState(initialRoutinesState, true);
  useAgentStore.setState(initialAgentState, true);
  useToastStore.setState({ toasts: [] });
});

describe("RoutineActions", () => {
  it("loads the list and the templates once; events keep it current after that", async () => {
    const { actions, client } = setup();
    const list = vi.spyOn(client, "listRoutines");
    const loading = actions.ensureLoaded();
    expect(routines().status).toBe("loading");
    await loading;
    expect(routines()).toMatchObject({ status: "loaded", templatesLoaded: true, routines: [] });
    expect(routines().templates.map((t) => t.id)).toEqual(ROUTINE_TEMPLATES.map((t) => t.id));
    await actions.ensureLoaded();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("says why the list couldn't load, unless an event already brought it", async () => {
    const failing = {
      listRoutines: vi.fn(async () => {
        throw new HttpError(500, "The daemon broke");
      }),
    } as unknown as DaemonClient;
    const { actions } = setup(failing);
    await actions.load();
    expect(routines()).toMatchObject({ status: "error", error: "The daemon broke" });

    updateRoutines((s) => applyRoutinesChanged(s, [routineFixture()]));
    await actions.load();
    expect(routines()).toMatchObject({ status: "loaded", error: null });
    expect(routines().routines).toHaveLength(1);
  });

  it("creates a routine and adds it to the list", async () => {
    const { actions } = setup();
    const result = await actions.create(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routine).toMatchObject({
      name: "Kettle watch",
      path: "Routines/Kettle watch.md",
    });
    expect(findRoutine(routines(), result.routine.id)?.scheduleText).toBe("Every 2 hours");
  });

  it("returns where a failed create belongs: the name for 409, the schedule for 400", async () => {
    const { actions } = setup();
    await actions.create(REQUEST);
    expect(await actions.create(REQUEST)).toEqual({
      ok: false,
      problem: { field: "name", message: "A routine named “Kettle watch” already exists." },
    });
    const bad = await actions.create({ ...REQUEST, name: "Other", schedule: "whenever" });
    expect(bad).toMatchObject({ ok: false, problem: { field: "schedule" } });
  });

  it("runs a routine now and returns the run's thread", async () => {
    const { actions } = setup();
    const created = await actions.create(REQUEST);
    if (!created.ok) throw new Error("create failed");
    const run = await actions.runNow(created.routine);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(findRoutine(routines(), created.routine.id)?.lastRun).toMatchObject({
      threadId: run.threadId,
      trigger: "manual",
    });
  });

  it("explains a refused run: the agent is off (503), a run is going (409)", async () => {
    const { actions, client } = setup();
    const created = await actions.create(REQUEST);
    if (!created.ok) throw new Error("create failed");
    await actions.runNow(created.routine);
    expect(await actions.runNow(created.routine)).toEqual({
      ok: false,
      problem: { title: "It can't run right now", body: "“Kettle watch” is running right now." },
    });
    await client.setAgentEnabled(false);
    expect(await actions.runNow(created.routine)).toEqual({
      ok: false,
      problem: {
        title: "The agent can't run here",
        body: "The agent is paused: switch it on to run routines.",
      },
    });
  });

  it("fetches a routine's runs into the thread list", async () => {
    const { actions } = setup();
    const created = await actions.create(REQUEST);
    if (!created.ok) throw new Error("create failed");
    const run = await actions.runNow(created.routine);
    if (!run.ok) throw new Error("run failed");
    await actions.loadRuns(created.routine.id);
    expect(useAgentStore.getState().threads[run.threadId]).toMatchObject({
      routineId: created.routine.id,
      title: "Kettle watch",
    });
  });

  it("pauses at once, then takes the daemon's answer", async () => {
    const { actions } = setup();
    const created = await actions.create(REQUEST);
    if (!created.ok) throw new Error("create failed");
    expect(created.routine.nextRunAt).toBeDefined();
    const pausing = actions.setPaused(created.routine, true);
    expect(findRoutine(routines(), created.routine.id)).toMatchObject({ paused: true });
    expect(findRoutine(routines(), created.routine.id)?.nextRunAt).toBeUndefined();
    await pausing;
    expect(findRoutine(routines(), created.routine.id)?.paused).toBe(true);
    await actions.setPaused(created.routine, false);
    expect(findRoutine(routines(), created.routine.id)).toMatchObject({ paused: false });
    expect(findRoutine(routines(), created.routine.id)?.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("puts a routine back and says why when pausing fails", async () => {
    const routine = routineFixture();
    updateRoutines((s) => applyRoutinesChanged(s, [routine]));
    const failing = {
      pauseRoutine: vi.fn(async () => {
        throw new HttpError(404, "Routine not found");
      }),
    } as unknown as DaemonClient;
    const { actions } = setup(failing);
    await actions.setPaused(routine, true);
    expect(findRoutine(routines(), routine.id)).toEqual(routine);
    expect(useToastStore.getState().toasts).toMatchObject([
      { kind: "error", title: "Couldn't pause “Morning briefing”", body: "Routine not found" },
    ]);
  });

  it("opens the routine's file in the editor", async () => {
    const { actions, openNote } = setup();
    await actions.edit(routineFixture());
    expect(openNote).toHaveBeenCalledWith("Routines/Morning briefing.md", { focus: true });
  });

  it("resyncs only what was loaded: the list, and the runs it fetched", async () => {
    const { actions, client } = setup();
    const list = vi.spyOn(client, "listRoutines");
    const threads = vi.spyOn(client, "listThreads");
    await actions.resync();
    expect(list).not.toHaveBeenCalled();
    await actions.ensureLoaded();
    await actions.loadRuns("rtn_x");
    await actions.resync();
    expect(list).toHaveBeenCalledTimes(2);
    expect(threads).toHaveBeenLastCalledWith({ routineId: "rtn_x" });
  });
});
