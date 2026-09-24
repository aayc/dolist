import { describe, expect, it, vi } from "vitest";
import {
  ariaKeyShortcuts,
  formatHotkey,
  hotkeyKeys,
  KEYS,
  type KeyLike,
  matchHotkey,
  parseHotkey,
} from "./hotkeys";
import { CommandRegistry } from "./registry";

function key(init: Partial<KeyLike> & { key: string }): KeyLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

describe("parseHotkey", () => {
  it("parses modifiers and normalizes the key", () => {
    expect(parseHotkey("Mod+Shift+D")).toEqual({ mod: true, shift: true, key: "d" });
    expect(parseHotkey("Mod+\\")).toEqual({ mod: true, key: "\\" });
    expect(parseHotkey("Escape")).toEqual({ key: "Escape" });
  });

  it("rejects unknown modifiers", () => {
    expect(() => parseHotkey("Hyper+K")).toThrow(/Unknown modifier/);
  });
});

describe("matchHotkey", () => {
  const today = parseHotkey("Mod+Shift+D");

  it("uses ⌘ as Mod on macOS and Ctrl elsewhere", () => {
    expect(matchHotkey(today, key({ key: "D", metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchHotkey(today, key({ key: "D", ctrlKey: true, shiftKey: true }), true)).toBe(false);
    expect(matchHotkey(today, key({ key: "D", ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(matchHotkey(today, key({ key: "D", metaKey: true, shiftKey: true }), false)).toBe(false);
  });

  it("requires the exact modifier set", () => {
    expect(matchHotkey(today, key({ key: "d", metaKey: true }), true)).toBe(false);
    expect(
      matchHotkey(today, key({ key: "D", metaKey: true, shiftKey: true, altKey: true }), true),
    ).toBe(false);
  });

  it("falls back to the physical key for non-Latin layouts and ⌥-modified characters", () => {
    expect(
      matchHotkey(today, key({ key: "В", code: "KeyD", metaKey: true, shiftKey: true }), true),
    ).toBe(true);
    const toggle = parseHotkey("Mod+\\");
    expect(matchHotkey(toggle, key({ key: "«", code: "Backslash", metaKey: true }), true)).toBe(
      true,
    );
  });

  it("matches named keys", () => {
    expect(matchHotkey(parseHotkey("Escape"), key({ key: "Escape" }), true)).toBe(true);
  });
});

describe("formatHotkey", () => {
  it("uses symbols on macOS and words elsewhere", () => {
    expect(formatHotkey(parseHotkey("Mod+Shift+D"), true)).toBe("⇧⌘D");
    expect(formatHotkey(parseHotkey("Mod+Shift+D"), false)).toBe("Ctrl+Shift+D");
    expect(formatHotkey(parseHotkey("Mod+,"), true)).toBe("⌘,");
    expect(formatHotkey(parseHotkey("Escape"), false)).toBe("Esc");
  });
});

describe("hotkeyKeys (one keycap per key)", () => {
  const keys = (spec: string, isMac: boolean) => hotkeyKeys(parseHotkey(spec), isMac);

  it("orders modifiers the Apple way on macOS: ⌃ ⌥ ⇧ ⌘, then the key", () => {
    expect(keys("Mod+Shift+D", true)).toEqual(["⇧", "⌘", "D"]);
    expect(keys("Ctrl+Alt+Shift+Mod+K", true)).toEqual(["⌃", "⌥", "⇧", "⌘", "K"]);
    expect(keys("Mod+\\", true)).toEqual(["⌘", "\\"]);
  });

  it("spells modifiers out elsewhere: Ctrl, Alt, Shift, then the key", () => {
    expect(keys("Mod+Shift+D", false)).toEqual(["Ctrl", "Shift", "D"]);
    expect(keys("Alt+Shift+Mod+K", false)).toEqual(["Ctrl", "Alt", "Shift", "K"]);
    expect(keys("Mod+,", false)).toEqual(["Ctrl", ","]);
  });

  it("uses Apple's glyphs for special keys on macOS and names elsewhere", () => {
    expect(keys("Escape", true)).toEqual(["⎋"]);
    expect(keys("Escape", false)).toEqual(["Esc"]);
    expect(keys("Shift+Enter", true)).toEqual(["⇧", "↩"]);
    expect(keys("Shift+Enter", false)).toEqual(["Shift", "Enter"]);
    expect(keys("Tab", true)).toEqual(["⇥"]);
    expect(keys("Mod+Backspace", true)).toEqual(["⌘", "⌫"]);
    expect(keys("ArrowUp", false)).toEqual(["↑"]);
    expect(keys("ArrowLeft", true)).toEqual(["←"]);
  });

  it("names the shortcut for aria-keyshortcuts", () => {
    expect(ariaKeyShortcuts(parseHotkey("Mod+Shift+D"), true)).toBe("Meta+Shift+D");
    expect(ariaKeyShortcuts(parseHotkey("Mod+Shift+D"), false)).toBe("Control+Shift+D");
    expect(ariaKeyShortcuts(parseHotkey("Mod+\\"), true)).toBe("Meta+\\");
    expect(ariaKeyShortcuts(parseHotkey("Escape"), false)).toBe("Escape");
  });

  it("keeps the named keys it offers as affordances", () => {
    expect(KEYS.enter).toEqual({ key: "Enter" });
    expect(KEYS.modEnter).toEqual({ mod: true, key: "Enter" });
  });
});

describe("CommandRegistry", () => {
  it("finds commands by hotkey and honours `when`", () => {
    const registry = new CommandRegistry();
    let enabled = false;
    const run = vi.fn();
    registry.register({
      id: "a",
      name: "A",
      hotkeys: [parseHotkey("Escape")],
      when: () => enabled,
      run,
    });
    const escapeKey = key({ key: "Escape" });
    expect(registry.findByEvent(escapeKey, true)).toBeUndefined();
    enabled = true;
    expect(registry.findByEvent(escapeKey, true)?.id).toBe("a");
    expect(registry.run("a")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("lists visible commands only and rejects duplicate ids", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "visible", name: "Visible", run: () => {} });
    registry.register({ id: "hidden", name: "Hidden", hidden: true, run: () => {} });
    expect(registry.list().map((c) => c.id)).toEqual(["visible"]);
    expect(() => registry.register({ id: "visible", name: "Again", run: () => {} })).toThrow(
      /Duplicate/,
    );
  });

  it("unregisters", () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({ id: "x", name: "X", run: () => {} });
    dispose();
    expect(registry.get("x")).toBeUndefined();
  });
});
