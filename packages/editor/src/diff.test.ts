import { describe, expect, it } from "vitest";
import { documentChanges, minimalChange, normalizeLineEndings, type TextChange } from "./diff";

function applyChange(text: string, change: TextChange | null): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const change of [...changes].reverse()) out = applyChange(out, change);
  return out;
}

describe("documentChanges", () => {
  it("makes one trimmed change per run of changed lines", () => {
    const current = "# Today\n- [ ] Book a table\n- [ ] Call mom\n- [ ] Renew passport";
    const next =
      "# Today\n- [ ] Book a table\n  - Sole, 7pm %%agent%%\n- [ ] Call mom\n- [x] Renew passport";
    expect(documentChanges(current, next)).toEqual([
      { from: 27, to: 27, insert: "  - Sole, 7pm %%agent%%\n" },
      { from: 45, to: 46, insert: "x" },
    ]);
    expect(applyChanges(current, documentChanges(current, next))).toBe(next);
  });

  it("appends and removes lines at the end without touching the last kept line", () => {
    expect(documentChanges("a\nb", "a\nb\nc")).toEqual([{ from: 3, to: 3, insert: "\nc" }]);
    expect(documentChanges("a\nb\nc", "a")).toEqual([{ from: 1, to: 5, insert: "" }]);
    expect(documentChanges("a\nb\nc", "b\nc")).toEqual([{ from: 0, to: 2, insert: "" }]);
    expect(documentChanges("same", "same")).toEqual([]);
  });

  it("always produces the target document", () => {
    const cases: Array<[string, string]> = [
      ["", "x"],
      ["x", ""],
      ["a\n", "a\n\n"],
      ["\n\n", "\n"],
      ["a\nb\nc\nd", "d\nc\nb\na"],
      ["😀\n😁", "😁\n😀"],
    ];
    for (const [current, next] of cases) {
      expect(applyChanges(current, documentChanges(current, next)), `${current} → ${next}`).toBe(
        next,
      );
    }
  });
});

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
