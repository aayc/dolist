// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { Services } from "../app/services";
import { ui } from "../state/ui-store";
import { createDefaultCommands } from "./default-commands";
import { CommandRegistry } from "./registry";

afterEach(() => {
  ui.set({ overlay: null });
});

describe("Import from Obsidian…", () => {
  it("is in the palette and opens Settings → Vault, even from another section", () => {
    const commands = new CommandRegistry();
    commands.registerAll(createDefaultCommands({} as Services));
    expect(commands.list().map((command) => command.name)).toContain("Import from Obsidian…");
    expect(commands.get("vault:import-obsidian")?.label).toBe("Import from Obsidian");
    expect(commands.get("vault:import-obsidian")?.hotkeys).toBeUndefined();
    ui.openOverlay({ kind: "settings", section: "agent" });
    commands.run("vault:import-obsidian");
    expect(ui.get().overlay).toEqual({ kind: "settings", section: "vault" });
  });
});
