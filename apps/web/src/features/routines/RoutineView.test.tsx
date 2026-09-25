// @vitest-environment happy-dom
import type { Routine, ThreadSummary } from "@ddl/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../../app/routine-actions";
import type { Services } from "../../app/services";
import { ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import { applyThreadList, initialAgentState } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import {
  applyRoutinesChanged,
  initialRoutinesState,
  useRoutinesStore,
} from "../../state/routines-store";
import { ui } from "../../state/ui-store";
import { ThreadHeader } from "../agent/ThreadHeader";
import { RoutineView } from "./RoutineView";
import { capitalize, formatDayTime } from "./routine-format";
import { routineFixture } from "./testing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
let root: Root | null = null;

function run(id: string, createdAt: number, patch: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    taskId: `run_${id}`,
    notePath: "Routines/Morning briefing.md",
    title: "Morning briefing",
    status: "done",
    createdAt,
    updatedAt: createdAt,
    messageCount: 3,
    artifactCount: 0,
    surfaces: [],
    pendingApprovals: 0,
    routineId: "rtn_1",
    ...patch,
  };
}

function render(
  node: ReactNode,
  { routines = [routineFixture()], threads = [] as ThreadSummary[] } = {},
) {
  useRoutinesStore.setState(applyRoutinesChanged(initialRoutinesState, routines), true);
  useAgentStore.setState(applyThreadList(initialAgentState, threads), true);
  const actions = {
    ensureLoaded: vi.fn(async () => {}),
    loadRuns: vi.fn(async () => {}),
    runNow: vi.fn(async (): Promise<RunResult> => ({ ok: true, threadId: "thr_new" })),
    setPaused: vi.fn(async () => {}),
    edit: vi.fn(async () => true),
  };
  const agent = { openThread: vi.fn(), cancel: vi.fn(), retry: vi.fn(), revealTask: vi.fn() };
  const commands = new CommandRegistry();
  commands.registerAll([{ id: "panel:right", name: "Toggle agent panel", run: () => {} }]);
  const services = { routines: actions, agent, commands } as unknown as Services;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(<ServicesContext value={services}>{node}</ServicesContext>);
  });
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  return { actions, agent, container, all, one: (id: string) => all(id)[0] };
}

async function click(element: HTMLElement | undefined): Promise<void> {
  await act(async () => element!.click());
}

beforeEach(() => {
  ui.set({ rightOpen: true, rightView: { kind: "routine", routineId: "rtn_1" } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("RoutineView", () => {
  it("shows what the routine does and when, and fetches its runs", () => {
    const next = Date.now() + 3 * HOUR;
    const { actions, one } = render(<RoutineView routineId="rtn_1" />, {
      routines: [routineFixture({ nextRunAt: next, notify: "when_changed", extraRunsLeft: 4 })],
    });
    expect(actions.loadRuns).toHaveBeenCalledWith("rtn_1");
    expect(one("routine-title")?.textContent).toBe("Morning briefing");
    expect(one("routine-view-schedule")?.textContent).toBe("Every weekday at 7:30 AM");
    expect(one("routine-view-next")?.textContent).toBe(capitalize(formatDayTime(next)));
    expect(one("routine-view-notify")?.textContent).toBe("When something changed");
    expect(one("routine-view-extra")?.textContent).toBe("4 extra runs left today");
    expect(one("routine-instructions")?.textContent).toBe("Brief me for the day.");
    expect(one("routine-view-paused")).toBeUndefined();
    expect(one("routine-runs-empty")?.textContent).toContain("or run it now");
  });

  it("is its own inbox: its runs, newest first, each opening its thread", async () => {
    const now = Date.now();
    const { agent, all } = render(<RoutineView routineId="rtn_1" />, {
      threads: [
        run("thr_old", now - 26 * HOUR, { lastMessagePreview: "Nothing new." }),
        run("thr_new", now - HOUR, {
          status: "waiting_approval",
          pendingApprovals: 1,
          lastMessagePreview: "**Draft** ready",
        }),
        run("thr_other", now, { routineId: "rtn_2" }),
        { ...run("thr_task", now), routineId: undefined, taskId: "tsk_1" },
      ],
    });
    const rows = all("routine-run-item");
    expect(rows.map((row) => row.dataset.threadId)).toEqual(["thr_new", "thr_old"]);
    expect(rows[0]!.querySelector(".inbox-item-title")?.textContent).toBe(
      capitalize(formatDayTime(now - HOUR)),
    );
    expect(rows[0]!.querySelector(".inbox-item-preview")?.textContent).toBe("Draft ready");
    expect(rows[0]!.querySelector(".routine-run-pending")?.textContent).toBe("1 to approve");
    expect(rows[1]!.querySelector('[data-testid="status-chip"]')).toHaveProperty(
      "dataset.status",
      "done",
    );
    await click(rows[1]);
    expect(agent.openThread).toHaveBeenCalledWith("thr_old");
  });

  it("runs it now", async () => {
    const { actions, one } = render(<RoutineView routineId="rtn_1" />);
    await click(one("routine-run"));
    expect(actions.runNow).toHaveBeenCalledWith(expect.objectContaining({ id: "rtn_1" }));
    expect(one("routine-run-problem")).toBeUndefined();
    expect(one("routine-run")?.textContent).toBe("Run now");
  });

  it.each([
    ["a run is going (409)", "It can't run right now", "“Morning briefing” is running right now."],
    [
      "the agent can't run here (503)",
      "The agent can't run here",
      "The agent is paused: switch it on to run routines.",
    ],
  ])("says why Run now didn't start when %s", async (_case, title, body) => {
    const { actions, one } = render(<RoutineView routineId="rtn_1" />);
    actions.runNow.mockResolvedValueOnce({ ok: false, problem: { title, body } });
    await click(one("routine-run"));
    const notice = one("routine-run-problem")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.querySelector(".routines-notice-title")?.textContent).toBe(title);
    expect(notice.textContent).toContain(body);
    await click(one("routine-run-problem-dismiss"));
    expect(one("routine-run-problem")).toBeUndefined();
  });

  it("drops a stale reason once the run it was about ends", async () => {
    const running = routineFixture({
      lastRun: { threadId: "thr_1", trigger: "manual", status: "working", startedAt: 1 },
    });
    const { actions, one } = render(<RoutineView routineId="rtn_1" />, { routines: [running] });
    actions.runNow.mockResolvedValueOnce({
      ok: false,
      problem: {
        title: "It can't run right now",
        body: "“Morning briefing” is running right now.",
      },
    });
    await click(one("routine-run"));
    expect(one("routine-run-problem")).toBeDefined();
    const show = (routine: Routine) =>
      act(() => useRoutinesStore.setState(applyRoutinesChanged(initialRoutinesState, [routine])));
    // Still true while the same run goes on.
    show({ ...running, lastRun: { ...running.lastRun!, status: "waiting_approval" } });
    expect(one("routine-run-problem")).toBeDefined();
    show({ ...running, lastRun: { ...running.lastRun!, status: "done", finishedAt: 2 } });
    expect(one("routine-run-problem")).toBeUndefined();
  });

  it("pauses and resumes", async () => {
    const { actions, one } = render(<RoutineView routineId="rtn_1" />);
    expect(one("routine-pause")?.textContent).toBe("Pause");
    await click(one("routine-pause"));
    expect(actions.setPaused).toHaveBeenCalledWith(expect.objectContaining({ id: "rtn_1" }), true);

    act(() =>
      useRoutinesStore.setState(
        applyRoutinesChanged(initialRoutinesState, [routineFixture({ paused: true })]),
      ),
    );
    expect(one("routine-pause")?.textContent).toBe("Resume");
    expect(one("routine-view-paused")?.textContent).toBe("Paused");
    expect(one("routine-view-next")?.textContent).toBe("Paused: it won't run until you resume it.");
    await click(one("routine-pause"));
    expect(actions.setPaused).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "rtn_1" }),
      false,
    );
  });

  it("opens the routine's file to edit it", async () => {
    const { actions, one } = render(<RoutineView routineId="rtn_1" />);
    expect(one("routine-edit")?.dataset.tooltip).toBe(
      "Open Routines/Morning briefing.md in the editor",
    );
    await click(one("routine-edit"));
    expect(actions.edit).toHaveBeenCalledWith(expect.objectContaining({ id: "rtn_1" }));
  });

  it("shows a problem with the file", () => {
    const broken: Routine = routineFixture({
      schedule: "whenever",
      scheduleText: undefined,
      error: "I can't read “whenever” as a schedule.",
    });
    const { one } = render(<RoutineView routineId="rtn_1" />, { routines: [broken] });
    expect(one("routine-view-problem")?.textContent).toContain(
      "I can't read “whenever” as a schedule.",
    );
    expect(one("routine-view-schedule")?.textContent).toBe("whenever");
    expect(one("routine-view-next")?.textContent).toBe("It can't run until its file is fixed.");
  });

  it("says when the routine is gone, and goes back to the list", async () => {
    const { one } = render(<RoutineView routineId="rtn_1" />, { routines: [] });
    expect(one("routine-gone")?.textContent).toContain("This routine is gone.");
    await click(one("routine-back"));
    expect(ui.get().rightView).toEqual({ kind: "routines" });
  });
});

describe("a run's thread header", () => {
  it("goes back to its routine and has no Retry (Run now counts against the budget)", async () => {
    const { one } = render(<ThreadHeader threadId="thr_run" />, {
      threads: [run("thr_run", Date.now())],
    });
    expect(one("thread-retry")).toBeUndefined();
    expect(one("thread-open-note")?.getAttribute("aria-label")).toBe("Open the routine's file");
    expect(one("thread-back")?.getAttribute("aria-label")).toBe("Back to the routine");
    await click(one("thread-back"));
    expect(ui.get().rightView).toEqual({ kind: "routine", routineId: "rtn_1" });
  });

  it("keeps Retry and the inbox for a task's thread", async () => {
    const { one } = render(<ThreadHeader threadId="thr_task" />, {
      threads: [{ ...run("thr_task", Date.now()), routineId: undefined, taskId: "tsk_1" }],
    });
    expect(one("thread-retry")).toBeDefined();
    await click(one("thread-back"));
    expect(ui.get().rightView).toEqual({ kind: "inbox" });
  });
});

describe("Repeat this", () => {
  const task = (patch: Partial<ThreadSummary> = {}) => ({
    ...run("thr_task", Date.now()),
    routineId: undefined,
    taskId: "tsk_1",
    notePath: "Daily/2026-09-25.md",
    title: "Check the weather in SF",
    ...patch,
  });

  afterEach(() => ui.set({ overlay: null }));

  it("offers a finished task to repeat, opening New routine from it", async () => {
    const { one } = render(<ThreadHeader threadId="thr_task" />, { threads: [task()] });
    const repeat = one("thread-repeat")!;
    expect(repeat.getAttribute("aria-label")).toBe("Repeat this on a schedule");
    await click(repeat);
    expect(ui.get().overlay).toEqual({
      kind: "new-routine",
      draft: {
        name: "Check the weather in SF",
        instructions: "Check the weather in SF",
        notify: "always",
        fromThreadId: "thr_task",
      },
    });
  });

  it.each([
    ["a task still working", task({ status: "working" })],
    ["a failed task", task({ status: "failed" })],
    ["a routine's run", run("thr_task", Date.now())],
  ])("doesn't offer it for %s", (_label, thread) => {
    const { one } = render(<ThreadHeader threadId="thr_task" />, { threads: [thread] });
    expect(one("thread-repeat")).toBeUndefined();
  });
});
