import { describe, expect, it } from "vitest";
import type { Services } from "../app/services";
import { createDefaultCommands } from "./default-commands";
import { parseHotkey } from "./hotkeys";
import { commandLabel, commandTooltip, shortcutOf } from "./labels";
import { CommandRegistry } from "./registry";

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  commands.registerAll(createDefaultCommands({} as Services));
  return commands;
}

describe("shortcuts and names from the command registry", () => {
  it("names a control by the command's label, else its palette name", () => {
    const commands = registry();
    expect(commandLabel(commands, "note:new")).toBe("New note");
    expect(commands.get("note:new")?.name).toBe("Create new note");
    expect(commandLabel(commands, "daily:today")).toBe("Open today's note");
    expect(commandLabel(commands, "tab:close")).toBe("Close tab");
    expect(commandLabel(commands, "panel:right")).toBe("Toggle agent panel");
    expect(commandLabel(commands, "search:open")).toBe("Search vault");
  });

  it("shows the command's first hotkey", () => {
    const commands = registry();
    expect(shortcutOf(commands.get("daily:today"), false)).toEqual(parseHotkey("Mod+Shift+D"));
    expect(shortcutOf(commands.get("panel:right"), false)).toEqual(parseHotkey("Mod+\\"));
    expect(shortcutOf(commands.get("folder:new"), false)).toBeNull();
    expect(shortcutOf(undefined)).toBeNull();
  });

  it("doesn't offer, in a browser tab, a shortcut the browser keeps (⌘N, ⌘W, ⇧⌘N)", () => {
    const commands = registry();
    for (const id of ["note:new", "tab:close", "daily:next"]) {
      expect(shortcutOf(commands.get(id), false)).not.toBeNull();
      expect(shortcutOf(commands.get(id), true)).toBeNull();
    }
    expect(shortcutOf(commands.get("daily:today"), true)).toEqual(parseHotkey("Mod+Shift+D"));
    const fallback = new CommandRegistry();
    fallback.register({
      id: "x",
      name: "X",
      hotkeys: [parseHotkey("Mod+T"), parseHotkey("Mod+Alt+T")],
      run: () => {},
    });
    expect(shortcutOf(fallback.get("x"), true)).toEqual(parseHotkey("Mod+Alt+T"));
  });

  it("gives a command's control its tooltip, keycaps source and aria-keyshortcuts", () => {
    const commands = registry();
    const today = commandTooltip(commands, "daily:today");
    expect(today["data-tooltip"]).toBe("Open today's note");
    expect(today["data-command"]).toBe("daily:today");
    expect(today["aria-keyshortcuts"]).toMatch(/^(Meta|Control)\+Shift\+D$/);
    expect(commandTooltip(commands, "panel:right", "Close agent panel")["data-tooltip"]).toBe(
      "Close agent panel",
    );
    expect(commandTooltip(commands, "folder:new")).not.toHaveProperty("aria-keyshortcuts");
  });

  it("keeps control labels short: sentence case, no trailing period, no shortcut", () => {
    for (const command of registry().all()) {
      for (const text of [command.name, command.label ?? command.name]) {
        expect(text[0]).toBe(text[0]?.toUpperCase());
        expect(text).not.toMatch(/\.$|[⌘⇧⌥⌃⎋↩]|\b(Ctrl|Cmd|Alt|Shift)\+/);
      }
    }
  });
});
