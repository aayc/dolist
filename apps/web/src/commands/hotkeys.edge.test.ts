import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { formatHotkey, type Hotkey, type KeyLike, matchHotkey, parseHotkey } from "./hotkeys";
import { CommandRegistry } from "./registry";

function key(init: Partial<KeyLike> & { key: string }): KeyLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

const DEFAULTS = [
  "Mod+Shift+D",
  "Mod+Shift+P",
  "Mod+Shift+N",
  "Mod+P",
  "Mod+O",
  "Mod+N",
  "Mod+,",
  "Mod+Shift+F",
  "Mod+\\",
  "Mod+Shift+A",
  "Mod+W",
  "Mod+S",
  "Escape",
].map(parseHotkey);

describe("matchHotkey: platforms and modifiers", () => {
  it("Mod is ⌘ on macOS and Ctrl elsewhere; the other key must not be held", () => {
    const save = parseHotkey("Mod+S");
    expect(matchHotkey(save, key({ key: "s", metaKey: true }), true)).toBe(true);
    expect(matchHotkey(save, key({ key: "s", ctrlKey: true }), true)).toBe(false);
    expect(matchHotkey(save, key({ key: "s", metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(matchHotkey(save, key({ key: "s", ctrlKey: true }), false)).toBe(true);
    expect(matchHotkey(save, key({ key: "s", ctrlKey: true, metaKey: true }), false)).toBe(false);
  });

  it("requires exactly the declared Shift/Alt state", () => {
    const previous = parseHotkey("Mod+Shift+P");
    const palette = parseHotkey("Mod+P");
    const shifted = key({ key: "P", metaKey: true, shiftKey: true });
    expect(matchHotkey(previous, shifted, true)).toBe(true);
    expect(matchHotkey(palette, shifted, true)).toBe(false);
    expect(matchHotkey(previous, key({ key: "p", metaKey: true }), true)).toBe(false);
    expect(matchHotkey(previous, { ...shifted, altKey: true }, true)).toBe(false);
  });

  it("literal Ctrl hotkeys are macOS-only (other platforms use Mod)", () => {
    const hotkey = parseHotkey("Ctrl+Shift+K");
    expect(matchHotkey(hotkey, key({ key: "K", ctrlKey: true, shiftKey: true }), true)).toBe(true);
    expect(matchHotkey(hotkey, key({ key: "K", ctrlKey: true, shiftKey: true }), false)).toBe(
      false,
    );
  });
});

describe("matchHotkey: keyboard layouts", () => {
  it("uses the physical key for non-Latin layouts and ⌥-produced characters", () => {
    const previous = parseHotkey("Mod+Shift+P");
    expect(
      matchHotkey(previous, key({ key: "З", code: "KeyP", metaKey: true, shiftKey: true }), true),
    ).toBe(true);
    const option = parseHotkey("Alt+P");
    expect(matchHotkey(option, key({ key: "π", code: "KeyP", altKey: true }), true)).toBe(true);
    expect(matchHotkey(option, key({ key: "Dead", code: "KeyP", altKey: true }), true)).toBe(true);
    const digit = parseHotkey("Mod+1");
    // AZERTY: the "1" key produces "&".
    expect(matchHotkey(digit, key({ key: "&", code: "Digit1", ctrlKey: true }), false)).toBe(true);
  });

  it("trusts the letter a Latin layout produced (Dvorak, AZERTY, QWERTZ)", () => {
    const newNote = parseHotkey("Mod+N");
    const palette = parseHotkey("Mod+P");
    // Dvorak: ⌘B (bold) is the physical N key, ⌘L (checkbox) the physical P key.
    expect(matchHotkey(newNote, key({ key: "b", code: "KeyN", metaKey: true }), true)).toBe(false);
    expect(matchHotkey(palette, key({ key: "l", code: "KeyP", metaKey: true }), true)).toBe(false);
    // …and the letters themselves still work wherever they are.
    expect(matchHotkey(newNote, key({ key: "n", code: "KeyL", metaKey: true }), true)).toBe(true);
    // AZERTY: Ctrl+Q is the physical A key.
    const all = parseHotkey("Mod+A");
    expect(matchHotkey(all, key({ key: "q", code: "KeyA", ctrlKey: true }), false)).toBe(false);
  });

  test.prop([
    fc.constantFrom(...DEFAULTS),
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
    fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")),
    fc.boolean(),
  ])(
    "a produced Latin letter matches only hotkeys for that letter, whatever the physical key",
    (hotkey, letter, physical, isMac) => {
      const event = key({
        key: hotkey.shift ? letter.toUpperCase() : letter,
        code: `Key${physical}`,
        shiftKey: Boolean(hotkey.shift),
        altKey: Boolean(hotkey.alt),
        metaKey: Boolean(hotkey.mod) && isMac,
        ctrlKey: Boolean(hotkey.mod) && !isMac,
      });
      expect(matchHotkey(hotkey, event, isMac)).toBe(hotkey.key === letter);
    },
  );

  test.prop([fc.constantFrom(...DEFAULTS), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()])(
    "never matches with an extra or missing modifier",
    (hotkey, meta, ctrl, shift, alt) => {
      const isMac = true;
      const event = key({
        key: hotkey.key,
        metaKey: meta,
        ctrlKey: ctrl,
        shiftKey: shift,
        altKey: alt,
      });
      const exact =
        meta === Boolean(hotkey.mod) &&
        ctrl === Boolean(hotkey.ctrl) &&
        shift === Boolean(hotkey.shift) &&
        alt === Boolean(hotkey.alt);
      expect(matchHotkey(hotkey, event, isMac)).toBe(exact);
    },
  );
});

describe("parseHotkey / formatHotkey", () => {
  it("accepts modifier aliases in any case", () => {
    expect(parseHotkey("cmd+option+k")).toEqual({ mod: true, alt: true, key: "k" });
    expect(parseHotkey("MOD+SHIFT+,")).toEqual({ mod: true, shift: true, key: "," });
    expect(parseHotkey("ArrowLeft")).toEqual({ key: "ArrowLeft" });
  });

  it("cannot express the + key itself", () => {
    expect(() => parseHotkey("Mod++")).toThrow(/Unknown modifier/);
  });

  test.prop([
    fc.record({
      mod: fc.boolean(),
      shift: fc.boolean(),
      alt: fc.boolean(),
      ctrl: fc.boolean(),
      key: fc.constantFrom("d", ",", "\\", "Escape", "ArrowLeft", "Enter", " ", "1"),
    }),
  ])("formats every combination readably on both platforms", (spec) => {
    const hotkey: Hotkey = { ...spec };
    const mac = formatHotkey(hotkey, true);
    const other = formatHotkey(hotkey, false);
    expect(mac.includes("⌘")).toBe(spec.mod);
    expect(mac.includes("⇧")).toBe(spec.shift);
    expect(mac.includes("⌥")).toBe(spec.alt);
    expect(other.split("+").filter((p) => p === "Ctrl").length).toBe(spec.mod || spec.ctrl ? 1 : 0);
    expect(other.includes("Shift")).toBe(spec.shift);
    expect(other.includes("Alt")).toBe(spec.alt);
    expect(mac).not.toBe("");
  });
});

describe("CommandRegistry conflicts", () => {
  it("resolves two commands on one hotkey by registration order, then by `when`", () => {
    const registry = new CommandRegistry();
    let firstEnabled = true;
    registry.register({
      id: "first",
      name: "First",
      hotkeys: [parseHotkey("Mod+K")],
      when: () => firstEnabled,
      run: () => {},
    });
    const disposeSecond = registry.register({
      id: "second",
      name: "Second",
      hotkeys: [parseHotkey("Mod+K")],
      run: () => {},
    });
    const event = key({ key: "k", metaKey: true });
    expect(registry.findByEvent(event, true)?.id).toBe("first");
    firstEnabled = false;
    expect(registry.findByEvent(event, true)?.id).toBe("second");
    disposeSecond();
    expect(registry.findByEvent(event, true)).toBeUndefined();
  });

  it("a stale disposer never removes a re-registered command with the same id", () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({ id: "x", name: "Old", run: () => {} });
    dispose();
    registry.register({ id: "x", name: "New", run: () => {} });
    dispose();
    expect(registry.get("x")?.name).toBe("New");
  });

  it("isolates a command that throws synchronously and reports the error", async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "boom",
      name: "Boom",
      run: () => {
        throw new Error("sync failure");
      },
    });
    const reportError = vi.fn();
    const original = globalThis.reportError;
    globalThis.reportError = reportError;
    try {
      expect(registry.run("boom")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.reportError = original;
    }
    expect(reportError).toHaveBeenCalledWith(new Error("sync failure"));
  });

  it("the default hotkeys are all distinct", () => {
    const seen = new Set(DEFAULTS.map((h) => formatHotkey(h, true)));
    expect(seen.size).toBe(DEFAULTS.length);
  });
});
