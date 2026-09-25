// @vitest-environment happy-dom
import { ROUTINE_TEMPLATES } from "@ddl/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError } from "../../api/errors";
import type { CreateResult } from "../../app/routine-actions";
import type { Services } from "../../app/services";
import { ServicesContext } from "../../app/services";
import { CommandRegistry } from "../../commands/registry";
import {
  applyRoutineList,
  initialRoutinesState,
  type RoutinesState,
  useRoutinesStore,
} from "../../state/routines-store";
import { type RoutineDraft, ui } from "../../state/ui-store";
import { NewRoutineDialog } from "./NewRoutineDialog";
import { repeatDraft } from "./repeat";
import { routineFixture } from "./testing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function daemonError(status: number, error: string, message: string): HttpError {
  return new HttpError(status, message, { error, message });
}

let root: Root | null = null;
const LOADED = applyRoutineList(initialRoutinesState, {
  routines: [],
  templates: [...ROUTINE_TEMPLATES],
});

function render(draft?: RoutineDraft, state: RoutinesState = LOADED) {
  useRoutinesStore.setState(state, true);
  ui.newRoutine(draft);
  const actions = {
    ensureLoaded: vi.fn(async () => {}),
    create: vi.fn(
      async (): Promise<CreateResult> => ({
        ok: true,
        routine: routineFixture({ id: "rtn_new" }),
      }),
    ),
  };
  const services = { routines: actions, commands: new CommandRegistry() } as unknown as Services;
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServicesContext value={services}>
        <NewRoutineDialog {...(draft ? { draft } : {})} />
      </ServicesContext>,
    );
  });
  const one = <T extends HTMLElement = HTMLElement>(id: string) =>
    container.querySelector<T>(`[data-testid="${id}"]`);
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  return { actions, container, one, all };
}

function type(field: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setValue.call(field, value);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(button: HTMLElement | null): Promise<void> {
  await act(async () => button!.click());
}

function fill(one: ReturnType<typeof render>["one"], values: Record<string, string>) {
  for (const [field, value] of Object.entries(values)) {
    type(one<HTMLInputElement>(`routine-${field}-input`), value);
  }
}

beforeEach(() => {
  ui.set({ rightOpen: false, rightView: { kind: "inbox" } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  ui.set({ overlay: null });
});

describe("New routine", () => {
  it("offers the starter templates, and a template fills the form", () => {
    const { actions, all, one } = render();
    expect(actions.ensureLoaded).toHaveBeenCalled();
    expect(document.activeElement).toBe(one("routine-name-input"));
    const templates = all("routine-template");
    expect(templates.map((t) => t.dataset.templateId)).toEqual(ROUTINE_TEMPLATES.map((t) => t.id));
    expect(one<HTMLButtonElement>("routine-create")!.disabled).toBe(true);

    act(() => templates[0]!.click());
    const briefing = ROUTINE_TEMPLATES[0]!;
    expect(one<HTMLInputElement>("routine-name-input")!.value).toBe(briefing.name);
    expect(one<HTMLInputElement>("routine-schedule-input")!.value).toBe(briefing.schedule);
    expect(one<HTMLTextAreaElement>("routine-instructions-input")!.value).toBe(
      briefing.instructions,
    );
    expect(one("routine-schedule-preview")?.textContent).toBe("Every weekday at 7:30 AM");
    expect(templates[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(one("routine-notify-always")!.querySelector("input")!.checked).toBe(true);
    expect(one<HTMLButtonElement>("routine-create")!.disabled).toBe(false);
  });

  it("creates the routine, then shows it", async () => {
    const { actions, all, one } = render();
    act(() => all("routine-template")[3]!.click());
    act(() => one("routine-notify-never")!.querySelector("input")!.click());
    type(one<HTMLInputElement>("routine-name-input"), "  Kettle watch  ");
    await submit(one("routine-create"));
    const watch = ROUTINE_TEMPLATES[3]!;
    expect(actions.create).toHaveBeenCalledWith({
      name: "Kettle watch",
      schedule: watch.schedule,
      instructions: watch.instructions,
      notify: "never",
      uses: watch.uses,
    });
    expect(ui.get().overlay).toBeNull();
    expect(ui.get().rightView).toEqual({ kind: "routine", routineId: "rtn_new" });
  });

  it("previews the schedule in words as it's typed, with a hint when it can't read it", () => {
    const { one, container } = render();
    type(one<HTMLInputElement>("routine-schedule-input"), "every 2 hours");
    expect(one("routine-schedule-preview")?.textContent).toBe("Every 2 hours");
    type(one<HTMLInputElement>("routine-schedule-input"), "every other blue moon");
    expect(one("routine-schedule-preview")).toBeNull();
    expect(container.textContent).toContain("In words, like “every weekday at 7:30”");
  });

  it("shows the daemon's reason under the schedule, until the schedule changes", async () => {
    const { actions, one } = render();
    actions.create.mockResolvedValueOnce({
      ok: false,
      error: daemonError(400, "invalid_request", "Routines run at most every 15 minutes."),
    });
    fill(one, { name: "Ping", schedule: "every 5 minutes", instructions: "Ping it." });
    await submit(one("routine-create"));
    expect(one("routine-schedule-problem")?.textContent).toBe(
      "Routines run at most every 15 minutes.",
    );
    expect(one("routine-schedule-problem")?.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(one("routine-schedule-input"));
    expect(ui.get().overlay).toMatchObject({ kind: "new-routine" });
    type(one<HTMLInputElement>("routine-name-input"), "Pinger");
    expect(one("routine-schedule-problem")).not.toBeNull();
    type(one<HTMLInputElement>("routine-schedule-input"), "every 15 minutes");
    expect(one("routine-schedule-problem")).toBeNull();
  });

  it("shows a taken name under the name, and other failures above the buttons", async () => {
    const { actions, one } = render();
    actions.create
      .mockResolvedValueOnce({
        ok: false,
        error: daemonError(409, "conflict", "A routine named “Ping” already exists."),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: new NetworkError("Could not reach the Daily Do List daemon"),
      });
    fill(one, { name: "Ping", schedule: "every hour", instructions: "Ping it." });
    await submit(one("routine-create"));
    expect(one("routine-name-problem")?.textContent).toBe("A routine named “Ping” already exists.");
    expect(document.activeElement).toBe(one("routine-name-input"));
    await submit(one("routine-create"));
    expect(one("routine-name-problem")).toBeNull();
    expect(one("routine-form-problem")?.textContent).toBe(
      "Could not reach the Daily Do List daemon",
    );
  });

  it("creates with the chat bar's keys from the instructions", async () => {
    const { actions, one } = render();
    fill(one, { name: "Ping", schedule: "every hour", instructions: "Ping it." });
    const isMac = /mac/i.test(navigator.platform);
    await act(async () => {
      one("routine-instructions-input")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(actions.create).toHaveBeenCalledTimes(1);
  });

  it("hides the templates when they couldn't load", () => {
    const { one } = render(undefined, { ...initialRoutinesState, status: "error", error: "x" });
    expect(one("routine-templates")).toBeNull();
    expect(one("routine-name-input")).not.toBeNull();
  });
});

describe("Repeat this", () => {
  it("starts from the task and waits for the user's schedule", async () => {
    const draft = repeatDraft({ id: "thr_1", title: "Check the weather in SF" });
    const { actions, one } = render(draft);
    expect(actions.ensureLoaded).not.toHaveBeenCalled();
    expect(one("new-routine-dialog")?.getAttribute("aria-label")).toBe("Repeat this task");
    expect(one("routine-templates")).toBeNull();
    expect(one<HTMLInputElement>("routine-name-input")!.value).toBe("Check the weather in SF");
    expect(one<HTMLTextAreaElement>("routine-instructions-input")!.value).toBe(
      "Check the weather in SF",
    );
    const schedule = one<HTMLInputElement>("routine-schedule-input")!;
    expect(schedule.value).toBe("");
    expect(document.activeElement).toBe(schedule);
    expect(one<HTMLButtonElement>("routine-create")!.disabled).toBe(true);

    type(schedule, "every morning at 8");
    await submit(one("routine-create"));
    expect(actions.create).toHaveBeenCalledWith({
      name: "Check the weather in SF",
      schedule: "every morning at 8",
      instructions: "Check the weather in SF",
      notify: "always",
    });
  });
});
