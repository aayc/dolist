import type { Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markedState, runMarked } from "../test-helpers";
import { toggleChecklist } from "./tasks";

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

  it("makes an empty line a task only for a single-line selection", () => {
    expect(runMarked("|", toggleChecklist)).toBe("- [ ] |");
    expect(runMarked("«a\n\nb»", toggleChecklist)).toBe("«- [ ] a\n\n- [ ] b»");
  });

  it("applies to every selected line", () => {
    expect(runMarked("«- [ ] a\n- [x] b\nc»\nd", toggleChecklist)).toBe(
      "«- [x] a\n- [ ] b\n- [ ] c»\nd",
    );
  });

  it("marks the change as a toggle", () => {
    let tr: Transaction | null = null;
    toggleChecklist({ state: markedState("- [ ] a|"), dispatch: (t) => (tr = t) });
    expect((tr as Transaction | null)?.isUserEvent("input.toggle")).toBe(true);
  });
});
