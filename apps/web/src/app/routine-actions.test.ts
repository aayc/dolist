import { ROUTINE_TEMPLATES, type Routine, type ThreadSummary } from "@ddl/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../api/client";
import { HttpError } from "../api/errors";
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

/** What the daemon answers (its own behavior is covered by e2e/routines.spec.ts). */
function stubClient(overrides: Partial<DaemonClient> = {}): DaemonClient {
  return {
    listRoutines: vi.fn(async () => ({ routines: [], templates: ROUTINE_TEMPLATES })),
    listThreads: vi.fn(async () => ({ threads: [] })),
    ...overrides,
  } as unknown as DaemonClient;
}

function setup(client: DaemonClient = stubClient()) {
  const actions = new RoutineActions(client);
  const openNote = vi.fn(async () => true);
  actions.attach({ openNote });
  return { actions, client, openNote };
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
    const loading = actions.ensureLoaded();
    expect(routines().status).toBe("loading");
    await loading;
    expect(routines()).toMatchObject({ status: "loaded", templatesLoaded: true, routines: [] });
    expect(routines().templates.map((t) => t.id)).toEqual(ROUTINE_TEMPLATES.map((t) => t.id));
    await actions.ensureLoaded();
    expect(client.listRoutines).toHaveBeenCalledTimes(1);
  });

  it("says why the list couldn't load, unless an event already brought it", async () => {
    const failing = stubClient({
      listRoutines: vi.fn(async () => {
        throw new HttpError(500, "The daemon broke");
      }),
    });
    const { actions } = setup(failing);
    await actions.load();
    expect(routines()).toMatchObject({ status: "error", error: "The daemon broke" });

    updateRoutines((s) => applyRoutinesChanged(s, [routineFixture()]));
    await actions.load();
    expect(routines()).toMatchObject({ status: "loaded", error: null });
    expect(routines().routines).toHaveLength(1);
  });

  it("adds a created routine to the list, and keeps the daemon's error for a refused one", async () => {
    const routine = routineFixture({ name: "Kettle watch" });
    const taken = new HttpError(409, "A routine named “Kettle watch” already exists.");
    const createRoutine = vi.fn().mockResolvedValueOnce({ routine }).mockRejectedValueOnce(taken);
    const { actions } = setup(stubClient({ createRoutine }));
    const request = { name: "Kettle watch", schedule: "every 2 hours", instructions: "Check." };
    expect(await actions.create(request)).toEqual({ ok: true, routine });
    expect(findRoutine(routines(), routine.id)).toEqual(routine);
    expect(await actions.create(request)).toEqual({ ok: false, error: taken });
    expect(routines().routines).toEqual([routine]);
  });

  it("runs a routine now and returns the run's thread, or explains a refusal", async () => {
    const lastRun = { threadId: "thr_run", trigger: "manual", status: "working", startedAt: 1 };
    const routine = routineFixture({ lastRun } as Partial<Routine>);
    const paused = new HttpError(503, "The agent is paused: switch it on to run routines.", {
      error: "agent_unavailable",
      message: "The agent is paused: switch it on to run routines.",
    });
    const runRoutine = vi
      .fn()
      .mockResolvedValueOnce({ routine, threadId: "thr_run" })
      .mockRejectedValueOnce(paused);
    const { actions } = setup(stubClient({ runRoutine }));
    expect(await actions.runNow(routine)).toEqual({ ok: true, threadId: "thr_run" });
    expect(findRoutine(routines(), routine.id)?.lastRun).toEqual(lastRun);
    expect(await actions.runNow(routine)).toEqual({
      ok: false,
      problem: {
        title: "The agent can't run here",
        body: "The agent is paused: switch it on to run routines.",
      },
    });
  });

  it("fetches a routine's runs into the thread list", async () => {
    const run = { id: "thr_run", routineId: "rtn_1", title: "Morning briefing" } as ThreadSummary;
    const { actions } = setup(stubClient({ listThreads: vi.fn(async () => ({ threads: [run] })) }));
    await actions.loadRuns("rtn_1");
    expect(useAgentStore.getState().threads.thr_run).toMatchObject({ routineId: "rtn_1" });
  });

  it("pauses at once, then takes the daemon's answer", async () => {
    const routine = routineFixture({ nextRunAt: Date.now() + 60_000 });
    updateRoutines((s) => applyRoutinesChanged(s, [routine]));
    let answer: (value: { routine: Routine }) => void = () => {};
    const pauseRoutine = vi.fn(() => new Promise<{ routine: Routine }>((r) => (answer = r)));
    const { actions } = setup(stubClient({ pauseRoutine }));
    const pausing = actions.setPaused(routine, true);
    expect(findRoutine(routines(), routine.id)).toMatchObject({ paused: true });
    expect(findRoutine(routines(), routine.id)?.nextRunAt).toBeUndefined();
    const { nextRunAt: _next, ...unscheduled } = routine;
    answer({ routine: { ...unscheduled, paused: true, extraRunsLeft: 4 } });
    await pausing;
    expect(findRoutine(routines(), routine.id)).toMatchObject({ paused: true, extraRunsLeft: 4 });
  });

  it("puts a routine back and says why when pausing fails", async () => {
    const routine = routineFixture();
    updateRoutines((s) => applyRoutinesChanged(s, [routine]));
    const failing = stubClient({
      pauseRoutine: vi.fn(async () => {
        throw new HttpError(404, "Routine not found");
      }),
    });
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
    await actions.resync();
    expect(client.listRoutines).not.toHaveBeenCalled();
    await actions.ensureLoaded();
    await actions.loadRuns("rtn_x");
    await actions.resync();
    expect(client.listRoutines).toHaveBeenCalledTimes(2);
    expect(client.listThreads).toHaveBeenLastCalledWith({ routineId: "rtn_x" });
  });
});
