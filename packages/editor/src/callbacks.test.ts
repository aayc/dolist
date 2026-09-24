import { describe, expect, it, vi } from "vitest";
import { saveDocument } from "./callbacks";
import { markedState } from "./test-helpers";

describe("saveDocument", () => {
  it("calls onSave and always reports the key as handled", () => {
    const onSave = vi.fn();
    const dispatch = vi.fn();
    expect(saveDocument({ state: markedState("x", { callbacks: { onSave } }), dispatch })).toBe(
      true,
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveDocument({ state: markedState("x"), dispatch })).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
