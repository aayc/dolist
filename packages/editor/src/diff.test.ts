import { describe, expect, it } from "vitest";
import { documentChanges, type TextChange } from "./diff";

function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const c of [...changes].reverse()) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
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
});
