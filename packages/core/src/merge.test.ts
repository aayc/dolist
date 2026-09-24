import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { diffLines, mergeText } from "./merge";

const note = (...lines: string[]) => lines.join("\n");

describe("diffLines", () => {
  it("describes insertions, deletions and replacements as hunks over the old lines", () => {
    expect(diffLines(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
    expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([{ start: 1, end: 1, lines: ["b"] }]);
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([{ start: 1, end: 2, lines: [] }]);
    expect(diffLines(["a", "b", "c"], ["a", "B", "c"])).toEqual([
      { start: 1, end: 2, lines: ["B"] },
    ]);
    expect(diffLines([], ["x"])).toEqual([{ start: 0, end: 0, lines: ["x"] }]);
  });

  test.prop([
    fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 30 }),
    fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 30 }),
  ])("applying the hunks to the old lines gives the new ones", (a, b) => {
    const out: string[] = [];
    let at = 0;
    for (const hunk of diffLines(a, b)) {
      expect(hunk.start).toBeGreaterThanOrEqual(at);
      out.push(...a.slice(at, hunk.start), ...hunk.lines);
      at = hunk.end;
    }
    out.push(...a.slice(at));
    expect(out).toEqual(b);
  });
});

describe("mergeText", () => {
  const base = note("# Thursday", "- [ ] Book a table", "- [ ] Renew passport", "Notes");

  it("keeps the agent's lines and the user's typing when they touch different lines", () => {
    const local = note("# Thursday", "- [ ] Book a table for two", "- [ ] Renew passport", "Notes");
    const remote = note(
      "# Thursday",
      "- [ ] Book a table",
      "  - Trattoria Sole has a table at 7pm %%agent:thr_1%%",
      "- [ ] Renew passport",
      "Notes",
    );
    expect(mergeText(base, local, remote)).toEqual({
      text: note(
        "# Thursday",
        "- [ ] Book a table for two",
        "  - Trattoria Sole has a table at 7pm %%agent:thr_1%%",
        "- [ ] Renew passport",
        "Notes",
      ),
      conflict: false,
    });
  });

  it("keeps both when both sides add lines at the same place, the user's first", () => {
    const local = `${base}\n- [ ] Call mom`;
    const remote = `${base}\n- Found 3 flights %%agent%%`;
    expect(mergeText(base, local, remote)).toEqual({
      text: `${base}\n- [ ] Call mom\n- Found 3 flights %%agent%%`,
      conflict: false,
    });
  });

  it("takes identical changes once", () => {
    const both = note("# Thursday", "- [x] Book a table", "- [ ] Renew passport", "Notes");
    expect(mergeText(base, both, both)).toEqual({ text: both, conflict: false });
    // Deleting the first or the last of three identical lines gives the same text, so which copy
    // each side removed can't be told apart: like git, that's one change, not two.
    const copies = note("- [ ] a", "  - note", "  - note", "  - note", "- [ ] a");
    const oneLess = note("- [ ] a", "  - note", "  - note", "- [ ] a");
    expect(mergeText(copies, oneLess, oneLess)).toEqual({ text: oneLess, conflict: false });
  });

  it("reports a conflict when both sides rewrite the same line, keeping the user's", () => {
    const local = note("# Thursday", "- [ ] Book a table for 4", "- [ ] Renew passport", "Notes");
    const remote = note("# Thursday", "- [x] Book a table", "- [ ] Renew passport", "Notes");
    expect(mergeText(base, local, remote)).toEqual({ text: local, conflict: true });
  });

  it("applies a deletion next to an edit", () => {
    const local = note("# Thursday", "- [ ] Book a table", "- [ ] Renew passport", "Notes!");
    const remote = note("# Thursday", "- [ ] Renew passport", "Notes");
    expect(mergeText(base, local, remote)).toEqual({
      text: note("# Thursday", "- [ ] Renew passport", "Notes!"),
      conflict: false,
    });
  });

  const lineArb = fc.constantFrom("- [ ] a", "- [ ] b", "text", "", "## h", "  - note");
  const docArb = fc.array(lineArb, { maxLength: 12 }).map((lines) => lines.join("\n"));

  test.prop([docArb, docArb])("an unchanged side takes the other side's text", (base, other) => {
    expect(mergeText(base, base, other)).toEqual({ text: other, conflict: false });
    expect(mergeText(base, other, base)).toEqual({ text: other, conflict: false });
    expect(mergeText(base, other, other)).toEqual({ text: other, conflict: false });
  });

  test.prop([
    fc.array(lineArb, { minLength: 2, maxLength: 12 }),
    fc.nat(),
    fc.nat(),
    fc.array(lineArb, { maxLength: 3 }),
    fc.array(lineArb, { maxLength: 3 }),
  ])(
    "edits to separate halves of a note merge into both edits",
    (raw, a, b, localNew, remoteNew) => {
      // Numbered, so each side's edit is identifiable: among identical lines it isn't (see above).
      const lines = raw.map((line, k) => `${line} ${k}`);
      // The local side rewrites one line in the first half, the remote side one in the second.
      const half = Math.floor(lines.length / 2);
      const i = a % half;
      const j = half + (b % (lines.length - half));
      fc.pre(j > i + 1);
      const local = [...lines.slice(0, i), ...localNew, ...lines.slice(i + 1)];
      const remote = [...lines.slice(0, j), ...remoteNew, ...lines.slice(j + 1)];
      const expected = [
        ...lines.slice(0, i),
        ...localNew,
        ...lines.slice(i + 1, j),
        ...remoteNew,
        ...lines.slice(j + 1),
      ];
      const merged = mergeText(lines.join("\n"), local.join("\n"), remote.join("\n"));
      expect(merged.conflict).toBe(false);
      expect(merged.text).toBe(expected.join("\n"));
    },
  );
});
