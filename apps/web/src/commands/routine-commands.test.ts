// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Services } from "../app/services";
import { ui } from "../state/ui-store";
import { createDefaultCommands } from "./default-commands";
import { CommandRegistry } from "./registry";

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  commands.registerAll(createDefaultCommands({} as Services));
  return commands;
}

afterEach(() => {
  ui.set({ overlay: null, rightOpen: false, rightView: { kind: "inbox" } });
});

describe("routine commands", () => {
  it("lists “Show routines” and “New routine…” in the palette", () => {
    const names = registry()
      .list()
      .map((command) => command.name);
    expect(names).toContain("Show routines");
    expect(names).toContain("New routine…");
  });

  it("“Show routines” opens the Routines section in the agent panel", () => {
    registry().run("routines:show");
    expect(ui.get()).toMatchObject({ rightOpen: true, rightView: { kind: "routines" } });
  });

  it("“New routine…” opens the dialog, named “New routine” on controls", () => {
    const commands = registry();
    expect(commands.get("routine:new")?.label).toBe("New routine");
    commands.run("routine:new");
    expect(ui.get().overlay).toEqual({ kind: "new-routine" });
  });

  it("takes no shortcut: the free ones would clash with the browser's", () => {
    const commands = registry();
    expect(commands.get("routines:show")?.hotkeys).toBeUndefined();
    expect(commands.get("routine:new")?.hotkeys).toBeUndefined();
  });

  it("toggles the panel from the ribbon when routines are already shown", () => {
    ui.toggleRoutines();
    expect(ui.get()).toMatchObject({ rightOpen: true, rightView: { kind: "routines" } });
    ui.showRoutine("rtn_1");
    ui.toggleRoutines();
    expect(ui.get().rightOpen).toBe(false);
    ui.set({ rightOpen: true, rightView: { kind: "inbox" } });
    ui.toggleRoutines();
    expect(ui.get()).toMatchObject({ rightOpen: true, rightView: { kind: "routines" } });
  });
});
