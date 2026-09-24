import { describe, expect, it } from "vitest";
import { minimalChange, normalizeLineEndings, type TextChange } from "./diff";

function applyChange(text: string, change: TextChange | null): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

describe("minimalChange", () => {
  it("returns null for identical documents", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("trims the common prefix and suffix", () => {
    expect(minimalChange("- [ ] book flights", "- [ ] book cheap flights")).toEqual({
      from: 11,
      to: 11,
      insert: "cheap ",
    });
    expect(minimalChange("abc", "aXc")).toEqual({ from: 1, to: 2, insert: "X" });
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
  });

  it("aligns inserted lines to a line start", () => {
    const current = "- [ ] A\n- [ ] B";
    const next = "- [ ] New\n- [ ] A\n- [ ] B";
    expect(minimalChange(current, next)).toEqual({ from: 0, to: 0, insert: "- [ ] New\n" });
  });

  it("aligns deleted lines to a line start", () => {
    const current = "- [ ] X\n- [ ] A";
    expect(minimalChange(current, "- [ ] A")).toEqual({ from: 0, to: 8, insert: "" });
  });

  it("does not split surrogate pairs", () => {
    const change = minimalChange("a😀b", "a😁b");
    expect(change).toEqual({ from: 1, to: 3, insert: "😁" });
  });

  it("always produces the target document", () => {
    const cases: Array<[string, string]> = [
      ["", "x"],
      ["aaaa", "aaaaaa"],
      ["line\nline\n", "line\nline\nline\n"],
      ["a\nb\nc", "a\nc"],
      ["one two", "one\ntwo"],
      ["😀😀", "😀"],
    ];
    for (const [current, next] of cases) {
      expect(applyChange(current, minimalChange(current, next)), `${current} → ${next}`).toBe(next);
    }
  });
});

describe("normalizeLineEndings", () => {
  it("converts CRLF and CR to LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(normalizeLineEndings("plain")).toBe("plain");
  });
});
