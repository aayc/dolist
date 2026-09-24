import type { Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { markedState, run, runMarked } from "../test-helpers";
import { toggleChecklist, toggleTaskAtLine } from "./tasks";

describe("toggleChecklist (Mod-l / Mod-Enter)", () => {
  it("turns plain text into a task, keeping the caret on the text", () => {
    expect(runMarked("buy |milk", toggleChecklist)).toBe("- [ ] buy |milk");
    expect(runMarked("|buy milk", toggleChecklist)).toBe("- [ ] |buy milk");
    expect(runMarked("\tnested|", toggleChecklist)).toBe("\t- [ ] nested|");
  });

  it("turns list items into tasks", () => {
    expect(runMarked("- item|", toggleChecklist)).toBe("- [ ] item|");
    expect(runMarked("1. step|", toggleChecklist)).toBe("1. [ ] step|");
    expect(runMarked("-|", toggleChecklist)).toBe("- [ ] |");
    expect(runMarked("> - quoted|", toggleChecklist)).toBe("> - [ ] quoted|");
  });

  it("toggles task status", () => {
    expect(runMarked("- [ ] task|", toggleChecklist)).toBe("- [x] task|");
    expect(runMarked("- [x] task|", toggleChecklist)).toBe("- [ ] task|");
    expect(runMarked("- [X] task|", toggleChecklist)).toBe("- [ ] task|");
    expect(runMarked("- [/] task|", toggleChecklist)).toBe("- [x] task|");
  });

  it("makes an empty line a task only for a single-line selection", () => {
    expect(runMarked("|", toggleChecklist)).toBe("- [ ] |");
    expect(runMarked("«a\n\nb»", toggleChecklist)).toBe("«- [ ] a\n\n- [ ] b»");
  });

  it("applies to every selected line", () => {
    expect(runMarked("«- [ ] a\n- [x] b\nc»\nd", toggleChecklist)).toBe(
      "«- [x] a\n- [ ] b\n- [ ] c»\nd",
    );
  });

  it("marks the change as a toggle and respects read-only", () => {
    let tr: Transaction | null = null;
    toggleChecklist({ state: markedState("- [ ] a|"), dispatch: (t) => (tr = t) });
    expect((tr as Transaction | null)?.isUserEvent("input.toggle")).toBe(true);
    expect(
      run(markedState("- [ ] a|", { config: { readOnly: true } }), toggleChecklist),
    ).toBeNull();
  });
});

describe("toggleTaskAtLine", () => {
  it("toggles only task lines", () => {
    let state = markedState("- [ ] a\nplain\n- [x] b");
    const target = { state, dispatch: (tr: Transaction) => (state = tr.state) };
    expect(toggleTaskAtLine(target, 0)).toBe(true);
    target.state = state;
    expect(toggleTaskAtLine(target, 2)).toBe(true);
    target.state = state;
    expect(toggleTaskAtLine(target, 1)).toBe(false);
    expect(toggleTaskAtLine(target, 7)).toBe(false);
    expect(state.doc.toString()).toBe("- [x] a\nplain\n- [ ] b");
  });

  it("does nothing in a read-only editor", () => {
    const state = markedState("- [ ] a", { config: { readOnly: true } });
    const dispatch = vi.fn();
    expect(toggleTaskAtLine({ state, dispatch }, 0)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
