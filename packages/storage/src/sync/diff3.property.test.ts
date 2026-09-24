import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { diffLines, mergeLines, mergeText } from "./diff3";

/** Small alphabets make diffs ambiguous and matches plentiful: the interesting cases. */
const lineArb = fc.constantFrom("a", "b", "c", "- [ ] x", "- [x] x", "", "# h");
const linesArb = fc.array(lineArb, { maxLength: 14 });

type Edit = { at: number; kind: "insert" | "delete" | "replace" };
const editsArb = fc.array(
  fc.record({ at: fc.nat(), kind: fc.constantFrom<Edit["kind"]>("insert", "delete", "replace") }),
  { maxLength: 5 },
);

/** Applies edits whose new lines are unique to `tag`, so every added line is traceable. */
function edit(lines: readonly string[], edits: readonly Edit[], tag: string): string[] {
  const out = [...lines];
  edits.forEach((e, n) => {
    const at = e.at % (out.length + 1);
    if (e.kind === "insert" || at === out.length) out.splice(at, 0, `${tag}+${n}`);
    else if (e.kind === "delete") out.splice(at, 1);
    else out[at] = `${tag}~${n}`;
  });
  return out;
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[a.length]![b.length]!;
}

function addedLines(base: readonly string[], side: readonly string[]): string[] {
  return diffLines(base, side).flatMap((h) => side.slice(h.newStart, h.newStart + h.newLength));
}

describe("diffLines", () => {
  test.prop([linesArb, linesArb])(
    "is a minimal edit script (checked against an LCS oracle)",
    (older, newer) => {
      const hunks = diffLines(older, newer);
      const lcs = lcsLength(older, newer);
      expect(hunks.reduce((n, h) => n + h.oldLength, 0)).toBe(older.length - lcs);
      expect(hunks.reduce((n, h) => n + h.newLength, 0)).toBe(newer.length - lcs);
      // Hunks are ordered, non-empty and non-overlapping.
      let oldEnd = 0;
      let newEnd = 0;
      for (const h of hunks) {
        expect(h.oldLength + h.newLength).toBeGreaterThan(0);
        expect(h.oldStart).toBeGreaterThanOrEqual(oldEnd);
        expect(h.newStart).toBeGreaterThanOrEqual(newEnd);
        expect(h.oldStart - oldEnd).toBe(h.newStart - newEnd);
        oldEnd = h.oldStart + h.oldLength;
        newEnd = h.newStart + h.newLength;
      }
    },
  );

  test.prop([linesArb, linesArb, fc.integer({ min: 0, max: 6 })])(
    "still describes the change exactly when the edit budget runs out",
    (older, newer, budget) => {
      const rebuilt: string[] = [];
      let i = 0;
      for (const h of diffLines(older, newer, { maxEditDistance: budget })) {
        rebuilt.push(
          ...older.slice(i, h.oldStart),
          ...newer.slice(h.newStart, h.newStart + h.newLength),
        );
        i = h.oldStart + h.oldLength;
      }
      rebuilt.push(...older.slice(i));
      expect(rebuilt).toEqual(newer);
    },
  );
});

describe("mergeLines", () => {
  const unions = fc.boolean();

  test.prop([linesArb, editsArb, unions])(
    "takes the only side that changed",
    (base, edits, unionInsertions) => {
      const changed = edit(base, edits, "o");
      expect(mergeLines(base, changed, base, { unionInsertions })).toEqual({
        clean: true,
        lines: changed,
      });
      expect(mergeLines(base, base, changed, { unionInsertions })).toEqual({
        clean: true,
        lines: changed,
      });
      expect(mergeLines(base, changed, changed, { unionInsertions })).toEqual({
        clean: true,
        lines: changed,
      });
    },
  );

  test.prop([linesArb, editsArb, editsArb])(
    "is symmetric without insertion unions",
    (base, oursEdits, theirsEdits) => {
      const ours = edit(base, oursEdits, "o");
      const theirs = edit(base, theirsEdits, "t");
      const ab = mergeLines(base, ours, theirs);
      const ba = mergeLines(base, theirs, ours);
      expect(ab.clean).toBe(ba.clean);
      if (ab.clean && ba.clean) expect(ab.lines).toEqual(ba.lines);
      else
        expect((ab as { conflicts: number }).conflicts).toBe(
          (ba as { conflicts: number }).conflicts,
        );
    },
  );

  test.prop([
    fc.array(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 10 }),
    fc.array(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 10 }),
    editsArb,
    editsArb,
  ])(
    "merges edits separated by an untouched line cleanly and exactly",
    (head, tail, oursEdits, theirsEdits) => {
      const guard = "=== untouched guard ===";
      const base = [...head, guard, ...tail];
      const oursHead = edit(head, oursEdits, "o");
      const theirsTail = edit(tail, theirsEdits, "t");
      const result = mergeLines(
        base,
        [...oursHead, guard, ...tail],
        [...head, guard, ...theirsTail],
      );
      expect(result).toEqual({ clean: true, lines: [...oursHead, guard, ...theirsTail] });
    },
  );

  test.prop([linesArb, editsArb, editsArb, unions])(
    "never loses a line either side added: it is merged or inside the conflict markers",
    (base, oursEdits, theirsEdits, unionInsertions) => {
      const ours = edit(base, oursEdits, "o");
      const theirs = edit(base, theirsEdits, "t");
      const result = mergeLines(base, ours, theirs, { unionInsertions });
      for (const line of [...addedLines(base, ours), ...addedLines(base, theirs)]) {
        expect(result.lines).toContain(line);
      }
      if (!result.clean) {
        expect(result.lines.filter((l) => l === "<<<<<<< ours")).toHaveLength(result.conflicts);
      } else {
        expect(result.lines).not.toContain("<<<<<<< ours");
      }
    },
  );

  test.prop([linesArb, editsArb, editsArb])(
    "insertion unions only ever resolve conflicts, never create them",
    (base, oursEdits, theirsEdits) => {
      const ours = edit(base, oursEdits, "o");
      const theirs = edit(base, theirsEdits, "t");
      const plain = mergeLines(base, ours, theirs);
      const union = mergeLines(base, ours, theirs, { unionInsertions: true });
      if (plain.clean) expect(union).toEqual(plain);
      else if (!union.clean) expect(union.conflicts).toBeLessThanOrEqual(plain.conflicts);
    },
  );
});

describe("mergeText", () => {
  const split = (text: string) => (text === "" ? [] : text.split("\n"));

  test.prop([linesArb, editsArb, editsArb, fc.constantFrom("\n", "\r\n"), fc.boolean()])(
    "is mergeLines over the texts' lines, and keeps their line endings",
    (base, oursEdits, theirsEdits, eol, trailing) => {
      const text = (lines: string[]) => lines.join(eol) + (trailing && lines.length > 0 ? eol : "");
      const [b, o, t] = [base, edit(base, oursEdits, "o"), edit(base, theirsEdits, "t")].map(
        text,
      ) as [string, string, string];
      const merged = mergeText(b, o, t, { unionInsertions: true });
      if (b !== o && b !== t && o !== t) {
        const lines = mergeLines(split(b), split(o), split(t), { unionInsertions: true });
        expect(merged.clean).toBe(lines.clean);
        if (merged.clean)
          expect(merged.text.replace(/\r/g, "")).toBe(lines.lines.join("\n").replace(/\r/g, ""));
      }
      // Documents without any line break carry no line-ending style to keep.
      if (merged.clean && eol === "\r\n" && [b, o, t].some((x) => x.includes(eol))) {
        expect(merged.text.replace(/\r\n/g, "")).not.toContain("\n");
      }
    },
  );

  it("an emptied note merges like a deletion, and additions to an empty note union", () => {
    expect(mergeText("a\na", "a\na\nnew", "", { unionInsertions: true })).toEqual({
      clean: true,
      text: "new",
    });
    expect(mergeText("", "- [ ] mine", "- [ ] theirs", { unionInsertions: true })).toEqual({
      clean: true,
      text: "- [ ] mine\n- [ ] theirs",
    });
  });
});
