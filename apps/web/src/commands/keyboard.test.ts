// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHotkey } from "./hotkeys";
import { installGlobalHotkeys } from "./keyboard";
import { CommandRegistry } from "./registry";

const vim = vi.hoisted(() => ({ claims: false }));
vi.mock("@ddl/editor", () => ({ vimClaimsKey: () => vim.claims }));

let registry: CommandRegistry;
let dispose: () => void;
const today = vi.fn();
const closeOverlay = vi.fn();
let overlayOpen = false;

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  registry = new CommandRegistry();
  registry.register({
    id: "daily:today",
    name: "Today",
    hotkeys: [parseHotkey("Mod+Shift+D")],
    run: today,
  });
  registry.register({
    id: "overlay:close",
    name: "Close",
    hidden: true,
    hotkeys: [parseHotkey("Escape")],
    when: () => overlayOpen,
    run: closeOverlay,
  });
  dispose = installGlobalHotkeys(registry, true);
});

afterEach(() => {
  dispose();
  today.mockReset();
  closeOverlay.mockReset();
  overlayOpen = false;
});

describe("global hotkeys", () => {
  it("runs a matching command and consumes the event before the editor sees it", () => {
    const editorListener = vi.fn();
    document.body.addEventListener("keydown", editorListener);
    const event = press({ key: "D", code: "KeyD", metaKey: true, shiftKey: true });
    document.body.removeEventListener("keydown", editorListener);
    expect(today).toHaveBeenCalledOnce();
    expect(today.mock.calls[0]![0]).toEqual({ event });
    expect(event.defaultPrevented).toBe(true);
    expect(editorListener).not.toHaveBeenCalled();
  });

  it("leaves unbound combinations and plain typing alone", () => {
    for (const init of [
      { key: "d" },
      { key: "D", shiftKey: true },
      { key: "d", metaKey: true },
      { key: "X", metaKey: true, shiftKey: true },
      { key: "D", ctrlKey: true, shiftKey: true },
    ]) {
      expect(press(init).defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(today).not.toHaveBeenCalled();
  });

  it("ignores keys that are part of an IME composition or already handled", () => {
    expect(
      press({ key: "D", metaKey: true, shiftKey: true, isComposing: true }).defaultPrevented,
    ).toBe(false);
    const prevented = new KeyboardEvent("keydown", {
      key: "D",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);
    expect(today).not.toHaveBeenCalled();
  });

  it("doesn't consume a hotkey whose command is not applicable", () => {
    expect(press({ key: "Escape" }).defaultPrevented).toBe(false);
    overlayOpen = true;
    expect(press({ key: "Escape" }).defaultPrevented).toBe(true);
    expect(closeOverlay).toHaveBeenCalledOnce();
  });

  it("leaves the Ctrl keys vim binds to vim where Mod is Ctrl, and only there", () => {
    dispose();
    const switcher = vi.fn();
    const save = vi.fn();
    registry.register({
      id: "switcher",
      name: "Switcher",
      hotkeys: [parseHotkey("Mod+O")],
      run: switcher,
    });
    registry.register({ id: "save", name: "Save", hotkeys: [parseHotkey("Mod+S")], run: save });
    vim.claims = true;
    try {
      dispose = installGlobalHotkeys(registry, false);
      // Vim (normal mode) claims Ctrl-O: the event reaches the editor untouched.
      expect(press({ key: "o", ctrlKey: true }).defaultPrevented).toBe(false);
      expect(switcher).not.toHaveBeenCalled();
      vim.claims = false;
      // Keys vim doesn't bind (or insert mode) keep their app shortcut.
      expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(true);
      expect(press({ key: "o", ctrlKey: true }).defaultPrevented).toBe(true);
      expect(save).toHaveBeenCalledOnce();
      expect(switcher).toHaveBeenCalledOnce();
      dispose();
      // On macOS "Mod" is ⌘, which vim never binds.
      vim.claims = true;
      dispose = installGlobalHotkeys(registry, true);
      expect(press({ key: "o", metaKey: true }).defaultPrevented).toBe(true);
      expect(switcher).toHaveBeenCalledTimes(2);
    } finally {
      vim.claims = false;
    }
  });

  it("keeps working after a command throws, and stops listening once disposed", async () => {
    registry.register({
      id: "broken",
      name: "Broken",
      hotkeys: [parseHotkey("Mod+Shift+B")],
      run: () => {
        throw new Error("sync failure");
      },
    });
    const reportError = vi.fn();
    const original = globalThis.reportError;
    globalThis.reportError = reportError;
    try {
      expect(() => press({ key: "B", metaKey: true, shiftKey: true })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      globalThis.reportError = original;
    }
    expect(reportError).toHaveBeenCalledWith(new Error("sync failure"));
    press({ key: "D", metaKey: true, shiftKey: true });
    expect(today).toHaveBeenCalledOnce();
    dispose();
    press({ key: "D", metaKey: true, shiftKey: true });
    expect(today).toHaveBeenCalledOnce();
    dispose = () => {};
  });
});
