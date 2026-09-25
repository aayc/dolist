import { describe, expect, it } from "vitest";
import { findEditedLine, isSameLineEdited } from "./anchors";

describe("isSameLineEdited", () => {
  it("recognizes a line still being typed, trimmed or lightly edited", () => {
    expect(isSameLineEdited("find a plu", "find a plumber for Saturday")).toBe(true);
    expect(isSameLineEdited("find a plumber for Saturday", "find a plumber")).toBe(true);
    expect(isSameLineEdited("find a plumber for Saturday", "find a plumbr for Saturday!")).toBe(
      true,
    );
    expect(isSameLineEdited("  Call mom?  ", "Call mom?")).toBe(true);
  });

  it("doesn't recognize a rewrite or a blank line", () => {
    expect(isSameLineEdited("find a plumber for Saturday", "Call mom about the weekend")).toBe(
      false,
    );
    expect(isSameLineEdited("find a plumber", "")).toBe(false);
    expect(isSameLineEdited("", "")).toBe(false);
  });
});

describe("findEditedLine", () => {
  const lines = [
    "# Today",
    "find a plumber for Sunday",
    "Groceries",
    "find a plumber for Saturday",
  ];

  it("keeps the given line while it is still the text", () => {
    expect(findEditedLine(lines, 3, "find a plumber for Saturday")).toBe(3);
    expect(findEditedLine(lines, 1, "find a plumber for Sun")).toBe(1);
  });

  it("prefers the nearest exact text, then the nearest similar line", () => {
    expect(findEditedLine(lines, 2, "find a plumber for Saturday")).toBe(3);
    expect(findEditedLine(lines, 0, "Grocerie")).toBe(2);
    expect(findEditedLine(lines, 0, "Call mom")).toBeNull();
  });
});
