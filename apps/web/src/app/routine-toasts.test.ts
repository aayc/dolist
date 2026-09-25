// @vitest-environment happy-dom
import type { RoutineNotification } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routineFixture } from "../features/routines/testing";
import { initialRoutinesState, useRoutinesStore } from "../state/routines-store";
import { useToastStore } from "../state/toast-store";
import { ui } from "../state/ui-store";
import { announceRoutineRun } from "./routine-toasts";
import { handleServerEvent } from "./server-events";
import type { Services } from "./services";

const notification: RoutineNotification = {
  routineId: "rtn_1",
  title: "Morning briefing",
  body: "3 meetings today; rain after 4 PM.",
  threadId: "thr_run",
  status: "done",
  at: 1,
};

function toasts() {
  return useToastStore.getState().toasts;
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useRoutinesStore.setState(initialRoutinesState, true);
  ui.set({ rightOpen: false, rightView: { kind: "inbox" } });
});

afterEach(() => {
  ui.set({ rightOpen: false, rightView: { kind: "inbox" } });
});

describe("routine notifications", () => {
  it("toasts the run's result; clicking it opens the run", () => {
    const agent = { openThread: vi.fn() };
    announceRoutineRun(notification, agent);
    expect(toasts()).toMatchObject([
      {
        id: "routine-thr_run",
        kind: "success",
        title: "Morning briefing",
        body: "3 meetings today; rain after 4 PM.",
        actionLabel: "Open",
      },
    ]);
    toasts()[0]!.onClick!();
    expect(agent.openThread).toHaveBeenCalledWith("thr_run");
  });

  it.each([
    ["failed", "error"],
    ["waiting_user", "warning"],
    ["cancelled", "info"],
  ] as const)("a %s run is a %s toast", (status, kind) => {
    announceRoutineRun({ ...notification, status }, { openThread: vi.fn() });
    expect(toasts()[0]?.kind).toBe(kind);
  });

  it("stays quiet while the run, or its routine's inbox, is on screen", () => {
    const agent = { openThread: vi.fn() };
    ui.showThread("thr_run");
    announceRoutineRun(notification, agent);
    ui.showRoutine("rtn_1");
    announceRoutineRun(notification, agent);
    expect(toasts()).toEqual([]);
    ui.showRoutine("rtn_2");
    announceRoutineRun(notification, agent);
    expect(toasts()).toHaveLength(1);
  });

  it("routes routine events: the list is replaced, a notification toasts", () => {
    const services = { agent: { openThread: vi.fn() } } as unknown as Services;
    handleServerEvent(
      { type: "routines.changed", routines: [routineFixture({ paused: true })] },
      services,
    );
    expect(useRoutinesStore.getState()).toMatchObject({
      status: "loaded",
      routines: [{ id: "rtn_1", paused: true }],
    });
    handleServerEvent({ type: "routines.changed", routines: [] }, services);
    expect(useRoutinesStore.getState().routines).toEqual([]);
    handleServerEvent({ type: "routine.notification", notification }, services);
    expect(toasts()).toHaveLength(1);
  });
});
