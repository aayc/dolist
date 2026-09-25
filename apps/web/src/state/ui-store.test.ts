// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ui } from "./ui-store";

afterEach(() => {
  ui.set({ overlay: null });
});

describe("closing overlays", () => {
  it("closes a dialog stacked on the overlay first, innermost first, then the overlay", () => {
    ui.openOverlay({ kind: "settings", section: "agent" });
    const outer = vi.fn();
    const inner = vi.fn();
    const unstackOuter = ui.stackDialog(outer);
    const unstackInner = ui.stackDialog(inner);

    ui.closeOverlay();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    expect(ui.get().overlay).toEqual({ kind: "settings", section: "agent" });

    unstackInner();
    ui.closeOverlay();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(ui.get().overlay).not.toBeNull();

    unstackOuter();
    ui.closeOverlay();
    expect(ui.get().overlay).toBeNull();
  });

  it("unregisters only the dialog it registered", () => {
    ui.openOverlay({ kind: "settings", section: "agent" });
    const close = vi.fn();
    const unstack = ui.stackDialog(close);
    unstack();
    unstack();
    ui.closeOverlay();
    expect(close).not.toHaveBeenCalled();
    expect(ui.get().overlay).toBeNull();
  });
});
