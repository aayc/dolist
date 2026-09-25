// @vitest-environment happy-dom
import type { Routine } from "@ddl/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../app/services";
import { ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import {
  applyRoutinesChanged,
  initialRoutinesState,
  type RoutinesState,
  useRoutinesStore,
} from "../../state/routines-store";
import { ui } from "../../state/ui-store";
import { RoutinesInboxRow, routinesPreview } from "./RoutinesInboxRow";
import { RoutinesView } from "./RoutinesView";
import { formatDayTime } from "./routine-format";
import { routineFixture } from "./testing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 3_600_000;
let root: Root | null = null;

function render(node: ReactNode, state: Partial<RoutinesState> = {}) {
  useRoutinesStore.setState({ ...initialRoutinesState, ...state }, true);
  const actions = { ensureLoaded: vi.fn(async () => {}), load: vi.fn(async () => {}) };
  const commands = new CommandRegistry();
  commands.registerAll([
    { id: "routines:show", name: "Show routines", run: () => {} },
    { id: "panel:right", name: "Toggle agent panel", run: () => {} },
  ]);
  const services = { routines: actions, commands } as unknown as Services;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(<ServicesContext value={services}>{node}</ServicesContext>);
  });
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  return { actions, container, all, one: (id: string) => all(id)[0] };
}

function loaded(routines: Routine[]): Partial<RoutinesState> {
  return applyRoutinesChanged(initialRoutinesState, routines);
}

beforeEach(() => {
  ui.set({ rightOpen: true, rightView: { kind: "routines" } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("RoutinesView", () => {
  it("lists each routine: name, schedule in words, next run, last run, paused, problems", () => {
    const next = Date.now() + 2 * HOUR;
    const { all, container } = render(
      <RoutinesView />,
      loaded([
        routineFixture({
          id: "rtn_b",
          nextRunAt: next,
          lastRun: {
            threadId: "thr_1",
            trigger: "schedule",
            status: "done",
            startedAt: Date.now() - HOUR,
            finishedAt: Date.now() - HOUR + 60_000,
          },
        }),
        routineFixture({
          id: "rtn_p",
          name: "Price watch",
          paused: true,
          scheduleText: "Every 2 hours",
        }),
        routineFixture({
          id: "rtn_x",
          name: "Broken",
          schedule: "whenever",
          scheduleText: undefined,
          error: "I can't read “whenever” as a schedule.",
        }),
      ]),
    );
    const rows = all("routine-item");
    expect(
      rows.map((row) => row.querySelector('[data-testid="routine-name"]')?.textContent),
    ).toEqual(["Broken", "Morning briefing", "Price watch"]);
    const [broken, briefing, watch] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(briefing.querySelector('[data-testid="routine-schedule"]')?.textContent).toBe(
      "Every weekday at 7:30 AM",
    );
    expect(briefing.querySelector('[data-testid="routine-next"]')?.textContent).toBe(
      `Next run ${formatDayTime(next)}`,
    );
    expect(
      briefing.querySelector('[data-testid="routine-last"] [data-testid="status-chip"]'),
    ).toHaveProperty("dataset.status", "done");
    expect(briefing.querySelector('[data-testid="routine-paused"]')).toBeNull();

    expect(watch.querySelector('[data-testid="routine-paused"]')?.textContent).toBe("Paused");
    expect(watch.querySelector('[data-testid="routine-next"]')).toBeNull();
    expect(watch.querySelector('[data-testid="routine-last"]')?.textContent).toBe("No runs yet");

    expect(broken.querySelector('[data-testid="routine-problem"]')?.textContent).toBe(
      "I can't read “whenever” as a schedule.",
    );
    expect(broken.querySelector('[data-testid="routine-schedule"]')).toBeNull();
    expect(broken.className).toContain("has-problem");
    expect(container.querySelector('[data-testid="routines-empty"]')).toBeNull();
  });

  it("opens a routine's own inbox when one is clicked", () => {
    const { one } = render(<RoutinesView />, loaded([routineFixture({ id: "rtn_b" })]));
    act(() => one("routine-item")!.click());
    expect(ui.get().rightView).toEqual({ kind: "routine", routineId: "rtn_b" });
  });

  it("loads the list when shown, and waits for it", () => {
    const { actions, container, one } = render(<RoutinesView />);
    expect(actions.ensureLoaded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(one("routines-empty")).toBeUndefined();
  });

  it("explains routines when there are none", () => {
    const { one } = render(<RoutinesView />, loaded([]));
    expect(one("routines-empty")?.textContent).toContain("No routines yet.");
  });

  it("says why the list didn't load and tries again", () => {
    const { actions, one } = render(<RoutinesView />, {
      status: "error",
      error: "Could not reach the Daily Do List daemon",
    });
    const notice = one("routines-error")!;
    expect(notice.textContent).toContain("Could not reach the Daily Do List daemon");
    act(() => notice.querySelector("button")!.click());
    expect(actions.load).toHaveBeenCalledTimes(1);
  });

  it("goes back to the inbox", () => {
    const { one } = render(<RoutinesView />, loaded([]));
    act(() => one("routines-back")!.click());
    expect(ui.get().rightView).toEqual({ kind: "inbox" });
  });
});

describe("the inbox's Routines row", () => {
  it("counts routines and the ones to fix, and opens the section", () => {
    const { one, actions } = render(
      <RoutinesInboxRow />,
      loaded([routineFixture(), routineFixture({ id: "rtn_x", name: "Broken", error: "Bad" })]),
    );
    const row = one("inbox-routines")!;
    expect(actions.ensureLoaded).toHaveBeenCalled();
    expect(row.querySelector(".inbox-count")?.textContent).toBe("2");
    expect(row.querySelector(".routines-row-problem")?.textContent).toBe("1 to fix");
    expect(row.dataset.command).toBe("routines:show");
    ui.set({ rightView: { kind: "inbox" } });
    act(() => row.click());
    expect(ui.get().rightView).toEqual({ kind: "routines" });
  });

  it("previews the routine that runs next, or what routines are", () => {
    const now = Date.now();
    const soon = now + HOUR;
    expect(
      routinesPreview(
        [
          routineFixture({ id: "a", name: "Later", nextRunAt: now + 5 * HOUR }),
          routineFixture({ id: "b", name: "Sooner", nextRunAt: soon }),
          routineFixture({ id: "c", name: "Paused", nextRunAt: now + 1, paused: true }),
        ],
        now,
      ),
    ).toBe(`Next: Sooner, ${formatDayTime(soon, now)}`);
    expect(routinesPreview([routineFixture({ paused: true })], now)).toBe(
      "Nothing scheduled: every routine is paused or needs fixing.",
    );
    expect(routinesPreview([], now)).toBe(
      "Standing jobs the agent runs on a schedule, like a morning briefing.",
    );
  });
});
